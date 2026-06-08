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
// We deliberately do NOT offer a "use camera app instead" fallback:
// the marking pipeline is boundary-based, so each page must be
// perspective-corrected and dehazed before upload. Raw phone photos
// without the OpenCV pass would skew the marker.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { playClick } from "@/lib/sfx";

type Stage = "loading" | "capture" | "review" | "submitting" | "error";

type Page = {
  id: string;
  blob: Blob;        // full-resolution cleaned JPEG for upload
  thumbUrl: string;  // small data URL for the review grid
};

// Messages that come back from /vendor/scanner-worker.js. The worker
// owns the OpenCV runtime; we just speak postMessage.
type WorkerMsg =
  | { type: "status"; stage: "downloading" | "compiling" }
  | { type: "ready" }
  | { type: "error"; message: string; id?: string }
  | { id: string; type: "detected"; quad: [number, number][] | null }
  | { id: string; type: "warped"; imageData: ImageData };

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
  const [elapsedSec, setElapsedSec] = useState(0);
  // Whether we currently have a stable detected page edge — drives the
  // shutter-enabled state and the "hold steady" hint.
  const [edgeLocked, setEdgeLocked] = useState(false);
  // How many seconds since detection last succeeded. Drives the
  // progressive hint text — after ~20s of nothing we suggest the
  // user angle the phone, since top-down shots often miss edges
  // due to glare + phone-shadow on the paper.
  const [noEdgeSec, setNoEdgeSec] = useState(0);
  // Animation state: thumb-flying-to-corner after a successful capture.
  const [flyThumb, setFlyThumb] = useState<{ id: string; thumbUrl: string } | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const detectCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const detectInflightRef = useRef(false);
  // Wall-clock ms when the most recent live-detect message was posted.
  // Used by the rAF tick to recover if a detect call gets dropped /
  // errors silently and the inflight flag would otherwise stay stuck
  // true forever ("after a while I can't find edges anymore" bug).
  const detectSentAtRef = useRef<number>(0);
  // Latest detected quad in *video coordinates* (the unscaled native
  // resolution of the stream), TL/TR/BR/BL, or null if no quad yet.
  const lastQuadRef = useRef<[number, number][] | null>(null);
  // Wall-clock ms when lastQuadRef was set. Lets the live loop keep
  // showing the previous quad for ~600ms after a single missed
  // detection so the overlay doesn't flicker on and off frame-to-frame.
  const lastQuadAtRef = useRef<number>(0);
  // Outstanding worker requests keyed by id, used by the warp path to
  // await a single-shot response. The live detect loop short-circuits
  // via detectInflightRef and doesn't go through this map.
  const pendingRef = useRef<Map<string, { resolve: (msg: WorkerMsg) => void; reject: (err: Error) => void }>>(new Map());

  // ── Loading-stage elapsed-time counter ──
  useEffect(() => {
    if (stage !== "loading") return;
    const start = Date.now();
    const interval = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [stage]);

  // ── Body scroll lock while overlay is open ──
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);

  // ── Spin up the CV worker, then start the camera ──
  useEffect(() => {
    let cancelled = false;

    setStatusMsg("Loading scanner…");
    let worker: Worker;
    try {
      // Cache-bust the worker URL so a deploy that ships new
      // detection / warp code doesn't get served from the browser's
      // stale copy. Bump SCANNER_WORKER_VERSION whenever the worker
      // file changes; the query string forces a fresh fetch
      // regardless of the browser's existing Cache-Control entry.
      worker = new Worker("/vendor/scanner-worker.js?v=2025-12-08-d");
    } catch (err) {
      setStage("error");
      setErrorMsg("Failed to start scanner worker: " + (err instanceof Error ? err.message : String(err)));
      return;
    }
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<WorkerMsg>) => {
      if (cancelled) return;
      const msg = e.data;
      if (msg.type === "status") {
        if (msg.stage === "downloading") {
          setStatusMsg("Downloading scanner (≈10 MB)…\nFirst time only — future scans start instantly.");
        } else if (msg.stage === "compiling") {
          setStatusMsg("Initialising scanner…");
        }
        return;
      }
      if (msg.type === "ready") {
        // Worker is ready — kick off the camera now.
        startCamera();
        return;
      }
      if (msg.type === "error") {
        const id = msg.id;
        // A live-detect error is transient — log and let the next
        // tick try again, do NOT tear the scanner down. Without this
        // any single hiccup would set stage='error' AND leave the
        // inflight flag stuck (because the response never matched
        // our 'detected' branch), which is what made the overlay
        // permanently lose the page after a while.
        if (id === "live") {
          console.warn("[scanner] live detect error:", msg.message);
          detectInflightRef.current = false;
          return;
        }
        if (id && pendingRef.current.has(id)) {
          pendingRef.current.get(id)?.reject(new Error(msg.message));
          pendingRef.current.delete(id);
          return;
        }
        // Boot-time / global error — surface to UI.
        setStage("error");
        setErrorMsg(msg.message || "Scanner failed to initialise.");
        return;
      }
      if (msg.type === "detected" && msg.id === "live") {
        detectInflightRef.current = false;
        // The live detect runs on a 480px-downsampled frame; rescale
        // the quad back to native video coordinates before drawing.
        const overlay = overlayRef.current;
        const video = videoRef.current;
        if (!overlay || !video) return;
        if (msg.quad) {
          const ds = liveScaleRef.current;
          if (ds > 0) {
            const q: [number, number][] = msg.quad.map(
              ([x, y]) => [x / ds, y / ds],
            ) as [number, number][];
            lastQuadRef.current = q;
            lastQuadAtRef.current = performance.now();
            // Detection succeeded — reset the adaptive preset clock
            // and rewind to the strictest preset. Subsequent frames
            // pick that up immediately.
            lastDetectSuccessAtRef.current = performance.now();
            if (detectPresetIdxRef.current !== 0) {
              console.log(`[scanner] edge found — resetting preset to 0`);
              detectPresetIdxRef.current = 0;
            }
            setEdgeLocked(true);
            drawOverlay(overlay, video, q);
          }
        } else {
          // Anti-flicker: keep showing the last quad for up to
          // ~600ms after the first miss so the polygon doesn't
          // strobe between frames when the detector momentarily
          // loses the page.
          const age = performance.now() - lastQuadAtRef.current;
          if (lastQuadRef.current && age < 600) {
            drawOverlay(overlay, video, lastQuadRef.current);
          } else {
            lastQuadRef.current = null;
            setEdgeLocked(false);
            clearOverlay(overlay, video);
          }
        }
        return;
      }
      if (msg.type === "detected" || msg.type === "warped") {
        const pending = pendingRef.current.get(msg.id);
        if (pending) {
          pending.resolve(msg);
          pendingRef.current.delete(msg.id);
        }
      }
    };

    worker.onerror = (e) => {
      if (cancelled) return;
      setStage("error");
      setErrorMsg("Scanner worker crashed: " + (e.message || "unknown"));
    };

    async function startCamera() {
      try {
        setStatusMsg("Requesting camera…");
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: "environment" },
            // 1920x1080 (HD video) was the bottleneck — after OpenCV
            // perspective-corrected and cropped to the page boundary,
            // saved scans landed at ~665px wide (David's PSLE English
            // paper), well below the server's 1800px target and too
            // coarse for tightly-packed Comp Cloze handwriting. 4K
            // (3840x2160) is what modern phone rear cameras shoot
            // stills at; `ideal:` is a soft constraint so phones that
            // can't hit it fall back to their highest supported mode
            // instead of failing the gUM call.
            width: { ideal: 3840 },
            height: { ideal: 2160 },
          },
          audio: false,
        }).catch((err: { name?: string }) => {
          throw new Error(err?.name === "NotAllowedError" ? "blocked" : "no-camera");
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
        setStage("capture");
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "init failed";
        if (msg === "blocked") {
          setStage("error");
          setErrorMsg("Camera access was blocked. Allow camera in your browser settings and reopen the scanner.");
        } else if (msg === "no-camera") {
          setStage("error");
          setErrorMsg("No camera found on this device. Open the scanner on a phone or tablet with a rear camera.");
        } else {
          setStage("error");
          setErrorMsg(msg);
        }
      }
    }

    return () => {
      cancelled = true;
      // Reject any in-flight worker promises so awaiting code
      // doesn't hang after unmount.
      pendingRef.current.forEach((p) => p.reject(new Error("scanner closed")));
      pendingRef.current.clear();
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  // ── Stop the camera stream on unmount ──
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // ── Re-attach the live stream when the <video> element remounts ──
  // The review stage unmounts the capture stage's <video> (conditional
  // render), so on retake the new <video> has no srcObject and shows
  // black. The stream itself is still alive in streamRef. Re-attach
  // every time stage becomes "capture".
  useEffect(() => {
    if (stage !== "capture") return;
    const v = videoRef.current;
    const s = streamRef.current;
    if (!v || !s) return;
    if (v.srcObject !== s) {
      v.srcObject = s;
      v.play().catch(() => { /* user-gesture restriction is unlikely here */ });
    }
  }, [stage]);

  // Scale used when downsampling for the live detect pass — kept in a
  // ref so the worker-response handler can rescale the quad back to
  // video-native coords without re-deriving from the video element.
  const liveScaleRef = useRef(1);
  // Adaptive edge-detection presets. The default (index 0) is the
  // strict setting tuned for typical document-on-table scans. If
  // the live loop hasn't found an edge for ~5s we step to a more
  // permissive set (lower Canny thresholds, smaller minArea, more
  // lenient fill ratio). Resets back to 0 the moment a quad lands.
  // This covers: dim lighting, dark paper, small page in frame,
  // low-contrast scenes where the original 75/200 Canny thresholds
  // would silently never trigger.
  const detectPresets = [
    { cannyLow: 75, cannyHigh: 200, minAreaPct: 0.15, fillRatioMin: 0.85 },
    { cannyLow: 50, cannyHigh: 150, minAreaPct: 0.10, fillRatioMin: 0.80 },
    { cannyLow: 30, cannyHigh: 100, minAreaPct: 0.07, fillRatioMin: 0.75 },
    { cannyLow: 20, cannyHigh: 80, minAreaPct: 0.05, fillRatioMin: 0.70 },
  ];
  const detectPresetIdxRef = useRef(0);
  const lastDetectSuccessAtRef = useRef<number>(performance.now());
  const PRESET_BUMP_MS = 5000;

  // No-edge streak counter — ticks every 500ms while in capture
  // stage. Drives the progressive hint text underneath the
  // viewport: after ~20s with no detection we tell the user to
  // try angling the phone.
  useEffect(() => {
    if (stage !== "capture") return;
    setNoEdgeSec(0);
    const interval = setInterval(() => {
      const secs = Math.floor((performance.now() - lastDetectSuccessAtRef.current) / 1000);
      setNoEdgeSec(secs);
    }, 500);
    return () => clearInterval(interval);
  }, [stage]);

  // ── Live edge-detection loop. Each tick posts the current frame
  //    to the worker (single-flight via detectInflightRef) and waits
  //    for the response to update the overlay. The rAF cadence is
  //    driven by the browser; the worker is naturally rate-limited
  //    by its own throughput.
  useEffect(() => {
    if (stage !== "capture") return;
    const worker = workerRef.current;
    if (!worker) return;
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
      // Watchdog: if the last detect was sent more than 1.5s ago and
      // the inflight flag is still true, assume the response was lost
      // (worker error swallowed, message dropped, etc) and force a
      // reset so the loop doesn't stall.
      if (
        detectInflightRef.current &&
        detectSentAtRef.current > 0 &&
        performance.now() - detectSentAtRef.current > 1500
      ) {
        console.warn("[scanner] detect inflight watchdog reset");
        detectInflightRef.current = false;
      }
      if (
        !detectInflightRef.current &&
        video.readyState >= 2 &&
        video.videoWidth > 0
      ) {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        const target = 480;
        const scale = Math.min(target / Math.max(vw, vh), 1);
        const dw = Math.round(vw * scale);
        const dh = Math.round(vh * scale);
        detect!.width = dw;
        detect!.height = dh;
        const ctx = detect!.getContext("2d", { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(video, 0, 0, dw, dh);
          const imgData = ctx.getImageData(0, 0, dw, dh);
          liveScaleRef.current = scale;
          // Bump the preset every PRESET_BUMP_MS of no successful
          // detection. Cycles 0 → 1 → 2 → 3 → 0, so even a stuck
          // permissive preset eventually retries the strict one
          // (avoids drifting forever into false positives on
          // background noise).
          const sinceSuccess = performance.now() - lastDetectSuccessAtRef.current;
          const wantIdx = Math.min(
            detectPresets.length - 1,
            Math.floor(sinceSuccess / PRESET_BUMP_MS),
          );
          if (sinceSuccess > PRESET_BUMP_MS * detectPresets.length) {
            // Wraparound — give the strict preset another shot.
            detectPresetIdxRef.current = 0;
            lastDetectSuccessAtRef.current = performance.now();
          } else if (wantIdx !== detectPresetIdxRef.current) {
            detectPresetIdxRef.current = wantIdx;
            console.log(`[scanner] no edge for ${(sinceSuccess / 1000).toFixed(1)}s → stepping to preset ${wantIdx}`);
          }

          detectInflightRef.current = true;
          detectSentAtRef.current = performance.now();
          worker.postMessage(
            {
              id: "live",
              type: "detect",
              imageData: imgData,
              opts: detectPresets[detectPresetIdxRef.current],
            },
            [imgData.data.buffer],
          );
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
    const worker = workerRef.current;
    const video = videoRef.current;
    if (!worker || !video) return;
    // Edge must be locked — the button is disabled in this state but
    // a stale tap could still race; bail defensively.
    if (!lastQuadRef.current) return;

    // Audible feedback the moment the user taps, before any worker
    // round-trip — the camera shutter cue is meant to be tight.
    playClick(0.5);

    const vw = video.videoWidth;
    const vh = video.videoHeight;

    // Camera readiness check — after a retake, videoWidth can be 0
    // for the first ~100ms while the WKWebView re-binds the
    // MediaStream. Surfacing a specific "not ready" message is
    // friendlier than letting the downstream CV calls explode and
    // emitting the generic "Failed to process the page".
    if (vw === 0 || vh === 0) {
      setErrorMsg("Camera still warming up — try again in a moment.");
      setTimeout(() => setErrorMsg(""), 2500);
      return;
    }

    // Downsample the still BEFORE the worker round-trip. A 4K video
    // frame is 8.3 MP — getImageData serialises ~33 MB and the
    // worker's Canny + warpPerspective + CLAHE all scale linearly
    // with pixel count. Capping the capture canvas at 2400 px max
    // edge cuts everything downstream by ~4× without hurting marker
    // OCR (2400 wide on A4 = ~290 DPI, well above what Gemini needs
    // for clean handwriting). The live-loop quad from a 480-px
    // detect canvas scales up directly into this space.
    const CAPTURE_MAX_EDGE = 2400;
    const captureScale = Math.min(1, CAPTURE_MAX_EDGE / Math.max(vw, vh));
    const cw = Math.round(vw * captureScale);
    const ch = Math.round(vh * captureScale);
    const stillCanvas = document.createElement("canvas");
    stillCanvas.width = cw;
    stillCanvas.height = ch;
    const sctx = stillCanvas.getContext("2d", { willReadFrequently: true });
    if (!sctx) return;
    sctx.drawImage(video, 0, 0, cw, ch);

    try {
      // Use the live loop's most recent quad — it's plenty accurate
      // for a steady-hold capture and skipping the full-res
      // re-detect step removes a whole worker round-trip + an
      // 8 MP Canny+findContours pass (~1.5 s). The quad coords are
      // in detect-canvas space (480 px max edge); rescale them to
      // the capture canvas before sending to the warp worker.
      const detectMaxEdge = 480;
      const detectScale = Math.min(1, detectMaxEdge / Math.max(vw, vh));
      const quadScale = captureScale / detectScale;
      const liveQuad = lastQuadRef.current;
      const quad: [number, number][] = liveQuad
        ? liveQuad.map(([x, y]) => [x * quadScale, y * quadScale] as [number, number])
        : [[0, 0], [cw, 0], [cw, ch], [0, ch]];

      // Warp + dehaze via worker. Buffer is transferred — sctx is
      // disposable after this call.
      const warpImg = sctx.getImageData(0, 0, cw, ch);
      const warpId = `warp-${Date.now()}`;
      const warpMsg = await new Promise<WorkerMsg>((resolve, reject) => {
        pendingRef.current.set(warpId, { resolve, reject });
        worker.postMessage(
          { id: warpId, type: "warp", imageData: warpImg, quad },
          [warpImg.data.buffer],
        );
      });
      if (warpMsg.type !== "warped") throw new Error("warp returned unexpected message");

      // Paint the cleaned ImageData back to a canvas → JPEG blob.
      const out = document.createElement("canvas");
      out.width = warpMsg.imageData.width;
      out.height = warpMsg.imageData.height;
      const outCtx = out.getContext("2d");
      if (!outCtx) throw new Error("toBlob context missing");
      outCtx.putImageData(warpMsg.imageData, 0, 0);
      const cleaned = await new Promise<Blob>((resolve, reject) => {
        out.toBlob(
          (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
          "image/jpeg",
          0.88,
        );
      });
      const thumbUrl = await makeThumb(cleaned);
      const newPage: Page = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        blob: cleaned,
        thumbUrl,
      };
      setPages((prev) => {
        if (retakeIdx != null && retakeIdx >= 0 && retakeIdx < prev.length) {
          const old = prev[retakeIdx];
          URL.revokeObjectURL(old.thumbUrl);
          const next = prev.slice();
          next[retakeIdx] = newPage;
          return next;
        }
        return [...prev, newPage];
      });
      setRetakeIdx(null);
      // "Captured!" feedback — the thumb pops in centred, animates to
      // the top-right page-count badge over ~700ms, then unmounts.
      setFlyThumb({ id: newPage.id, thumbUrl });
      setTimeout(() => {
        setFlyThumb((cur) => (cur && cur.id === newPage.id ? null : cur));
      }, 750);
    } catch (err) {
      console.error("[scanner] capture failed:", err);
      // Surface the underlying message in the toast so the user (and
      // we, when they screenshot it) can see what actually failed,
      // not just the generic "Failed to process". Cap length so a
      // huge stack doesn't blow out the toast UI.
      const msg = (err instanceof Error ? err.message : String(err)).slice(0, 140);
      setErrorMsg(`Could not process this page: ${msg}`);
      setTimeout(() => setErrorMsg(""), 5000);
    }
  }, [retakeIdx]);

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
      // Stop the camera, close the scanner overlay, and refresh the
      // dashboard so the new clone shows up in the assigned-papers
      // list with its 'Marking…' indicator. The parent stays on
      // their home page rather than being yanked to a half-marked
      // review screen.
      streamRef.current?.getTracks().forEach((t) => t.stop());
      pages.forEach((p) => URL.revokeObjectURL(p.thumbUrl));
      onClose();
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "submit failed";
      setStage("review");
      setErrorMsg(msg);
    }
  }, [pages, studentId, masterPaperId, parentId, router, onClose]);

  // ── Render ──
  const closeAndCleanup = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    pages.forEach((p) => URL.revokeObjectURL(p.thumbUrl));
    onClose();
  }, [onClose, pages]);

  return (
    <div className="fixed inset-0 z-[200] bg-black flex flex-col text-white">
      {/* Inline keyframes for the captured-thumb fly animation. Plain
          <style> tag rather than styled-jsx so we don't pull in any
          extra plugin — the name is unique enough not to collide. */}
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes scannerThumbFly {
          0%   { top: 50%; right: 50%; transform: translate(50%, -50%) scale(1.6); width: 140px; height: 140px; opacity: 0; }
          15%  { top: 50%; right: 50%; transform: translate(50%, -50%) scale(1.6); width: 140px; height: 140px; opacity: 1; }
          75%  { top: 12px; right: 12px; transform: translate(0, 0) scale(1); width: 56px; height: 56px; opacity: 1; }
          100% { top: 12px; right: 12px; transform: translate(0, 0) scale(1); width: 56px; height: 56px; opacity: 0; }
        }
      `}} />
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
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <div className="w-12 h-12 border-2 border-white/20 border-t-white rounded-full animate-spin" />
          <p className="text-sm text-white/80 whitespace-pre-line max-w-sm">{statusMsg}</p>
          {stage === "loading" && elapsedSec >= 1 && (
            <p className="text-xs text-white/40 tabular-nums">{elapsedSec}s elapsed</p>
          )}
        </div>
      ) : null}

      {stage === "capture" ? (
        <>
          <div className="flex-1 relative overflow-hidden" style={{ touchAction: "none" }}>
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
            {!edgeLocked && !errorMsg && retakeIdx == null ? (
              <div className="absolute bottom-32 left-1/2 -translate-x-1/2 bg-black/70 text-white text-xs font-medium px-3 py-1.5 rounded-full max-w-[80vw] text-center pointer-events-none">
                {noEdgeSec >= 20
                  ? "Tilt the camera slightly — we can't see the page edges yet"
                  : "Hold steady so we can find the page edges"}
              </div>
            ) : null}
            {/* Captured-thumb fly-to-corner animation. Renders for
                ~500ms then unmounts. The element itself is what's
                animated via Tailwind's transform utilities. */}
            {flyThumb ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={flyThumb.id}
                src={flyThumb.thumbUrl}
                alt=""
                className="absolute pointer-events-none rounded-lg shadow-xl border-2 border-white"
                style={{
                  top: 0,
                  right: 0,
                  width: 56,
                  height: 56,
                  objectFit: "cover",
                  animation: "scannerThumbFly 700ms cubic-bezier(0.22, 1, 0.36, 1) forwards",
                }}
              />
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
              disabled={!edgeLocked}
              className={`w-20 h-20 rounded-full border-4 active:scale-95 transition-all shadow-2xl ${
                edgeLocked ? "bg-white border-white/40" : "bg-white/40 border-white/20 cursor-not-allowed"
              }`}
              aria-label="Capture page"
            />
            <div className="w-[80px]" /> {/* spacer to balance the Done button */}
          </div>
        </>
      ) : null}

      {stage === "review" ? (
        <>
          {/* Absolute positioning instead of flex+min-h-0 — iOS Safari
              refuses to scroll an overflow-y:auto child of a fixed
              flex container, but `absolute top-16 bottom-24` gives the
              scroller an explicit, computable height that scrolls
              reliably on every browser. -webkit-overflow-scrolling
              keeps the inertia smooth on older iOS. */}
          <div
            className="absolute top-16 bottom-24 left-0 right-0 overflow-y-auto overscroll-contain px-4 pb-4"
            style={{ WebkitOverflowScrolling: "touch" } as React.CSSProperties}
          >
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
        </>
      ) : null}

      {stage === "error" ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
          <span className="material-symbols-outlined text-5xl text-white/70">photo_camera_off</span>
          <p className="text-sm text-white/80 max-w-sm">{errorMsg}</p>
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
// Overlay drawing + thumbnail helpers. The CV ops live in
// /vendor/scanner-worker.js so they run off the main thread.
// ─────────────────────────────────────────────────────────────────────

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

function blobToImg(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}
