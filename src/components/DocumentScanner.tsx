"use client";

// CamScanner-style document scanner.
// Lazy-loaded dependency: OpenCV.js (~10MB) for live edge detection,
// perspective correction, and luminance normalisation. We deliberately
// AVOID importing the npm package directly — Turbopack stack-overflows
// trying to parse the multi-megabyte source file. Instead, the package
// is copied to public/vendor/opencv.js at install time (see
// scripts/copy-opencv.mjs) and we inject it via a <script> tag the
// first time the scanner opens. The bundler never sees it.
//
// Stages:
//   loading        — CV + camera initialising
//   capture        — live preview with edge polygon overlay
//   review         — thumbnail grid, retake/delete per page
//   submitting     — uploading to /api/exam/[masterPaperId]/scan-submit
//   error          — terminal failure (camera blocked, server error, etc)
//
// On camera-permission denial we fall back to <input capture> so the
// parent can still pick photos through the native camera app — those
// skip the live edge / dehaze pipeline but go through the same upload.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Stage = "loading" | "capture" | "review" | "submitting" | "error";

type Page = {
  id: string;
  blob: Blob;        // full-resolution cleaned JPEG for upload
  thumbUrl: string;  // small data URL for the review grid
};

// We never narrow the OpenCV type because the package types are
// awkward — keeping it as a loose record is the cleanest path through
// the rendering pipeline without polluting the rest of the codebase.
type CV = Record<string, unknown> & { onRuntimeInitialized?: () => void; Mat?: unknown };

export default function DocumentScanner({
  parentId,
  masterPaperId,
  studentId,
  studentName,
  paperTitle,
  onClose,
}: {
  parentId: string;
  masterPaperId: string;
  studentId: string;
  studentName?: string | null;
  paperTitle?: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("loading");
  const [pages, setPages] = useState<Page[]>([]);
  const [retakeIdx, setRetakeIdx] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [statusMsg, setStatusMsg] = useState<string>("Loading scanner…");
  const [cameraBlocked, setCameraBlocked] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const detectCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cvRef = useRef<CV | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  // Latest detected quad in *video coordinates* (the unscaled native
  // resolution of the stream), TL/TR/BR/BL, or null if no quad yet.
  const lastQuadRef = useRef<[number, number][] | null>(null);
  const fileFallbackRef = useRef<HTMLInputElement | null>(null);

  // ── Body scroll lock while overlay is open ──
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // ── Lazy-load OpenCV + start camera ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setStatusMsg("Loading scanner…");
        const cv = await loadOpenCV();
        if (cancelled) return;
        cvRef.current = cv;

        setStatusMsg("Requesting camera…");
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        }).catch((err) => {
          // Permission denied / no camera
          throw new Error(err?.name === "NotAllowedError" ? "blocked" : "no-camera");
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          // playsinline is set on the JSX below; play() can throw on
          // some browsers if the user hasn't interacted yet — most
          // mobile browsers allow autoplay for muted streams though.
          videoRef.current.play().catch(() => {});
        }
        setStage("capture");
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "init failed";
        if (msg === "blocked") {
          setCameraBlocked(true);
          setStage("error");
          setErrorMsg("Camera access was blocked. Use 'Pick photo from gallery' below to upload pictures instead.");
        } else if (msg === "no-camera") {
          setCameraBlocked(true);
          setStage("error");
          setErrorMsg("No camera found on this device. Use 'Pick photo from gallery' to upload pictures instead.");
        } else {
          setStage("error");
          setErrorMsg(msg);
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Stop the camera stream on unmount ──
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // ── Live edge-detection loop ──
  useEffect(() => {
    if (stage !== "capture") return;
    const cv = cvRef.current;
    if (!cv) return;
    const video = videoRef.current;
    const overlay = overlayRef.current;
    let detect = detectCanvasRef.current;
    if (!detect) {
      detect = document.createElement("canvas");
      detectCanvasRef.current = detect;
    }
    if (!video || !overlay) return;

    let running = true;
    const tick = () => {
      if (!running) return;
      if (video.readyState >= 2 && video.videoWidth > 0) {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        // Downsample to ~480px on the long edge for the detection
        // pass — Canny + findContours on full HD is far too slow on
        // mobile CPUs and we don't need the precision.
        const target = 480;
        const scale = Math.min(target / Math.max(vw, vh), 1);
        const dw = Math.round(vw * scale);
        const dh = Math.round(vh * scale);
        detect!.width = dw;
        detect!.height = dh;
        const ctx = detect!.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(video, 0, 0, dw, dh);
          const quad = detectQuad(cv, ctx, dw, dh);
          if (quad) {
            // Convert back to video-coordinate space.
            const q: [number, number][] = quad.map(
              ([x, y]) => [x / scale, y / scale],
            ) as [number, number][];
            lastQuadRef.current = q;
            drawOverlay(overlay, video, q);
          } else {
            lastQuadRef.current = null;
            clearOverlay(overlay, video);
          }
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      running = false;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [stage]);

  // ── Capture shutter ──
  const handleCapture = useCallback(async () => {
    const cv = cvRef.current;
    const video = videoRef.current;
    if (!cv || !video) return;

    // Snap a still at full video resolution. We then feed THIS frame
    // to the detector again — the live loop ran on a downsampled
    // copy, so the on-screen quad is approximate and won't quite
    // line up with the full-res pixels. Re-detecting at full res
    // gives a tighter crop.
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const stillCanvas = document.createElement("canvas");
    stillCanvas.width = vw;
    stillCanvas.height = vh;
    const sctx = stillCanvas.getContext("2d", { willReadFrequently: true });
    if (!sctx) return;
    sctx.drawImage(video, 0, 0, vw, vh);

    let quad: [number, number][] | null = detectQuad(cv, sctx, vw, vh);
    // If the full-res pass fails, fall back to the last quad seen by
    // the preview loop, then ultimately the full frame as a rectangle.
    if (!quad) quad = lastQuadRef.current;
    if (!quad) quad = [[0, 0], [vw, 0], [vw, vh], [0, vh]];

    try {
      const cleaned = await warpAndClean(cv, sctx, vw, vh, quad);
      const thumbUrl = await makeThumb(cleaned);
      const newPage: Page = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        blob: cleaned,
        thumbUrl,
      };
      setPages((prev) => {
        if (retakeIdx != null && retakeIdx >= 0 && retakeIdx < prev.length) {
          // Replace; revoke the old thumb URL.
          const old = prev[retakeIdx];
          URL.revokeObjectURL(old.thumbUrl);
          const next = prev.slice();
          next[retakeIdx] = newPage;
          return next;
        }
        return [...prev, newPage];
      });
      setRetakeIdx(null);
    } catch (err) {
      console.error("[scanner] capture failed:", err);
      setErrorMsg("Failed to process the page. Try again with steadier framing.");
      // Stay on capture stage; brief inline error is enough.
      setTimeout(() => setErrorMsg(""), 3000);
    }
  }, [retakeIdx]);

  // ── Native-camera fallback (camera blocked / no camera) ──
  const handleFileFallback = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const newPages: Page[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      // Skip CV processing — let the server normalise. Just produce
      // a thumbnail for the review grid.
      const blob = file;
      const thumbUrl = await blobToThumb(blob);
      newPages.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        blob,
        thumbUrl,
      });
    }
    if (newPages.length === 0) return;
    setPages((prev) => [...prev, ...newPages]);
    setCameraBlocked(false);
    setErrorMsg("");
    setStage("review");
  }, []);

  // ── Submit to backend ──
  const handleSubmit = useCallback(async () => {
    if (pages.length === 0) return;
    setStage("submitting");
    setStatusMsg("Sending to marker…");
    try {
      const form = new FormData();
      form.append("studentId", studentId);
      pages.forEach((p, i) => {
        form.append(`page_${i}`, p.blob, `page_${i}.jpg`);
      });
      const res = await fetch(`/api/exam/${masterPaperId}/scan-submit?userId=${parentId}`, {
        method: "POST",
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.cloneId) {
        throw new Error(data?.error ?? `submit failed (${res.status})`);
      }
      // Stop the camera before we navigate so it doesn't keep
      // recording in the background.
      streamRef.current?.getTracks().forEach((t) => t.stop());
      router.push(`/exam/${data.cloneId}/review?userId=${parentId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "submit failed";
      setStage("review");
      setErrorMsg(msg);
    }
  }, [pages, studentId, masterPaperId, parentId, router]);

  // ── Render ──
  const closeAndCleanup = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    pages.forEach((p) => URL.revokeObjectURL(p.thumbUrl));
    onClose();
  }, [onClose, pages]);

  return (
    <div className="fixed inset-0 z-[200] bg-black flex flex-col text-white" style={{ touchAction: "none" }}>
      {/* Top bar */}
      <header className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/70 to-transparent">
        <button
          onClick={() => {
            if (pages.length > 0) {
              if (!confirm("Discard captured pages?")) return;
            }
            closeAndCleanup();
          }}
          className="w-10 h-10 flex items-center justify-center rounded-full bg-black/40 hover:bg-black/60"
          aria-label="Close"
        >
          <span className="material-symbols-outlined">close</span>
        </button>
        <div className="text-center text-sm font-medium leading-tight">
          {paperTitle ? <div className="text-white truncate max-w-[60vw]">{paperTitle}</div> : null}
          {studentName ? <div className="text-white/70 text-xs">for {studentName}</div> : null}
        </div>
        <div className="text-sm font-bold tabular-nums w-10 text-right">
          {pages.length > 0 ? pages.length : ""}
        </div>
      </header>

      {/* Stage views */}
      {stage === "loading" || stage === "submitting" ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <div className="w-12 h-12 border-2 border-white/20 border-t-white rounded-full animate-spin" />
          <p className="text-sm text-white/80">{statusMsg}</p>
        </div>
      ) : null}

      {stage === "capture" ? (
        <>
          <div className="flex-1 relative overflow-hidden">
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="absolute inset-0 w-full h-full object-cover"
            />
            <canvas
              ref={overlayRef}
              className="absolute inset-0 w-full h-full pointer-events-none"
            />
            {retakeIdx != null ? (
              <div className="absolute top-16 left-1/2 -translate-x-1/2 bg-amber-500/90 text-black text-xs font-bold px-3 py-1.5 rounded-full">
                Retaking page {retakeIdx + 1}
              </div>
            ) : null}
            {errorMsg ? (
              <div className="absolute top-16 left-1/2 -translate-x-1/2 bg-red-600/90 text-white text-xs font-bold px-3 py-1.5 rounded-full max-w-[80vw] text-center">
                {errorMsg}
              </div>
            ) : null}
          </div>
          {/* Bottom bar */}
          <div className="absolute bottom-0 left-0 right-0 z-10 flex items-center justify-between px-6 py-6 bg-gradient-to-t from-black/80 to-transparent">
            <button
              onClick={() => setStage("review")}
              disabled={pages.length === 0}
              className="px-4 py-2 rounded-full bg-white/10 text-white text-sm font-bold disabled:opacity-30 hover:bg-white/20"
            >
              {pages.length === 0 ? "No pages" : "Done"}
            </button>
            <button
              onClick={handleCapture}
              className="w-20 h-20 rounded-full bg-white border-4 border-white/40 active:scale-95 transition-transform shadow-2xl"
              aria-label="Capture page"
            />
            <div className="w-[80px]" /> {/* spacer to balance the Done button */}
          </div>
        </>
      ) : null}

      {stage === "review" ? (
        <div className="flex-1 flex flex-col pt-16 pb-24">
          <div className="flex-1 overflow-y-auto px-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {pages.map((p, i) => (
                <div key={p.id} className="relative bg-white rounded-xl overflow-hidden shadow-lg">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={p.thumbUrl} alt={`Page ${i + 1}`} className="w-full h-auto block" />
                  <div className="absolute top-2 left-2 bg-black/70 text-white text-xs font-bold rounded-full w-6 h-6 flex items-center justify-center">
                    {i + 1}
                  </div>
                  <div className="absolute top-2 right-2 flex gap-1">
                    <button
                      onClick={() => { setRetakeIdx(i); setStage("capture"); }}
                      className="w-8 h-8 rounded-full bg-black/70 text-white flex items-center justify-center hover:bg-black/90"
                      title="Retake"
                    >
                      <span className="material-symbols-outlined text-base">refresh</span>
                    </button>
                    <button
                      onClick={() => {
                        setPages((prev) => {
                          URL.revokeObjectURL(p.thumbUrl);
                          return prev.filter((_, idx) => idx !== i);
                        });
                      }}
                      className="w-8 h-8 rounded-full bg-red-600/80 text-white flex items-center justify-center hover:bg-red-600"
                      title="Delete"
                    >
                      <span className="material-symbols-outlined text-base">delete</span>
                    </button>
                  </div>
                </div>
              ))}
              {/* Add another tile */}
              <button
                onClick={() => { setRetakeIdx(null); setStage("capture"); }}
                className="aspect-[3/4] rounded-xl border-2 border-dashed border-white/30 flex flex-col items-center justify-center gap-2 text-white/70 hover:bg-white/5 hover:text-white transition-colors"
              >
                <span className="material-symbols-outlined text-3xl">add_a_photo</span>
                <span className="text-xs font-medium">Add page</span>
              </button>
            </div>
            {errorMsg ? (
              <p className="mt-4 text-center text-sm text-red-400">{errorMsg}</p>
            ) : null}
          </div>
          {/* Bottom bar */}
          <div className="absolute bottom-0 left-0 right-0 z-10 flex items-center justify-between px-4 py-4 bg-gradient-to-t from-black/90 to-transparent">
            <button
              onClick={() => { setRetakeIdx(null); setStage("capture"); }}
              className="px-4 py-3 rounded-full bg-white/10 text-white text-sm font-bold hover:bg-white/20"
            >
              + Add page
            </button>
            <button
              onClick={handleSubmit}
              disabled={pages.length === 0}
              className="px-6 py-3 rounded-full bg-[#006c49] text-white font-bold disabled:opacity-40"
            >
              Finalise &amp; mark ({pages.length})
            </button>
          </div>
        </div>
      ) : null}

      {stage === "error" ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <span className="material-symbols-outlined text-5xl text-white/70">photo_camera_off</span>
          <p className="text-sm text-white/80 max-w-sm">{errorMsg}</p>
          {cameraBlocked ? (
            <>
              <input
                ref={fileFallbackRef}
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                hidden
                onChange={(e) => handleFileFallback(e.target.files)}
              />
              <button
                onClick={() => fileFallbackRef.current?.click()}
                className="px-5 py-3 rounded-full bg-white text-black font-bold"
              >
                Pick photo from gallery
              </button>
            </>
          ) : null}
          <button
            onClick={closeAndCleanup}
            className="text-sm text-white/60 underline mt-2"
          >
            Close
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// CV helpers — kept untyped (`unknown` casts) so we don't have to drag
// OpenCV.js's typings in. Each function is small, self-contained, and
// disposes its Mats in a finally block to avoid the WASM-heap leak
// that's the classic OpenCV.js footgun.
// ─────────────────────────────────────────────────────────────────────

// Inject opencv.js as a <script> tag. Resolves once cv.Mat is
// available. Cached on window so a second scanner open is instant.
function loadOpenCV(): Promise<CV> {
  type W = Window & { cv?: CV; __opencvLoading?: Promise<CV> };
  const w = window as W;
  if (w.cv && (w.cv as CV).Mat) return Promise.resolve(w.cv);
  if (w.__opencvLoading) return w.__opencvLoading;

  const p = new Promise<CV>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OpenCV took too long to load")), 60000);
    const script = document.createElement("script");
    script.src = "/vendor/opencv.js";
    script.async = true;
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error("Failed to load /vendor/opencv.js"));
    };
    script.onload = () => {
      const cv = (window as W).cv;
      if (!cv) {
        clearTimeout(timer);
        reject(new Error("opencv.js loaded but window.cv is missing"));
        return;
      }
      if (cv.Mat) {
        clearTimeout(timer);
        resolve(cv);
        return;
      }
      const existing = cv.onRuntimeInitialized;
      cv.onRuntimeInitialized = () => {
        try { existing?.(); } catch { /* noop */ }
        clearTimeout(timer);
        resolve(cv);
      };
    };
    document.head.appendChild(script);
  });
  w.__opencvLoading = p;
  return p;
}

type CvMat = { delete: () => void };
type CvMatVector = { delete: () => void; get: (i: number) => CvMat; size: () => number; push_back: (m: CvMat) => void };
type CvLib = {
  Mat: new (...args: unknown[]) => CvMat;
  MatVector: new () => CvMatVector;
  Size: new (w: number, h: number) => unknown;
  Point: new (x: number, y: number) => unknown;
  Scalar: new (...vals: number[]) => unknown;
  matFromImageData: (img: ImageData) => CvMat;
  matFromArray: (rows: number, cols: number, type: number, data: number[]) => CvMat;
  imshow: (canvas: HTMLCanvasElement, mat: CvMat) => void;
  cvtColor: (src: CvMat, dst: CvMat, code: number) => void;
  GaussianBlur: (src: CvMat, dst: CvMat, ksize: unknown, sigmaX: number) => void;
  Canny: (src: CvMat, dst: CvMat, low: number, high: number) => void;
  findContours: (src: CvMat, contours: CvMatVector, hier: CvMat, mode: number, method: number) => void;
  contourArea: (c: CvMat) => number;
  arcLength: (c: CvMat, closed: boolean) => number;
  approxPolyDP: (c: CvMat, dst: CvMat, eps: number, closed: boolean) => void;
  isContourConvex: (c: CvMat) => boolean;
  getPerspectiveTransform: (src: CvMat, dst: CvMat) => CvMat;
  warpPerspective: (src: CvMat, dst: CvMat, M: CvMat, size: unknown) => void;
  split: (src: CvMat, mv: CvMatVector) => void;
  merge: (mv: CvMatVector, dst: CvMat) => void;
  CLAHE: new (clip: number, tileGrid: unknown) => { apply: (src: CvMat, dst: CvMat) => void; delete: () => void };
  COLOR_RGBA2GRAY: number;
  COLOR_RGBA2RGB: number;
  COLOR_RGB2Lab: number;
  COLOR_Lab2RGB: number;
  RETR_LIST: number;
  CHAIN_APPROX_SIMPLE: number;
  CV_32FC2: number;
  CV_8UC1: number;
};

function asCv(cv: CV): CvLib {
  return cv as unknown as CvLib;
}

// Find the largest 4-vertex convex contour in a frame and return its
// corners ordered TL, TR, BR, BL. Returns null if no plausible quad
// is found — the caller falls back to a full-frame rectangle.
function detectQuad(cvNs: CV, ctx: CanvasRenderingContext2D, w: number, h: number): [number, number][] | null {
  const cv = asCv(cvNs);
  const imgData = ctx.getImageData(0, 0, w, h);
  let src: CvMat | null = null;
  let gray: CvMat | null = null;
  let blur: CvMat | null = null;
  let edges: CvMat | null = null;
  let contours: CvMatVector | null = null;
  let hier: CvMat | null = null;
  try {
    src = cv.matFromImageData(imgData);
    gray = new cv.Mat();
    blur = new cv.Mat();
    edges = new cv.Mat();
    contours = new cv.MatVector();
    hier = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    cv.Canny(blur, edges, 75, 200);
    cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

    // Score every contour by area; for the top N largest, run
    // approxPolyDP and keep only those with exactly 4 vertices and a
    // convex hull that covers a reasonable fraction of the frame.
    const minArea = w * h * 0.15;
    let best: { quad: [number, number][]; area: number } | null = null;
    const total = contours.size();
    for (let i = 0; i < total; i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area < minArea) { c.delete(); continue; }
      const peri = cv.arcLength(c, true);
      const approx = new cv.Mat();
      cv.approxPolyDP(c, approx, 0.02 * peri, true);
      try {
        // approx is a Nx1 CV_32SC2 Mat; pull the points out as ints.
        const data = (approx as unknown as { data32S: Int32Array }).data32S;
        if (data.length === 8 && cv.isContourConvex(approx)) {
          const pts: [number, number][] = [
            [data[0], data[1]], [data[2], data[3]],
            [data[4], data[5]], [data[6], data[7]],
          ];
          if (!best || area > best.area) best = { quad: orderQuad(pts), area };
        }
      } finally {
        approx.delete();
        c.delete();
      }
    }
    return best?.quad ?? null;
  } finally {
    src?.delete();
    gray?.delete();
    blur?.delete();
    edges?.delete();
    contours?.delete();
    hier?.delete();
  }
}

// Order an arbitrary 4-tuple of points as [TL, TR, BR, BL].
function orderQuad(pts: [number, number][]): [number, number][] {
  // sum (x+y) is smallest at TL, largest at BR.
  // diff (x-y) is largest at TR, smallest at BL.
  const sums = pts.map((p) => p[0] + p[1]);
  const diffs = pts.map((p) => p[0] - p[1]);
  const tl = pts[sums.indexOf(Math.min(...sums))];
  const br = pts[sums.indexOf(Math.max(...sums))];
  const tr = pts[diffs.indexOf(Math.max(...diffs))];
  const bl = pts[diffs.indexOf(Math.min(...diffs))];
  return [tl, tr, br, bl];
}

// Given a detected quad in video-coordinate space, draw a polyline on
// the overlay canvas sized to match the on-screen video element.
function drawOverlay(canvas: HTMLCanvasElement, video: HTMLVideoElement, quad: [number, number][]) {
  const cw = video.clientWidth;
  const ch = video.clientHeight;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (cw === 0 || ch === 0 || vw === 0 || vh === 0) return;

  // Match the displayed video's object-cover scaling so the overlay
  // tracks the visible region.
  const scale = Math.max(cw / vw, ch / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  const ox = (cw - dw) / 2;
  const oy = (ch - dh) / 2;

  // Use device-pixel-ratio so the line is crisp on retina screens.
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.floor(cw * dpr) || canvas.height !== Math.floor(ch * dpr)) {
    canvas.width = Math.floor(cw * dpr);
    canvas.height = Math.floor(ch * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cw, ch);
  ctx.strokeStyle = "rgba(0, 230, 255, 0.95)";
  ctx.fillStyle = "rgba(0, 230, 255, 0.12)";
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (let i = 0; i < quad.length; i++) {
    const [vx, vy] = quad[i];
    const x = ox + vx * scale;
    const y = oy + vy * scale;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function clearOverlay(canvas: HTMLCanvasElement, video: HTMLVideoElement) {
  const cw = video.clientWidth;
  const ch = video.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.floor(cw * dpr) || canvas.height !== Math.floor(ch * dpr)) {
    canvas.width = Math.floor(cw * dpr);
    canvas.height = Math.floor(ch * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// Run perspective-correct + dehaze on a captured still and return a
// JPEG blob.
async function warpAndClean(
  cvNs: CV,
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  quad: [number, number][],
): Promise<Blob> {
  const cv = asCv(cvNs);
  const imgData = ctx.getImageData(0, 0, w, h);
  // Compute target dimensions from the quad's max edges so we don't
  // upscale beyond what the source resolves.
  const dist = (a: [number, number], b: [number, number]) =>
    Math.hypot(a[0] - b[0], a[1] - b[1]);
  const widthA = dist(quad[2], quad[3]);
  const widthB = dist(quad[1], quad[0]);
  const heightA = dist(quad[1], quad[2]);
  const heightB = dist(quad[0], quad[3]);
  const W = Math.max(1, Math.round(Math.max(widthA, widthB)));
  const H = Math.max(1, Math.round(Math.max(heightA, heightB)));

  // Cap the output to 1600px on the long edge to keep the upload
  // reasonable. Server re-encodes to 1600 anyway, so no quality loss.
  const cap = 1600;
  const longEdge = Math.max(W, H);
  const downscale = longEdge > cap ? cap / longEdge : 1;
  const Wd = Math.max(1, Math.round(W * downscale));
  const Hd = Math.max(1, Math.round(H * downscale));

  let src: CvMat | null = null;
  let warped: CvMat | null = null;
  let lab: CvMat | null = null;
  let labChannels: CvMatVector | null = null;
  let M: CvMat | null = null;
  let srcPts: CvMat | null = null;
  let dstPts: CvMat | null = null;
  let clahe: { apply: (src: CvMat, dst: CvMat) => void; delete: () => void } | null = null;
  let rgb: CvMat | null = null;
  try {
    src = cv.matFromImageData(imgData);
    warped = new cv.Mat();
    srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      quad[0][0], quad[0][1],
      quad[1][0], quad[1][1],
      quad[2][0], quad[2][1],
      quad[3][0], quad[3][1],
    ]);
    dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0,
      Wd, 0,
      Wd, Hd,
      0, Hd,
    ]);
    M = cv.getPerspectiveTransform(srcPts, dstPts);
    cv.warpPerspective(src, warped, M, new cv.Size(Wd, Hd));

    // Dehaze: convert RGBA → RGB → LAB, CLAHE the L channel, merge,
    // back to RGB. Preserves AB (colour) so highlighter / coloured
    // ink isn't bleached.
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

    // Push to a canvas and toBlob.
    const out = document.createElement("canvas");
    out.width = Wd;
    out.height = Hd;
    cv.imshow(out, rgb);
    return await new Promise<Blob>((resolve, reject) => {
      out.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
        "image/jpeg",
        0.88,
      );
    });
  } finally {
    src?.delete();
    warped?.delete();
    rgb?.delete();
    lab?.delete();
    labChannels?.delete();
    M?.delete();
    srcPts?.delete();
    dstPts?.delete();
    clahe?.delete();
  }
}

// Generate a small thumbnail data URL for the review grid.
async function makeThumb(blob: Blob, max = 320): Promise<string> {
  const img = await blobToImg(blob);
  const scale = Math.min(max / Math.max(img.width, img.height), 1);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return "";
  ctx.drawImage(img, 0, 0, w, h);
  return c.toDataURL("image/jpeg", 0.7);
}

async function blobToThumb(blob: Blob): Promise<string> {
  return makeThumb(blob, 320);
}

function blobToImg(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}
