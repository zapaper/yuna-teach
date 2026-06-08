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

function detectQuad(cv, imageData, opts) {
  const w = imageData.width;
  const h = imageData.height;
  // Adaptive thresholds passed from the main thread when the live
  // loop hasn't found an edge for a while — see DocumentScanner's
  // detect-preset rotation. Defaults stay at the original
  // moderately-strict settings.
  const cannyLow = (opts && typeof opts.cannyLow === "number") ? opts.cannyLow : 75;
  const cannyHigh = (opts && typeof opts.cannyHigh === "number") ? opts.cannyHigh : 200;
  const minAreaPct = (opts && typeof opts.minAreaPct === "number") ? opts.minAreaPct : 0.15;
  const fillRatioMin = (opts && typeof opts.fillRatioMin === "number") ? opts.fillRatioMin : 0.85;
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
    cv.Canny(blur, edges, cannyLow, cannyHigh);
    cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    // Detection strategy: for every large convex-ish contour, take
    // its minAreaRect (smallest rotated rectangle containing it).
    //
    // Why minAreaRect instead of approxPolyDP+4-vertex check:
    // when a page corner is folded over, the visible outline has
    // 5+ vertices (the fold creates an inward step). approxPolyDP
    // at epsilon=0.02*perimeter collapses those extra vertices
    // into ONE inward-pulled corner → trapezium → perspective
    // warp skews the whole page. minAreaRect ignores that — its
    // corners sit at the contour's extents, which are still
    // defined by the unfolded edges (the corner of the rectangle
    // along, say, the right edge is determined by the bottom-
    // right unfolded corner, not by where the fold cuts in).
    //
    // Fill ratio guards against picking non-rectangular shapes:
    // a real page fills ~95-100% of its bounding rect; a small
    // fold drops fill ratio to ~0.92; an irregular blob is much
    // lower. Threshold 0.85 keeps folded pages, rejects junk.
    const minArea = w * h * minAreaPct;
    let best = null;
    const total = contours.size();
    for (let i = 0; i < total; i++) {
      const c = contours.get(i);
      try {
        const cArea = cv.contourArea(c);
        if (cArea < minArea) continue;
        const rect = cv.minAreaRect(c);
        const rw = rect.size.width;
        const rh = rect.size.height;
        const rectArea = rw * rh;
        if (rectArea <= 0) continue;
        if (cArea / rectArea < fillRatioMin) continue;

        // RotatedRect → 4 corners. cv.minAreaRect's angle field
        // is in DEGREES. opencv.js doesn't reliably expose
        // boxPoints/RotatedRect.points across builds, so compute
        // by hand from center/size/angle.
        const cx = rect.center.x;
        const cy = rect.center.y;
        const ang = rect.angle * Math.PI / 180;
        const cos = Math.cos(ang);
        const sin = Math.sin(ang);
        const halfW = rw / 2;
        const halfH = rh / 2;
        const local = [
          [-halfW, -halfH], [halfW, -halfH],
          [halfW,  halfH], [-halfW,  halfH],
        ];
        const pts = local.map(function (p) {
          return [
            cx + p[0] * cos - p[1] * sin,
            cy + p[0] * sin + p[1] * cos,
          ];
        });
        if (!best || rectArea > best.area) {
          best = { quad: orderQuad(pts), area: rectArea };
        }
      } finally {
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
  let lBlur = null;
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

    // ── Shadow removal — flatten the lighting ──
    // Two-pass illumination flattening:
    //   1. Wide-Gaussian blur of L estimates the illumination
    //      field (low frequencies = shadows / lighting gradients).
    //      Subtract 0.92× of that from L with a bright bias (220)
    //      so paper whites end up actually white instead of grey.
    //   2. CLAHE for local contrast so faint ink survives.
    //   3. Final linear stretch (1.18×, -22) pushes near-white
    //      backgrounds to true white while leaving ink clearly
    //      dark — kills the residual grey tint from soft shadows.
    const sigma = Math.max(15, Math.round(Math.max(Wd, Hd) * 0.05));
    lBlur = new cv.Mat();
    cv.GaussianBlur(L, lBlur, new cv.Size(0, 0), sigma);
    cv.addWeighted(L, 1.0, lBlur, -0.92, 220, L);

    clahe = new cv.CLAHE(2.5, new cv.Size(8, 8));
    clahe.apply(L, L);
    L.convertTo(L, -1, 1.18, -22);
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
    if (lBlur) lBlur.delete();
  }
}

// Variance-of-Laplacian focus score. Higher = sharper. Industry
// rule of thumb: > ~100 is sharp for typical handheld document
// shots; < ~50 is clearly blurry. Computed on the FULL-RES still
// at capture time only (running this every live frame is too much
// CPU on weaker phones).
function focusScore(cv, imageData) {
  let src = null, gray = null, lap = null, mean = null, stddev = null;
  try {
    src = cv.matFromImageData(imageData);
    gray = new cv.Mat();
    lap = new cv.Mat();
    mean = new cv.Mat();
    stddev = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    // CV_32F (not CV_64F) — universally supported across opencv.js
    // builds. 32-bit float is plenty of precision for a variance
    // metric on 8-bit input.
    cv.Laplacian(gray, lap, cv.CV_32F);
    cv.meanStdDev(lap, mean, stddev);
    const s = stddev.data64F[0];
    return s * s;
  } finally {
    if (src) src.delete();
    if (gray) gray.delete();
    if (lap) lap.delete();
    if (mean) mean.delete();
    if (stddev) stddev.delete();
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
      const quad = detectQuad(self.cv, msg.imageData, msg.opts);
      self.postMessage({ id: id, type: "detected", quad: quad });
    } else if (msg.type === "focus") {
      const score = focusScore(self.cv, msg.imageData);
      self.postMessage({ id: id, type: "focusScored", score: score });
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
