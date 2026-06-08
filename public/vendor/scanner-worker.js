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

// Clamp a single point inside image bounds. Used to keep
// parallelogram-predicted corners on-canvas so warpPerspective
// doesn't receive impossible source coordinates.
function clampPoint(p, w, h) {
  return [
    Math.max(0, Math.min(w - 1, p[0])),
    Math.max(0, Math.min(h - 1, p[1])),
  ];
}

// Check whether the vertical edge of the page actually leads up to
// the proposed top corner. Walk a line from the bottom corner to
// the candidate top corner, sampling points along the way. For
// each sample point, check whether there's a high-gradient pixel
// in a small neighbourhood (the Canny edges Mat already encodes
// where page edges are). Returns the hit ratio in [0, 1].
//
// Real top corner: the page's vertical edge tracks the line from
// bottom corner upward, so most samples find a nearby edge pixel.
// Dog-ear / folded corner: the visible edge stops short or veers
// inward; few samples find a nearby edge pixel → low hit ratio.
function verticalEdgeSupport(edgesMat, topPt, bottomPt) {
  if (!edgesMat || !topPt || !bottomPt) return 0;
  const w = edgesMat.cols, h = edgesMat.rows;
  const data = edgesMat.data; // Uint8 flat buffer
  const samples = 12;
  const radius = 6;
  let hits = 0;
  let total = 0;
  // Skip the very ends of the line (the corners themselves) — a
  // corner pixel always lights up in Canny, so we'd get a false
  // positive on the bottom corner side.
  for (let i = 2; i < samples - 2; i++) {
    const t = i / (samples - 1);
    const cx = Math.round(topPt[0] * (1 - t) + bottomPt[0] * t);
    const cy = Math.round(topPt[1] * (1 - t) + bottomPt[1] * t);
    if (cx < 0 || cx >= w || cy < 0 || cy >= h) continue;
    let found = false;
    for (let dy = -radius; dy <= radius && !found; dy++) {
      const yy = cy + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -radius; dx <= radius; dx++) {
        const xx = cx + dx;
        if (xx < 0 || xx >= w) continue;
        if (data[yy * w + xx] > 0) { found = true; break; }
      }
    }
    if (found) hits++;
    total++;
  }
  return total > 0 ? hits / total : 0;
}

// Parallelogram correction — TOP corners only.
// Dog-ears, hand occlusion, and out-of-frame edges happen at the
// TOP of the page because the student/parent holds the paper at
// the bottom. Bottom corners are always reliable; correcting them
// would mask real misdetection (e.g. a bad bottom corner means
// the whole detection is wrong, not just one corner).
//
// Decision logic:
//   1. Use the vertical-edge support check as the PRIMARY signal —
//      if the page edge doesn't lead up to a top corner, it's
//      almost certainly a dog-ear regardless of geometry.
//   2. Fall back to parallelogram deviation as a secondary check
//      when an edges Mat isn't available (e.g. one of the older
//      code paths still calls without it).
// The "fix" is the parallelogram prediction `tl + br = tr + bl`
// rearranged for the dog-eared corner, then clamped on-canvas.
function correctDogEaredCorner(quad, edgesMat, imgW, imgH) {
  if (!quad || quad.length !== 4) return quad;
  for (const p of quad) {
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return quad;
  }
  const tl = quad[0], tr = quad[1], br = quad[2], bl = quad[3];
  const tlExp = [bl[0] + tr[0] - br[0], bl[1] + tr[1] - br[1]];
  const trExp = [br[0] + tl[0] - bl[0], br[1] + tl[1] - bl[1]];
  const w = imgW || (edgesMat && edgesMat.cols) || 1;
  const h = imgH || (edgesMat && edgesMat.rows) || 1;
  // PRIMARY signal: vertical-edge support. Real top corner has the
  // page edge leading up to it from the bottom; dog-ear / fold
  // does not. Threshold 0.4 = at least 40 % of samples on the line
  // from bottom to top corner have a Canny edge pixel within 6 px.
  if (edgesMat) {
    const tlSupport = verticalEdgeSupport(edgesMat, tl, bl);
    const trSupport = verticalEdgeSupport(edgesMat, tr, br);
    const T = 0.4;
    if (tlSupport < T && trSupport >= T) {
      return [clampPoint(tlExp, w, h), tr, br, bl];
    }
    if (trSupport < T && tlSupport >= T) {
      return [tl, clampPoint(trExp, w, h), br, bl];
    }
    // If both top corners pass the edge-support check, trust the
    // detection — no correction needed.
    if (tlSupport >= T && trSupport >= T) return quad;
    // Both failed: fall through to the parallelogram-deviation
    // backup below, which may still correct one of them.
  }
  // BACKUP signal: parallelogram-deviation magnitude. Less
  // reliable than the edge check (when one corner is wrong, BOTH
  // top deviations grow), but better than nothing.
  const dist = function (a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); };
  const dTl = dist(tl, tlExp);
  const dTr = dist(tr, trExp);
  const diag = Math.hypot(br[0] - tl[0], br[1] - tl[1]);
  if (!Number.isFinite(diag) || diag <= 0) return quad;
  const threshold = diag * 0.12;
  if (dTl > threshold && dTr < threshold * 0.6) {
    return [clampPoint(tlExp, w, h), tr, br, bl];
  }
  if (dTr > threshold && dTl < threshold * 0.6) {
    return [tl, clampPoint(trExp, w, h), br, bl];
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
  let src = null, gray = null, blur = null, edges = null;
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
    cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    const minArea = w * h * minAreaPct;
    let bestRect = null;
    const total = contours.size();

    // Original detectQuad — minAreaRect-only. Restored after a
    // session of dog-ear + extreme-corner + parallelogram-correction
    // experiments produced consistent stdL=0 / white-screen outputs.
    // The fancy 4-vertex approxPolyDP + extreme-corners path will
    // come back behind tests once we have a captured set of failing
    // images to reproduce against. For now: rectangular bounding box
    // of the largest convex-ish contour, guaranteed valid coords.
    //
    // Why minAreaRect: when a page corner is folded over, the
    // visible outline has 5+ vertices (the fold creates an inward
    // step). minAreaRect ignores that — its corners sit at the
    // contour's extents, which are still defined by the unfolded
    // edges. Fill ratio guards against picking non-rectangular
    // shapes; threshold 0.85 keeps folded pages, rejects junk.
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
