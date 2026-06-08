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

// Pull the 4 extreme corner points off a convex hull (or any
// point set). Works whether the hull has 4 vertices or 40. Useful
// when approxPolyDP can't land on exactly 4 vertices because a
// corner is occluded / dog-eared / falls outside the frame.
function extremeCornersFromHull(hull) {
  const buf = hull.data32S;
  if (!buf) return null;
  const n = hull.rows;
  if (n < 4) return null;
  let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;
  let tl = null, tr = null, br = null, bl = null;
  for (let i = 0; i < n; i++) {
    const x = buf[i * 2];
    const y = buf[i * 2 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const sum = x + y;
    const diff = x - y;
    if (sum < minSum) { minSum = sum; tl = [x, y]; }
    if (sum > maxSum) { maxSum = sum; br = [x, y]; }
    if (diff > maxDiff) { maxDiff = diff; tr = [x, y]; }
    if (diff < minDiff) { minDiff = diff; bl = [x, y]; }
  }
  if (!tl || !tr || !br || !bl) return null;
  return [tl, tr, br, bl];
}

// Parallelogram correction — TOP corners only.
// Dog-ears, hand occlusion, and out-of-frame edges happen at the
// TOP of the page because the student/parent holds the paper at
// the bottom. Bottom corners are always reliable; correcting them
// would mask real misdetection (e.g. a bad bottom corner means
// the whole detection is wrong, not just one corner).
// Use the parallelogram identity `tl + br = tr + bl` to predict
// each top corner from the other 3 corners. If exactly ONE top
// corner deviates significantly from prediction (the other top
// agrees well), replace it with the predicted position. This is
// the "mirror the same x-delta" rule applied as a vector identity.
function correctDogEaredCorner(quad) {
  if (!quad || quad.length !== 4) return quad;
  const tl = quad[0], tr = quad[1], br = quad[2], bl = quad[3];
  for (const p of quad) {
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return quad;
  }
  const tlExp = [bl[0] + tr[0] - br[0], bl[1] + tr[1] - br[1]];
  const trExp = [br[0] + tl[0] - bl[0], br[1] + tl[1] - bl[1]];
  const dist = function (a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); };
  const dTl = dist(tl, tlExp);
  const dTr = dist(tr, trExp);
  const diag = Math.hypot(br[0] - tl[0], br[1] - tl[1]);
  if (!Number.isFinite(diag) || diag <= 0) return quad;
  const threshold = diag * 0.12;
  // Only one top corner gets corrected per call. If BOTH top
  // corners deviate, the page is non-parallelogram (extreme angle,
  // or a bottom corner is wrong); leave the quad alone rather than
  // synthesise both.
  if (dTl > threshold && dTr < threshold * 0.6) {
    return [tlExp, tr, br, bl];
  }
  if (dTr > threshold && dTl < threshold * 0.6) {
    return [tl, trExp, br, bl];
  }
  return quad;
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
  let src = null, gray = null, blur = null, edges = null, kernel = null;
  let contours = null, hier = null;
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
    // Morphological closing — bridges small gaps in the Canny
    // outline so a continuous page boundary survives as one
    // contour. Without this, text or low-contrast paper edges
    // segment the outline into pieces and we'd pick a fragment.
    kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
    cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);
    // RETR_EXTERNAL — only the outermost contours. We don't
    // care about inner text contours; they slow down the
    // selection loop and risk being picked over the page.
    cv.findContours(edges, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const minArea = w * h * minAreaPct;
    let bestQuad = null;
    let bestRect = null;
    const total = contours.size();
    // PASS 1: find a true 4-vertex quadrilateral. This is what
    // makes the keystone (perspective) correction actually do
    // work — the 4 vertices are the real page corners in the
    // camera image, and warpPerspective maps them to a rectangle.
    // Convex-hull the contour first to strip interior text /
    // shadow vertices, then approxPolyDP at progressive epsilons.
    // Aspect-ratio sanity rejects hand-in-frame, desk edges, etc.
    //
    // Read the 4 points via approx.data32S — approxPolyDP returns
    // a CV_32SC2 Mat where the flat int32 array is laid out
    // [x0,y0,x1,y1,x2,y2,x3,y3]. The earlier intPtr(j, 0) access
    // returned only the x channel and left y undefined, giving
    // warpPerspective NaN coordinates and producing white pages.
    for (let i = 0; i < total; i++) {
      const c = contours.get(i);
      try {
        const cArea = cv.contourArea(c);
        if (cArea < minArea) continue;
        const hull = new cv.Mat();
        try {
          cv.convexHull(c, hull, false, true);
          const hullArea = cv.contourArea(hull);
          if (hullArea < minArea) continue;
          const perimeter = cv.arcLength(hull, true);
          if (perimeter <= 0) continue;
          for (const epsFactor of [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08]) {
            const approx = new cv.Mat();
            try {
              cv.approxPolyDP(hull, approx, epsFactor * perimeter, true);
              if (approx.rows !== 4) continue;
              if (!cv.isContourConvex(approx)) continue;
              const buf = approx.data32S;
              if (!buf || buf.length < 8) continue;
              const pts = [];
              for (let j = 0; j < 4; j++) {
                const x = buf[j * 2];
                const y = buf[j * 2 + 1];
                if (!Number.isFinite(x) || !Number.isFinite(y)) {
                  pts.length = 0;
                  break;
                }
                pts.push([x, y]);
              }
              if (pts.length !== 4) continue;
              const ordered = orderQuad(pts);
              // Aspect-ratio sanity: A4 is 1.414, letter is 1.294.
              // Mild perspective skew can drop the apparent ratio
              // by ~30 %, so accept 0.55–1.65 either-orientation.
              const eu = function (a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); };
              const top = eu(ordered[0], ordered[1]);
              const bot = eu(ordered[3], ordered[2]);
              const left = eu(ordered[0], ordered[3]);
              const right = eu(ordered[1], ordered[2]);
              const meanW = (top + bot) / 2;
              const meanH = (left + right) / 2;
              if (meanW <= 0 || meanH <= 0) continue;
              const aspect = meanW / meanH;
              if (aspect < 0.55 || aspect > 1.65) continue;
              if (!bestQuad || hullArea > bestQuad.area) {
                bestQuad = { quad: ordered, area: hullArea };
              }
              break;
            } finally {
              approx.delete();
            }
          }
        } finally {
          hull.delete();
        }
      } finally {
        c.delete();
      }
    }
    if (bestQuad) return correctDogEaredCorner(bestQuad.quad);

    // PASS 1.5: no clean 4-vertex contour was found, but a large
    // contour exists with a dog-eared / occluded corner. Take its
    // convex hull's 4 extreme points (tl/tr/br/bl by sum & diff of
    // x,y) and parallelogram-correct the worst-deviating one.
    // Catches the common "bottom 2 corners + one good top + one
    // partially-missing top" framing — the missing corner gets
    // synthesised from the other 3 via the bl + tr − br identity.
    let bestExtreme = null;
    for (let i = 0; i < total; i++) {
      const c = contours.get(i);
      try {
        const cArea = cv.contourArea(c);
        if (cArea < minArea) continue;
        const hull = new cv.Mat();
        try {
          cv.convexHull(c, hull, false, true);
          const hullArea = cv.contourArea(hull);
          if (hullArea < minArea) continue;
          const extremes = extremeCornersFromHull(hull);
          if (!extremes) continue;
          const ordered = orderQuad(extremes);
          const eu = function (a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); };
          const top = eu(ordered[0], ordered[1]);
          const bot = eu(ordered[3], ordered[2]);
          const left = eu(ordered[0], ordered[3]);
          const right = eu(ordered[1], ordered[2]);
          const meanW = (top + bot) / 2;
          const meanH = (left + right) / 2;
          if (meanW <= 0 || meanH <= 0) continue;
          const aspect = meanW / meanH;
          if (aspect < 0.55 || aspect > 1.65) continue;
          if (!bestExtreme || hullArea > bestExtreme.area) {
            bestExtreme = { quad: ordered, area: hullArea };
          }
        } finally {
          hull.delete();
        }
      } finally {
        c.delete();
      }
    }
    if (bestExtreme) return correctDogEaredCorner(bestExtreme.quad);

    // PASS 2: no clean 4-vertex contour. Fall back to
    // minAreaRect — same logic as before for handling folded
    // pages where the outline has > 4 vertices but the rotated
    // bounding rect still tracks the true page edges.
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
        if (!bestRect || rectArea > bestRect.area) {
          bestRect = { quad: orderQuad(pts), area: rectArea };
        }
      } finally {
        c.delete();
      }
    }
    return bestRect ? bestRect.quad : null;
  } finally {
    if (src) src.delete();
    if (gray) gray.delete();
    if (blur) blur.delete();
    if (edges) edges.delete();
    if (kernel) kernel.delete();
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
  // Long-edge cap on the warped output. 1600 was producing 1220x1624
  // saved scans (David's PSLE English) — well below the server's
  // 1800px normaliser target, which meant the resolution bump from
  // the 4K getUserMedia constraint was being clawed back here.
  // 2400 gives ~290 DPI for an A4 page through to the marker.
  const cap = 2400;
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
