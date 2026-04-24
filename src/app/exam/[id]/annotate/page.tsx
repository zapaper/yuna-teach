"use client";

import { Suspense, use, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import AdminNav from "@/components/AdminNav";
import { renderPdfToImages } from "@/lib/pdf";

type Tool = "pen" | "eraser";

// Tap the Pen button cycles through these widths. Values are in canvas-
// internal pixels, which get scaled down to the display-size stroke the
// user actually sees (canvas internal is usually larger than display).
const PEN_WIDTHS = [3, 5, 7] as const;

export default function AnnotatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense>
      <AnnotateContent id={id} />
    </Suspense>
  );
}

function AnnotateContent({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";

  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [pageImages, setPageImages] = useState<string[]>([]);
  const [loadingPdf, setLoadingPdf] = useState(true);
  const [currentPage, setCurrentPage] = useState(0);
  const [tool, setTool] = useState<Tool>("pen");
  const [penWidth, setPenWidth] = useState<number>(PEN_WIDTHS[0]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Map page-index → data URL of the annotation layer. We load existing
  // annotations from the server once and write back to this map as the
  // admin draws; save persists the map.
  const annotationsRef = useRef<Record<number, string>>({});
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const isDrawing = useRef(false);
  const undoStack = useRef<ImageData[]>([]);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`).then(r => setAllowed(r.ok)).catch(() => setAllowed(false));
  }, [userId]);

  // Load page images + existing annotations once the admin check passes.
  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    (async () => {
      setLoadingPdf(true);
      try {
        // Prefer pre-rendered page images from disk (fast); fall back to
        // client-side PDF rendering via the existing renderer.
        let images: string[] = [];
        try {
          const countRes = await fetch(`/api/exam/${id}/pages`);
          if (countRes.ok) {
            const { pageCount } = await countRes.json();
            if (pageCount > 0) {
              for (let i = 0; i < pageCount; i++) {
                const r = await fetch(`/api/exam/${id}/pages?page=${i}`);
                if (!r.ok) throw new Error("page fetch failed");
                const blob = await r.blob();
                images.push(URL.createObjectURL(blob));
              }
            }
          }
        } catch { /* fall through */ }
        if (images.length === 0) {
          const pdfRes = await fetch(`/api/exam/${id}/pdf`);
          if (pdfRes.ok) {
            const blob = await pdfRes.blob();
            const file = new File([blob], "exam.pdf", { type: "application/pdf" });
            images = await renderPdfToImages(file);
          }
        }
        if (cancelled) return;
        setPageImages(images);
        // Load existing annotations.
        try {
          const res = await fetch(`/api/exam/${id}/annotations`);
          if (res.ok) {
            const data = await res.json() as { annotationsByPage: Record<string, string> };
            const mapped: Record<number, string> = {};
            for (const [k, v] of Object.entries(data.annotationsByPage ?? {})) {
              if (typeof v === "string") mapped[Number(k)] = v;
            }
            annotationsRef.current = mapped;
          }
        } catch { /* no-op */ }
      } finally {
        if (!cancelled) setLoadingPdf(false);
      }
    })();
    return () => { cancelled = true; };
  }, [allowed, id]);

  // When the current page or images change, size the canvas to the image
  // and paint any previously-saved annotation layer on it.
  const pageUrl = pageImages[currentPage];
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pageUrl) return;
    const img = new Image();
    img.onload = () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const existing = annotationsRef.current[currentPage];
      if (existing) {
        const overlay = new Image();
        overlay.onload = () => { ctx.drawImage(overlay, 0, 0); };
        overlay.src = existing;
      }
      // Reset undo stack for this page.
      undoStack.current = [];
    };
    img.src = pageUrl;
  }, [pageUrl, currentPage]);

  function pushUndoSnapshot() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    try {
      undoStack.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
      if (undoStack.current.length > 30) undoStack.current.shift();
    } catch { /* ignore */ }
  }

  function handleUndo() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || undoStack.current.length === 0) return;
    const snap = undoStack.current.pop()!;
    ctx.putImageData(snap, 0, 0);
    // Rewrite the page's annotation after undo.
    annotationsRef.current[currentPage] = canvas.toDataURL("image/png");
    setDirty(true);
  }

  function getPos(e: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    pushUndoSnapshot();
    isDrawing.current = true;
    const pos = getPos(e);
    lastPos.current = pos;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,1)";
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 16, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "rgba(0, 0, 0, 0.95)";
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, penWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!isDrawing.current || !lastPos.current) return;
    e.preventDefault();
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const pos = getPos(e);
    if (tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
      ctx.lineWidth = 32;
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "rgba(0, 0, 0, 0.95)";
      ctx.lineWidth = penWidth;
    }
    ctx.beginPath();
    ctx.moveTo(lastPos.current.x, lastPos.current.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    lastPos.current = pos;
  }

  function onPointerUp() {
    if (!isDrawing.current) return;
    isDrawing.current = false;
    lastPos.current = null;
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Persist the current page's annotation layer in the ref so the save
    // call can bundle every edited page.
    annotationsRef.current[currentPage] = canvas.toDataURL("image/png");
    setDirty(true);
  }

  function clearPage() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    pushUndoSnapshot();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    delete annotationsRef.current[currentPage];
    setDirty(true);
  }

  const saveChanges = useCallback(async () => {
    setSaving(true);
    try {
      // Convert the map (keyed by number) back to string keys as the API
      // expects, and drop blank canvases to keep the JSON compact.
      const body: Record<string, string> = {};
      for (const [k, v] of Object.entries(annotationsRef.current)) {
        if (typeof v === "string" && v.length > 0) body[String(k)] = v;
      }
      const res = await fetch(`/api/exam/${id}/annotations`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ annotationsByPage: body }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setToast(data.error ?? "Save failed");
      } else {
        const data = await res.json().catch(() => ({}));
        const pagesBaked: number = data.pagesBaked ?? 0;
        setDirty(false);
        // Strokes are now inside the PDF, so clear the draft and force-
        // reload the page images from the freshly-baked PDF.
        annotationsRef.current = {};
        const pdfRes = await fetch(`/api/exam/${id}/pdf?v=${Date.now()}`);
        let freshImages: string[] = [];
        if (pdfRes.ok) {
          const blob = await pdfRes.blob();
          const file = new File([blob], "exam.pdf", { type: "application/pdf" });
          freshImages = await renderPdfToImages(file);
          setPageImages(freshImages);
        }
        // Auto-recrop each question's imageData from the freshly-baked
        // pages so quiz/review screens immediately show the annotated
        // version. Admin doesn't have to manually re-extract.
        let recropped = 0;
        if (pagesBaked > 0 && freshImages.length > 0) {
          try {
            recropped = await recropQuestionsFromPages(id, freshImages);
          } catch (err) {
            console.warn("[annotate] recrop failed:", err);
          }
        }
        const parts = [pagesBaked > 0 ? `Baked into PDF (${pagesBaked} page${pagesBaked === 1 ? "" : "s"})` : "Saved"];
        if (recropped > 0) parts.push(`re-cropped ${recropped} question${recropped === 1 ? "" : "s"}`);
        setToast(parts.join(" · "));
      }
    } finally {
      setSaving(false);
      setTimeout(() => setToast(null), 2200);
    }
  }, [id]);

  if (allowed === null || (allowed && loadingPdf)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" />
      </div>
    );
  }
  if (!allowed) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><p className="text-slate-500 text-sm">Access denied.</p></div>;
  }

  const totalPages = pageImages.length;
  const hasAnnotation = !!annotationsRef.current[currentPage];

  return (
    <div className="min-h-screen bg-slate-900">
      <AdminNav userId={userId} />
      <div className="lg:ml-56">
        {/* Top bar */}
        <div className="bg-slate-800 text-white px-4 py-2 flex items-center gap-3 sticky top-0 z-20">
          <button onClick={() => router.push(`/exam/${id}/edit?userId=${userId}`)}
            className="text-xs font-bold text-slate-300 hover:text-white">
            ← Back to editor
          </button>
          <div className="flex items-center gap-1 ml-4">
            <button
              onClick={() => {
                // Tap once to select the pen, tap again to cycle width.
                if (tool !== "pen") setTool("pen");
                else {
                  const i = PEN_WIDTHS.indexOf(penWidth as (typeof PEN_WIDTHS)[number]);
                  setPenWidth(PEN_WIDTHS[(i + 1) % PEN_WIDTHS.length]);
                }
              }}
              title={tool === "pen" ? "Tap to change width" : "Pen"}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 ${tool === "pen" ? "bg-red-500 text-white" : "bg-slate-700 text-slate-300"}`}>
              <span className="material-symbols-outlined text-sm">edit</span>
              Pen {tool === "pen" && <span className="text-[10px] opacity-80 tabular-nums">{penWidth}px</span>}
            </button>
            <button onClick={() => setTool("eraser")}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 ${tool === "eraser" ? "bg-red-500 text-white" : "bg-slate-700 text-slate-300"}`}>
              <span className="material-symbols-outlined text-sm">ink_eraser</span>Eraser
            </button>
            <button onClick={handleUndo}
              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-700 text-slate-300 hover:bg-slate-600 flex items-center gap-1">
              <span className="material-symbols-outlined text-sm">undo</span>Undo
            </button>
            <button onClick={clearPage} disabled={!hasAnnotation}
              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-700 text-slate-300 hover:bg-slate-600 flex items-center gap-1 disabled:opacity-40">
              <span className="material-symbols-outlined text-sm">clear_all</span>Clear page
            </button>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <button onClick={() => setCurrentPage(p => Math.max(0, p - 1))} disabled={currentPage === 0}
              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-700 text-slate-300 hover:bg-slate-600 disabled:opacity-40">
              ← Prev
            </button>
            <span className="text-xs font-bold text-slate-300 tabular-nums min-w-[64px] text-center">
              {currentPage + 1} / {totalPages || "?"}
            </span>
            <button onClick={() => setCurrentPage(p => Math.min(totalPages - 1, p + 1))} disabled={currentPage >= totalPages - 1}
              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-700 text-slate-300 hover:bg-slate-600 disabled:opacity-40">
              Next →
            </button>
            <button onClick={saveChanges} disabled={saving || !dirty}
              className={`px-4 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1 ${dirty ? "bg-emerald-500 hover:bg-emerald-400 text-white" : "bg-slate-700 text-slate-400"} disabled:opacity-60`}>
              {saving ? "Saving…" : dirty ? "Save" : "Saved"}
            </button>
          </div>
        </div>

        {/* Canvas + underlying PDF page image */}
        <div className="p-6 flex justify-center">
          {pageUrl ? (
            <div className="relative inline-block bg-white shadow-2xl">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={pageUrl} alt={`Page ${currentPage + 1}`} className="block max-w-full h-auto pointer-events-none select-none" />
              <canvas
                ref={canvasRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onPointerLeave={onPointerUp}
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  touchAction: "none",
                  cursor: tool === "eraser" ? "cell" : "crosshair",
                }}
              />
            </div>
          ) : (
            <p className="text-slate-400 text-sm">No PDF available for this paper.</p>
          )}
        </div>
      </div>

      {toast && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-sm px-4 py-2 rounded-xl shadow-lg z-50">
          {toast}
        </div>
      )}
    </div>
  );
}

// After baking annotations into the PDF, re-crop every question's stored
// imageData (full-width yStart/yEnd slice) and diagramImageData
// (diagramBounds rect) from the freshly-rendered pages. Writes the new
// crops via /api/exam/:id/recrop-questions in one POST.
async function recropQuestionsFromPages(paperId: string, pageImageUrls: string[]): Promise<number> {
  const detailRes = await fetch(`/api/exam/${paperId}`);
  if (!detailRes.ok) return 0;
  const paper = await detailRes.json() as {
    questions: Array<{
      id: string;
      pageIndex: number;
      yStartPct: number | null;
      yEndPct: number | null;
      diagramBounds: { top: number; left: number; bottom: number; right: number } | null;
    }>;
  };
  // Load each page into an Image once so we reuse the pixel data for every
  // question sourced from it.
  const imgs: HTMLImageElement[] = [];
  for (const url of pageImageUrls) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("page load failed"));
      img.src = url;
    });
    imgs.push(img);
  }

  function crop(img: HTMLImageElement, topPct: number, leftPct: number, bottomPct: number, rightPct: number): string | null {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const sx = Math.max(0, Math.round((leftPct / 100) * w));
    const sy = Math.max(0, Math.round((topPct / 100) * h));
    const sw = Math.max(1, Math.round(((rightPct - leftPct) / 100) * w));
    const sh = Math.max(1, Math.round(((bottomPct - topPct) / 100) * h));
    if (sw <= 0 || sh <= 0) return null;
    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    return canvas.toDataURL("image/jpeg", 0.9);
  }

  const payload: Array<{ id: string; imageData?: string; diagramImageData?: string | null }> = [];
  for (const q of paper.questions) {
    const img = imgs[q.pageIndex];
    if (!img) continue;
    const update: { id: string; imageData?: string; diagramImageData?: string | null } = { id: q.id };
    if (typeof q.yStartPct === "number" && typeof q.yEndPct === "number") {
      const cropped = crop(img, q.yStartPct, 0, q.yEndPct, 100);
      if (cropped) update.imageData = cropped;
    }
    if (q.diagramBounds) {
      const d = q.diagramBounds;
      const cropped = crop(img, d.top, d.left, d.bottom, d.right);
      if (cropped) update.diagramImageData = cropped;
    }
    if (update.imageData || update.diagramImageData !== undefined) payload.push(update);
  }
  if (payload.length === 0) return 0;

  const saveRes = await fetch(`/api/exam/${paperId}/recrop-questions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ questions: payload }),
  });
  if (!saveRes.ok) return 0;
  const data = await saveRes.json().catch(() => ({}));
  return Number(data.updated) || 0;
}
