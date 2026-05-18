"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

// Chinese handwriting canvas — a free-hand drawing surface with a
// 田字格-style square grid baked into the background. Each cell is
// large enough (default 80px) for one Chinese character. Students
// write their answer one character per cell, freeing them from
// typing 中文 on a tablet keyboard.
//
// Pure renderer — does NOT wire backend save / marker integration
// yet. Caller passes `onChange` to receive an ink-only PNG dataUrl
// whenever the student lifts the pen; caller can persist that to
// the same /api/exam/[id]/submission endpoint the English OEQ flow
// uses, or hold it in local state.
//
// Tool prop mirrors the English canvas types so the existing
// pen / eraser / eraser-large toolbar can drive this component
// unchanged.

export type CharCanvasTool = "pen" | "eraser" | "eraser-large" | "type" | null | undefined;

export type ChineseHandwritingCanvasHandle = {
  /** Return current ink as a base64 PNG (data URL). */
  toDataURL: () => string | null;
  /** Clear all ink, keep grid. */
  clearInk: () => void;
};

interface Props {
  /** Approximate display height in CSS pixels. Internal canvas is
   *  rendered at 2x for crisp lines on retina screens. */
  height?: number;
  /** Approximate cell size in CSS pixels. Default 80px ≈ 25% of a
   *  tablet keyboard key, comfortable for primary-school handwriting. */
  cellSize?: number;
  /** Current draw tool. "pen" draws ink; "eraser" / "eraser-large"
   *  erase. Any other value disables interaction. */
  tool?: CharCanvasTool;
  /** Optional saved ink (data URL or remote URL) to pre-fill. */
  savedInkUrl?: string | null;
  /** Fires after each completed stroke with the ink-only PNG dataUrl.
   *  Throttled so it doesn't fire per pointer-move event. */
  onChange?: (inkDataUrl: string) => void;
  /** Pen colour. Default blue. */
  inkColor?: string;
}

const PEN_WIDTH = 2.5;
const ERASER_WIDTH = 18;
const ERASER_LARGE_WIDTH = 56;

export const ChineseHandwritingCanvas = forwardRef<ChineseHandwritingCanvasHandle, Props>(function ChineseHandwritingCanvas(
  { height = 320, cellSize = 80, tool, savedInkUrl, onChange, inkColor = "#1d4ed8" },
  ref,
) {
  // Fixed display dimensions so the canvas backing buffer is stable;
  // we render at 2x for retina sharpness. 800px CSS width matches
  // the existing English answer canvas so flexbox doesn't reflow.
  const CSS_W = 800;
  const CSS_H = height;
  const DPR = 2;
  const BUFFER_W = CSS_W * DPR;
  const BUFFER_H = CSS_H * DPR;

  const visibleRef = useRef<HTMLCanvasElement>(null);
  const inkLayerRef = useRef<HTMLCanvasElement | null>(null);
  const gridLayerRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const [ready, setReady] = useState(false);
  const toolRef = useRef<CharCanvasTool>(tool);
  toolRef.current = tool;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Draw the 田字格-style grid on a canvas context. Cells are square,
  // 4 cells per row × however-many rows fit. Each cell is divided by
  // a faint cross (vertical + horizontal midlines) to guide stroke
  // placement, like a Chinese composition workbook.
  function drawGrid(ctx: CanvasRenderingContext2D) {
    ctx.clearRect(0, 0, BUFFER_W, BUFFER_H);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, BUFFER_W, BUFFER_H);

    const cellPx = cellSize * DPR;
    const cols = Math.floor(BUFFER_W / cellPx);
    const rows = Math.floor(BUFFER_H / cellPx);
    const gridW = cols * cellPx;
    const gridH = rows * cellPx;
    const offsetX = Math.floor((BUFFER_W - gridW) / 2);
    const offsetY = Math.floor((BUFFER_H - gridH) / 2);

    // Cross-lines inside each cell — drawn FIRST so the cell border
    // overprints any pixel at the boundary.
    ctx.strokeStyle = "#fecaca"; // soft red — classic 田字格 colour
    ctx.lineWidth = 0.75 * DPR;
    ctx.setLineDash([4 * DPR, 4 * DPR]);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x0 = offsetX + c * cellPx;
        const y0 = offsetY + r * cellPx;
        // Vertical midline
        ctx.beginPath();
        ctx.moveTo(x0 + cellPx / 2, y0);
        ctx.lineTo(x0 + cellPx / 2, y0 + cellPx);
        ctx.stroke();
        // Horizontal midline
        ctx.beginPath();
        ctx.moveTo(x0, y0 + cellPx / 2);
        ctx.lineTo(x0 + cellPx, y0 + cellPx / 2);
        ctx.stroke();
      }
    }

    // Cell borders — solid red, drawn on top of the dashed midlines.
    ctx.setLineDash([]);
    ctx.strokeStyle = "#dc2626";
    ctx.lineWidth = 1 * DPR;
    for (let r = 0; r <= rows; r++) {
      const y = offsetY + r * cellPx;
      ctx.beginPath();
      ctx.moveTo(offsetX, y);
      ctx.lineTo(offsetX + gridW, y);
      ctx.stroke();
    }
    for (let c = 0; c <= cols; c++) {
      const x = offsetX + c * cellPx;
      ctx.beginPath();
      ctx.moveTo(x, offsetY);
      ctx.lineTo(x, offsetY + gridH);
      ctx.stroke();
    }
  }

  // Render the visible canvas: grid background + ink on top. The grid
  // is drawn ONCE into an offscreen cache at mount; per-frame repaint
  // is two fast bitmap blits, not ~1300 stroke ops. This keeps the pen
  // smooth on larger grids (Q33 = 12×18 cells).
  function repaint() {
    const visible = visibleRef.current;
    const inkLayer = inkLayerRef.current;
    const gridLayer = gridLayerRef.current;
    if (!visible || !inkLayer || !gridLayer) return;
    const ctx = visible.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(gridLayer, 0, 0);
    ctx.drawImage(inkLayer, 0, 0);
  }

  function emitChange() {
    const ink = inkLayerRef.current;
    if (!ink) return;
    try {
      onChangeRef.current?.(ink.toDataURL("image/png"));
    } catch {
      /* drawImage from a cross-origin source could taint the canvas; ignore */
    }
  }

  useImperativeHandle(ref, () => ({
    toDataURL: () => {
      const ink = inkLayerRef.current;
      if (!ink) return null;
      try { return ink.toDataURL("image/png"); } catch { return null; }
    },
    clearInk: () => {
      const ink = inkLayerRef.current;
      if (!ink) return;
      const ctx = ink.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, BUFFER_W, BUFFER_H);
      repaint();
      emitChange();
    },
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  function pointerPos(e: PointerEvent): { x: number; y: number } {
    const canvas = visibleRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * BUFFER_W,
      y: ((e.clientY - rect.top) / rect.height) * BUFFER_H,
    };
  }

  // Stroke one event's worth of samples into the ink layer. Reads
  // coalesced events so high-frequency pens (Apple Pencil 240Hz,
  // S-Pen 120Hz) don't lose sub-frame samples between vsyncs.
  function strokeEvent(e: PointerEvent) {
    if (!drawing.current) return;
    const inkCtx = inkLayerRef.current?.getContext("2d");
    if (!inkCtx) return;
    const t = toolRef.current;
    inkCtx.lineCap = "round";
    inkCtx.lineJoin = "round";
    if (t === "eraser" || t === "eraser-large") {
      inkCtx.globalCompositeOperation = "destination-out";
      inkCtx.strokeStyle = "rgba(0,0,0,1)";
      inkCtx.lineWidth = (t === "eraser-large" ? ERASER_LARGE_WIDTH : ERASER_WIDTH) * DPR;
    } else {
      inkCtx.globalCompositeOperation = "source-over";
      inkCtx.strokeStyle = inkColor;
      inkCtx.lineWidth = PEN_WIDTH * DPR;
    }
    const samples =
      typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : null;
    const points = samples && samples.length > 0 ? samples : [e];
    for (const ev of points) {
      const pos = pointerPos(ev);
      const prev = lastPos.current ?? pos;
      inkCtx.beginPath();
      inkCtx.moveTo(prev.x, prev.y);
      inkCtx.lineTo(pos.x, pos.y);
      inkCtx.stroke();
      lastPos.current = pos;
    }
    repaint();
  }

  useEffect(() => {
    const visible = visibleRef.current;
    if (!visible) return;
    visible.width = BUFFER_W;
    visible.height = BUFFER_H;
    const inkLayer = document.createElement("canvas");
    inkLayer.width = BUFFER_W;
    inkLayer.height = BUFFER_H;
    inkLayerRef.current = inkLayer;

    // Pre-render the grid into an offscreen canvas once — repaint then
    // blits this cached bitmap instead of restroking every cell.
    const gridLayer = document.createElement("canvas");
    gridLayer.width = BUFFER_W;
    gridLayer.height = BUFFER_H;
    const gridCtx = gridLayer.getContext("2d");
    if (gridCtx) drawGrid(gridCtx);
    gridLayerRef.current = gridLayer;

    // Native event listeners with { passive: false }. React's synthetic
    // pointer events get scheduled through the React event system,
    // which on a busy main thread can defer/batch pointermove. Native
    // listeners on the DOM element receive events at full browser rate
    // and let us call preventDefault() to claim ownership of the
    // gesture so the browser doesn't waste cycles on scroll/zoom
    // detection that touch-action: none should already block. The
    // combined effect is fewer dropped fast-stroke samples.
    const onDown = (e: PointerEvent) => {
      e.preventDefault();
      (e.target as Element).setPointerCapture(e.pointerId);
      drawing.current = true;
      lastPos.current = pointerPos(e);
    };
    const onMove = (e: PointerEvent) => {
      if (!drawing.current) return;
      e.preventDefault();
      strokeEvent(e);
    };
    // pointerrawupdate fires for raw input samples even between
    // vsyncs on Chrome / Edge / Android Chrome — Safari ignores it.
    // We attach it in addition to pointermove; either one calling
    // strokeEvent is fine since lastPos.current keeps the chain
    // continuous and any duplicate sample produces a zero-length
    // segment that's invisible.
    const onRaw = (e: PointerEvent) => {
      if (!drawing.current) return;
      strokeEvent(e);
    };
    const onUp = () => {
      if (!drawing.current) return;
      drawing.current = false;
      lastPos.current = null;
      emitChange();
    };

    visible.addEventListener("pointerdown", onDown, { passive: false });
    visible.addEventListener("pointermove", onMove, { passive: false });
    visible.addEventListener("pointerup", onUp);
    visible.addEventListener("pointercancel", onUp);
    // The "as keyof HTMLElementEventMap" cast is needed because
    // pointerrawupdate isn't yet in lib.dom.d.ts in all TS versions.
    visible.addEventListener("pointerrawupdate" as keyof HTMLElementEventMap, onRaw as EventListener, { passive: false } as AddEventListenerOptions);

    // Load saved ink onto the ink-layer first so the initial repaint
    // shows previously-saved work.
    if (savedInkUrl) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const inkCtx = inkLayer.getContext("2d");
        if (inkCtx) inkCtx.drawImage(img, 0, 0, BUFFER_W, BUFFER_H);
        repaint();
        setReady(true);
      };
      img.onerror = () => { repaint(); setReady(true); };
      img.src = savedInkUrl;
    } else {
      repaint();
      setReady(true);
    }

    return () => {
      visible.removeEventListener("pointerdown", onDown);
      visible.removeEventListener("pointermove", onMove);
      visible.removeEventListener("pointerup", onUp);
      visible.removeEventListener("pointercancel", onUp);
      visible.removeEventListener("pointerrawupdate" as keyof HTMLElementEventMap, onRaw as EventListener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    // select-none + WebkitTouchCallout: none applied locally on the
    // canvas wrapper. The quiz root previously had this globally but
    // was relaxed so the dictionary can pick up text selections on
    // stems / passages / MCQ options. Without these here, every
    // pointer-move on the canvas competes with the browser's
    // selection / callout machinery, which feels like pen lag.
    <div
      className="bg-white rounded-2xl shadow-sm ring-1 ring-[#c3c6d1]/20 overflow-hidden select-none"
      style={{ height: CSS_H, WebkitUserSelect: "none", userSelect: "none", WebkitTouchCallout: "none" }}
    >
      <canvas
        ref={visibleRef}
        className="w-full h-full block touch-none select-none"
        // Pointer handlers are attached natively in useEffect (passive: false,
        // plus pointerrawupdate on Chrome/Edge for sub-vsync samples).
        // willChange + translateZ promote the canvas to its own GPU layer
        // so the per-event repaint doesn't invalidate surrounding content.
        style={{
          touchAction: "none",
          WebkitUserSelect: "none",
          userSelect: "none",
          WebkitTouchCallout: "none",
          willChange: "contents",
          transform: "translateZ(0)",
          cursor: tool === "eraser" || tool === "eraser-large" ? "cell" : "crosshair",
        }}
      />
      {!ready && (
        <div className="text-xs text-slate-400 p-2">Loading…</div>
      )}
    </div>
  );
});

export default ChineseHandwritingCanvas;
