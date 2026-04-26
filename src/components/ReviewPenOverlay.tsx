"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Red-pen overlay used on the quiz review page so the parent can mark
// the English passage or the OEQ student-written canvas. The overlay is
// keyed by a stable string ('passage:<idx>' or 'question:<id>') and
// persists to ExamPaper.reviewAnnotations via PATCH /api/exam/<paperId>.
//
// The canvas sizes itself to the parent's scrollHeight × scrollWidth so
// that strokes anchor to the underlying content — when the parent
// scrolls inside the passage box, the ink scrolls with the text instead
// of staying fixed at the screen position.
//
// Pen / Clear toggles render on a small floating toolbar above the
// overlay. While Pen is OFF the canvas is pointer-events:none so taps
// pass through to the text underneath (lets parents select / scroll).
export function ReviewPenOverlay({
  paperId,
  storageKey,
  initialDataUrl,
}: {
  paperId: string;
  storageKey: string;
  initialDataUrl?: string | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawing = useRef(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  // Track previous midpoint for quadratic-curve smoothing. Between three
  // consecutive samples a, b, c we draw quadraticCurveTo(b, mid(b,c))
  // starting from mid(a,b). Turns the per-segment 60 Hz straight facets
  // into smooth curves — what finger input on iOS Safari especially
  // needs since touch sampling is sparse and raw lineTo looks jagged.
  const lastMid = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const dirty = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [active, setActive] = useState(false);

  function getPosXY(clientX: number, clientY: number) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * (canvas.width / rect.width),
      y: (clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  // Push the current canvas as a PNG data URL up to the API. Debounced
  // so a multi-stroke session ends with a single PATCH instead of one
  // per pen-up.
  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dataUrl = isCanvasBlank(canvas) ? null : canvas.toDataURL("image/png");
      try {
        await fetch(`/api/exam/${paperId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reviewAnnotations: { [storageKey]: dataUrl } }),
        });
      } catch {
        // Best-effort save; parents can re-trigger by drawing more.
      }
      dirty.current = false;
    }, 1500);
  }, [paperId, storageKey]);

  function applyStyle(ctx: CanvasRenderingContext2D) {
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = "rgba(220, 38, 38, 0.95)";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }

  function onDown(e: React.PointerEvent) {
    if (!active || e.button !== 0) return;
    e.preventDefault();
    isDrawing.current = true;
    const pos = getPosXY(e.clientX, e.clientY);
    lastPos.current = pos;
    lastMid.current = { x: pos.x, y: pos.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    // Drop a small dot on tap so a single quick tap leaves a mark
    // instead of nothing (no movement = no segment otherwise).
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx) {
      applyStyle(ctx);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    dirty.current = true;
  }

  function onMove(e: React.PointerEvent) {
    if (!isDrawing.current || !lastPos.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    e.preventDefault();
    // getCoalescedEvents returns every pointer sample the OS buffered
    // since the previous pointermove — on iOS Safari especially,
    // raw 60 Hz pointermove throws away intermediate samples and fast
    // strokes look jagged.
    const native = e.nativeEvent as PointerEvent;
    const samples = typeof native.getCoalescedEvents === "function"
      ? native.getCoalescedEvents()
      : [native];
    applyStyle(ctx);
    for (const s of samples) {
      const cur = getPosXY(s.clientX, s.clientY);
      const prev = lastPos.current!;
      const mid = { x: (prev.x + cur.x) / 2, y: (prev.y + cur.y) / 2 };
      ctx.beginPath();
      ctx.moveTo(lastMid.current.x, lastMid.current.y);
      ctx.quadraticCurveTo(prev.x, prev.y, mid.x, mid.y);
      ctx.stroke();
      lastMid.current = mid;
      lastPos.current = cur;
    }
    dirty.current = true;
  }

  function onUp() {
    if (!isDrawing.current) return;
    isDrawing.current = false;
    lastPos.current = null;
    if (dirty.current) scheduleSave();
  }

  function clearAll() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
    dirty.current = true;
    scheduleSave();
  }

  // Resize canvas to parent's scroll dimensions and re-paint any saved
  // strokes. Re-runs when the parent's content changes (e.g. font load).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    function fitAndPaint() {
      const c = canvasRef.current;
      const p = c?.parentElement;
      if (!c || !p) return;
      const w = p.scrollWidth;
      const h = p.scrollHeight;
      if (w === 0 || h === 0) return;
      // Capture existing pixels so a resize doesn't wipe the user's work.
      const ctx = c.getContext("2d");
      let snapshot: ImageData | null = null;
      if (c.width > 0 && c.height > 0 && ctx) {
        try { snapshot = ctx.getImageData(0, 0, c.width, c.height); } catch { /* tainted */ }
      }
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
      // Use the device DPR (capped at 3) so retina iPhones get crisp ink
      // without a 4x texture blowing up memory.
      const dpr = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 3);
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
      const newCtx = c.getContext("2d");
      if (snapshot && newCtx) {
        try { newCtx.putImageData(snapshot, 0, 0); } catch { /* dimension change clears */ }
      }
    }

    fitAndPaint();
    // Initial paint of saved annotation. Done after fitAndPaint so the
    // canvas has the right dimensions to draw the image at full size.
    if (initialDataUrl) {
      const img = new Image();
      img.onload = () => {
        const ctx = canvas.getContext("2d");
        ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);
      };
      img.src = initialDataUrl;
    }

    const obs = new ResizeObserver(fitAndPaint);
    obs.observe(parent);
    return () => obs.disconnect();
    // initialDataUrl intentionally omitted from deps — it's the seed,
    // not a live source of truth (we own the canvas after first paint).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {/* Toolbar: floats top-right of the parent. The parent must be
          position:relative for absolute positioning to anchor correctly. */}
      <div className="sticky top-2 z-20 flex justify-end gap-1.5 pointer-events-none mb-1">
        <button
          type="button"
          onClick={() => setActive(v => !v)}
          className={`pointer-events-auto px-2.5 py-1 rounded-lg text-xs font-bold shadow-sm border ${
            active
              ? "bg-rose-600 text-white border-rose-700 hover:bg-rose-700"
              : "bg-white text-rose-600 border-rose-300 hover:bg-rose-50"
          }`}
          title={active ? "Pen on — tap to disable" : "Tap to draw on this passage"}
        >
          {active ? "Pen on" : "Pen"}
        </button>
        <button
          type="button"
          onClick={clearAll}
          className="pointer-events-auto px-2.5 py-1 rounded-lg text-xs font-bold bg-white text-slate-600 border border-slate-300 hover:bg-slate-50 shadow-sm"
          title="Clear all ink"
        >
          Clear
        </button>
      </div>
      <canvas
        ref={canvasRef}
        className="absolute top-0 left-0 z-10"
        style={{ touchAction: active ? "none" : "auto", pointerEvents: active ? "auto" : "none" }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
    </>
  );
}

// Cheap blank-canvas check so we send null instead of a 100KB transparent
// PNG over the wire when the parent clears all their ink.
function isCanvasBlank(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext("2d");
  if (!ctx) return true;
  // Sample a sparse grid — if every sampled pixel has alpha 0, treat as
  // blank. Cheaper than scanning every pixel and reliable enough since
  // ink strokes have width ≥ 4 px.
  const w = canvas.width;
  const h = canvas.height;
  const samples = 100;
  for (let i = 0; i < samples; i++) {
    const x = Math.floor((i / samples) * w);
    for (let j = 0; j < samples; j++) {
      const y = Math.floor((j / samples) * h);
      const data = ctx.getImageData(x, y, 1, 1).data;
      if (data[3] !== 0) return false;
    }
  }
  return true;
}
