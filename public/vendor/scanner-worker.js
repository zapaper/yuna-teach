// Document-scanner CV worker.
//
// Loads opencv.js inside its own Worker scope so the WASM compile
// happens off the main thread. iOS Safari was hanging the whole UI
// during main-thread WebAssembly instantiation; running it in a
// dedicated worker keeps the camera preview + buttons responsive
// even on weaker phones.
//
// Protocol with main thread (window):
//   ← {type:"status", stage:"downloading"|"compiling"}     (during boot)
//   ← {type:"ready"}                                        (cv.Mat is up)
//   ← {type:"error", message}                               (terminal)
//
//   → {id, type:"detect", imageData}                        (live preview)
//   ← {id, type:"detected", quad: [[x,y]x4] | null}
//
//   → {id, type:"warp", imageData, quad}                    (capture)
//   ← {id, type:"warped", imageData}                        (RGBA, transferable)
//
// Main thread is responsible for camera, drawing the overlay polygon,
// and turning the warp result into a JPEG blob via canvas.toBlob.

self.postMessage({ type: "status", stage: "downloading" });
try {
  // importScripts is synchronous inside a worker — it'll block until
  // the file is fetched and executed. The worker has no UI to keep
  // responsive so blocking here is fine. The browser cache holds the
  // file from the first scanner open onwards.
  importScripts("/vendor/opencv.js");
} catch (err) {
  self.postMessage({ type: "error", message: "Failed to load opencv.js: " + (err && err.message ? err.message : String(err)) });
  throw err;
}
self.postMessage({ type: "status", stage: "compiling" });

(function waitForCv() {
  if (self.cv && self.cv.Mat) {
    self.postMessage({ type: "ready" });
    return;
  }
  if (self.cv) {
    const existing = self.cv.onRuntimeInitialized;
    self.cv.onRuntimeInitialized = function () {
      try { if (typeof existing === "function") existing(); } catch (_e) { /* noop */ }
      if (self.cv && self.cv.Mat) self.postMessage({ type: "ready" });
    };
  }
  // Belt-and-braces poll in case the callback gets clobbered.
  const poll = setInterval(function () {
    if (self.cv && self.cv.Mat) {
      clearInterval(poll);
      self.postMessage({ type: "ready" });
    }
  }, 250);
  // Hard cap so a stuck compile surfaces as an error rather than an
  // infinite spinner.
  setTimeout(function () {
    if (!(self.cv && self.cv.Mat)) {
      clearInterval(poll);
      self.postMessage({ type: "error", message: "OpenCV WASM compile timed out — your device may not support this scanner." });
    }
  }, 60_000);
})();

// ── CV ops, lifted from DocumentScanner.tsx so the worker is the
//    single owner of cv.Mat allocations. Each helper deletes its own
//    Mats in a finally block so we don't leak WASM heap. ──

function orderQuad(pts) {
  const sums = pts.map(function (p) { return p[0] + p[1]; });
  const diffs = pts.map(function (p) { return p[0] - p[1]; });
  const tl = pts[sums.indexOf(Math.min.apply(null, sums))];
  const br = pts[sums.indexOf(Math.max.apply(null, sums))];
  const tr = pts[diffs.indexOf(Math.max.apply(null, diffs))];
  const bl = pts[diffs.indexOf(Math.min.apply(null, diffs))];
  return [tl, tr, br, bl];
}

function detectQuad(cv, imageData) {
  const w = imageData.width;
  const h = imageData.height;
  let src = null, gray = null, blur = null, edges = null, contours = null, hier = null;
  try {
    src = cv.matFromImageData(imageData);
    gray = new cv.Mat();
    blur = new cv.Mat();
    edges = new cv.Mat();
    contours = new cv.MatVector();
    hier = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    cv.Canny(blur, edges, 75, 200);
    cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const minArea = w * h * 0.15;
    let best = null;
    const total = contours.size();
    for (let i = 0; i < total; i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area < minArea) { c.delete(); continue; }
      const peri = cv.arcLength(c, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(c, approx, 0.02 * peri, true);
      try {
        const data = approx.data32S;
        if (data.length === 8 && cv.isContourConvex(approx)) {
          const pts = [
            [data[0], data[1]], [data[2], data[3]],
            [data[4], data[5]], [data[6], data[7]],
          ];
          if (!best || area > best.area) best = { quad: orderQuad(pts), area: area };
        }
      } finally {
        approx.delete();
        c.delete();
      }
    }
    return best ? best.quad : null;
  } finally {
    if (src) src.delete();
    if (gray) gray.delete();
    if (blur) blur.delete();
    if (edges) edges.delete();
    if (contours) contours.delete();
    if (hier) hier.delete();
  }
}

function warpAndClean(cv, imageData, quad) {
  const dist = function (a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); };
  const widthA = dist(quad[2], quad[3]);
  const widthB = dist(quad[1], quad[0]);
  const heightA = dist(quad[1], quad[2]);
  const heightB = dist(quad[0], quad[3]);
  const W = Math.max(1, Math.round(Math.max(widthA, widthB)));
  const H = Math.max(1, Math.round(Math.max(heightA, heightB)));
  const cap = 1600;
  const longEdge = Math.max(W, H);
  const downscale = longEdge > cap ? cap / longEdge : 1;
  const Wd = Math.max(1, Math.round(W * downscale));
  const Hd = Math.max(1, Math.round(H * downscale));

  let src = null, warped = null, rgb = null, rgba = null, lab = null, labChannels = null;
  let M = null, srcPts = null, dstPts = null, clahe = null;
  try {
    src = cv.matFromImageData(imageData);
    warped = new cv.Mat();
    srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      quad[0][0], quad[0][1],
      quad[1][0], quad[1][1],
      quad[2][0], quad[2][1],
      quad[3][0], quad[3][1],
    ]);
    dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, Wd, 0, Wd, Hd, 0, Hd]);
    M = cv.getPerspectiveTransform(srcPts, dstPts);
    cv.warpPerspective(src, warped, M, new cv.Size(Wd, Hd));

    rgb = new cv.Mat();
    cv.cvtColor(warped, rgb, cv.COLOR_RGBA2RGB);
    lab = new cv.Mat();
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
    labChannels = new cv.MatVector();
    cv.split(lab, labChannels);
    const L = labChannels.get(0);
    clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
    clahe.apply(L, L);
    cv.merge(labChannels, lab);
    cv.cvtColor(lab, rgb, cv.COLOR_Lab2RGB);

    // Convert RGB → RGBA so the main thread can paint the result
    // directly via putImageData/toBlob without another colour-space
    // hop.
    rgba = new cv.Mat();
    cv.cvtColor(rgb, rgba, cv.COLOR_RGB2RGBA);
    // Clone the bytes off the WASM heap; the underlying view becomes
    // invalid as soon as we `rgba.delete()`.
    const bytes = new Uint8ClampedArray(rgba.data);
    return new ImageData(bytes, rgba.cols, rgba.rows);
  } finally {
    if (src) src.delete();
    if (warped) warped.delete();
    if (rgb) rgb.delete();
    if (rgba) rgba.delete();
    if (lab) lab.delete();
    if (labChannels) labChannels.delete();
    if (M) M.delete();
    if (srcPts) srcPts.delete();
    if (dstPts) dstPts.delete();
    if (clahe) clahe.delete();
  }
}

self.onmessage = function (e) {
  const msg = e.data || {};
  const id = msg.id;
  if (!self.cv || !self.cv.Mat) {
    self.postMessage({ id: id, type: "error", message: "cv not ready" });
    return;
  }
  try {
    if (msg.type === "detect") {
      const quad = detectQuad(self.cv, msg.imageData);
      self.postMessage({ id: id, type: "detected", quad: quad });
    } else if (msg.type === "warp") {
      const out = warpAndClean(self.cv, msg.imageData, msg.quad);
      self.postMessage({ id: id, type: "warped", imageData: out }, [out.data.buffer]);
    } else {
      self.postMessage({ id: id, type: "error", message: "unknown message type: " + msg.type });
    }
  } catch (err) {
    self.postMessage({ id: id, type: "error", message: (err && err.message) ? err.message : String(err) });
  }
};
