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
  readOnly = false,
  onSaved,
  controlledActive,
  clearSignal,
}: {
  paperId: string;
  storageKey: string;
  initialDataUrl?: string | null;
  // readOnly = student viewing the parent's annotations. Paints the
  // saved PNG but shows no Pen/Clear toolbar and ignores all pointer
  // events. No save calls are made.
  readOnly?: boolean;
  // Called after a successful save so the parent can refresh its
  // local cache. Without this, navigating away and back inside the
  // same session re-mounts the overlay with the stale initialDataUrl
  // from page-load time, and just-drawn ink disappears until reload.
  onSaved?: (storageKey: string, dataUrl: string | null) => void;
  // Pass a boolean to render in 'controlled' mode — the internal
  // Pen/Clear toolbar is suppressed and the active state comes from
  // the parent. Used by the review page to hoist the toolbar up
  // alongside the section header.
  controlledActive?: boolean;
  // Bump this number to trigger a clear from outside (paired with
  // controlledActive when the toolbar is hoisted). The component
  // ignores the value, just watches for it changing.
  clearSignal?: number;
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
  // Track whether the server currently holds anything for this key. If
  // the canvas is blank and the server is also blank (no initialDataUrl,
  // never saved), skip the fetch entirely — sending null in that case
  // is a no-op write that wastes a round trip and DB space on the
  // 'pen overlay tapped but nothing drawn' path.
  const hasSavedNonBlank = useRef<boolean>(!!initialDataUrl);
  // Defer painting the saved PNG until the canvas has real dimensions
  // (parent's scrollHeight can be 0 on first effect run before layout
  // settles). Stash the seed and let the first non-zero fitAndPaint
  // draw it in.
  const initialPaintPending = useRef<string | null>(initialDataUrl ?? null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [internalActive, setActive] = useState(false);
  const isControlled = controlledActive !== undefined;
  const active = isControlled ? !!controlledActive : internalActive;

  function getPosXY(clientX: number, clientY: number) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * (canvas.width / rect.width),
      y: (clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  // Flush the canvas immediately to the API. Called on the
  // 'review:save-pen' custom event (parent dispatches before navigation),
  // on component unmount, and on tab hide. No debounce — saves happen
  // when the parent leaves the current view, not while they're drawing.
  const flush = useCallback(async () => {
    // Read-only viewers (students) never write back; cleanup paths
    // (unmount, pagehide, visibilitychange) all funnel through here.
    if (readOnly) return;
    if (!dirty.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const blank = isCanvasBlank(canvas);
    // Skip the round trip if the canvas is blank AND the server already
    // has nothing saved here. Avoids a no-op DB write every time the
    // parent toggles Pen on then off without drawing.
    if (blank && !hasSavedNonBlank.current) {
      dirty.current = false;
      return;
    }
    const dataUrl = blank ? null : canvas.toDataURL("image/png");
    dirty.current = false;
    const body = JSON.stringify({ reviewAnnotations: { [storageKey]: dataUrl } });
    // Pick the right transport. sendBeacon for pagehide is the only
    // way to reliably ship a >64KB body during page-unload (fetch
    // keepalive caps the whole tab at 64KB and a single PNG can blow
    // past that). For normal in-page navigation the React unmount
    // flush is plain fetch which has no size limit.
    const onUnload = typeof document !== "undefined" && document.visibilityState === "hidden";
    try {
      if (onUnload && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        const blob = new Blob([body], { type: "application/json" });
        const ok = navigator.sendBeacon(`/api/exam/${paperId}`, blob);
        if (!ok) throw new Error("sendBeacon refused");
      } else {
        await fetch(`/api/exam/${paperId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body,
        });
      }
      hasSavedNonBlank.current = !blank;
      // Notify the parent so its cache reflects what's now on the
      // server — otherwise re-mounting this overlay (next/prev nav)
      // would seed from the stale initial data.
      onSaved?.(storageKey, dataUrl);
    } catch {
      // Re-mark dirty so the next flush retries.
      dirty.current = true;
    }
  }, [paperId, storageKey, readOnly, onSaved]);

  // Debounced save on pen-up. Without this, all save weight is on
  // navigation/unmount, and big PNG bodies can lose the race with
  // page navigation. A short debounce means most strokes are already
  // saved by the time the parent navigates.
  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { flush(); }, 600);
  }, [flush]);

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
    // Schedule an eager save so navigation isn't the only safety net
    // — important because PNG bodies can be 50-200 KB which can race
    // page-unload otherwise.
    scheduleSave();
  }

  function clearAll() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
    dirty.current = true;
    // Clear is a destructive action — flush immediately so the user
    // sees the empty state stick across reload.
    flush();
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
      // Paint the seed annotation after the FIRST resize that produced
      // real dimensions. Painting it before fitAndPaint had real width
      // would draw it at the default 300×150 canvas size, then leave a
      // tiny smudge in the top-left after the real resize.
      const seed = initialPaintPending.current;
      if (seed && newCtx) {
        const img = new Image();
        img.onload = () => {
          const canv = canvasRef.current;
          if (!canv) return;
          // Preserve every saved stroke even if the surrounding text
          // layout has shrunk since save time (layout changes between
          // draw and reload would otherwise either clip strokes off
          // the bottom or stretch them off the text they were marking).
          // If the saved PNG is taller/wider than the current canvas,
          // extend the canvas to fit it. Result: nothing is lost on
          // reload; the canvas may visually extend past the passage's
          // last line by the difference, which is acceptable.
          const dprNow = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 3);
          const seedCssW = img.naturalWidth / dprNow;
          const seedCssH = img.naturalHeight / dprNow;
          const curCssW = parseFloat(canv.style.width) || 0;
          const curCssH = parseFloat(canv.style.height) || 0;
          const wantW = Math.max(curCssW, seedCssW);
          const wantH = Math.max(curCssH, seedCssH);
          if (wantW > curCssW || wantH > curCssH) {
            canv.style.width = `${wantW}px`;
            canv.style.height = `${wantH}px`;
            canv.width = Math.round(wantW * dprNow);
            canv.height = Math.round(wantH * dprNow);
          }
          const cx = canv.getContext("2d");
          // Natural size — strokes land at the same pixel they were
          // drawn at, so they stay over the same text content they
          // were marking (assuming text didn't reflow).
          if (cx) cx.drawImage(img, 0, 0);
        };
        img.src = seed;
        initialPaintPending.current = null;
      }
    }

    fitAndPaint();

    const obs = new ResizeObserver(fitAndPaint);
    obs.observe(parent);
    return () => obs.disconnect();
    // initialDataUrl intentionally omitted from deps — it's the seed,
    // not a live source of truth (we own the canvas after first paint).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External clear trigger — used when the toolbar is hoisted out of
  // the overlay (controlled mode). Skip the very first render so the
  // initial value doesn't fire a phantom clear on mount.
  const lastClearSignal = useRef<number | undefined>(clearSignal);
  useEffect(() => {
    if (clearSignal === undefined) return;
    if (lastClearSignal.current === undefined) {
      lastClearSignal.current = clearSignal;
      return;
    }
    if (clearSignal !== lastClearSignal.current) {
      lastClearSignal.current = clearSignal;
      clearAll();
    }
    // clearAll is stable across renders for our purposes (no closure deps that change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearSignal]);

  // Flush triggers: parent's custom 'review:save-pen' event (fired by
  // back / next / prev / reviewed buttons), tab hidden, and unmount.
  useEffect(() => {
    function onSaveEvent() { flush(); }
    function onVisibilityChange() {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") flush();
    }
    window.addEventListener("review:save-pen", onSaveEvent);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onSaveEvent);
    return () => {
      window.removeEventListener("review:save-pen", onSaveEvent);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onSaveEvent);
      // Unmount = parent navigated to a different question. Flush so
      // the strokes from this question survive the navigation.
      flush();
    };
  }, [flush]);

  return (
    <>
      {/* Toolbar: sticky to the top of the parent's scroll context so
          the buttons stay floating alongside the section header even
          when the parent scrolls the passage internally. We render
          the wrapper (and reserve its height) for readOnly viewers
          too — using visibility: hidden — so both parent and student
          see identical text positions and saved strokes line up.
          When controlled (toolbar hoisted by the page into the
          section header), the internal toolbar is omitted entirely. */}
      {!isControlled && (
        <div
          className="sticky top-0 z-20 flex justify-end gap-1.5 pointer-events-none"
          style={{ visibility: readOnly ? "hidden" : "visible" }}
        >
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
      )}
      <canvas
        ref={canvasRef}
        className="absolute top-0 left-0 z-10"
        // Read-only: never accept events. Editable: only when Pen is on.
        style={{
          touchAction: !readOnly && active ? "none" : "auto",
          pointerEvents: !readOnly && active ? "auto" : "none",
        }}
        onPointerDown={readOnly ? undefined : onDown}
        onPointerMove={readOnly ? undefined : onMove}
        onPointerUp={readOnly ? undefined : onUp}
        onPointerCancel={readOnly ? undefined : onUp}
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
