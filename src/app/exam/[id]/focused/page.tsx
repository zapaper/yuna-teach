"use client";

import { Suspense, useEffect, useState, useRef, useCallback, useImperativeHandle, forwardRef, use } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ExamPaperDetail } from "@/types";

export default function FocusedTestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <Suspense>
      <FocusedTestContent id={id} />
    </Suspense>
  );
}

type DrawTool = "pen" | "eraser";

const PEN_CURSOR =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='4'%3E%3Ccircle cx='2' cy='2' r='2' fill='%232563eb'/%3E%3C/svg%3E\") 2 2, crosshair";

interface AnswerCanvasHandle {
  exportImage(): Promise<Blob>;
  exportInk(): Promise<Blob>;
  undo(): void;
}

function FocusedTestContent({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";

  const [paper, setPaper] = useState<ExamPaperDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [tool, setTool] = useState<DrawTool>("pen");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [markingDone, setMarkingDone] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const canvasHandles = useRef<(AnswerCanvasHandle | null)[]>([]);
  const [hasInk, setHasInk] = useState<boolean[]>([]);
  const lastDrawnIdx = useRef<number | null>(null);
  const [inkBlobs, setInkBlobs] = useState<(Blob | null)[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/exam/${id}`);
        if (!res.ok) throw new Error("Not found");
        const data: ExamPaperDetail = await res.json();
        setPaper(data);
        setHasInk(new Array(data.questions.length).fill(false));

        if (data.completedAt) {
          setSubmitted(true);
          if (data.markingStatus === "complete" || data.markingStatus === "released") {
            setMarkingDone(true);
          }
        }
        setElapsed(data.timeSpentSeconds || 0);

        // Load previously saved ink
        const subRes = await fetch(`/api/exam/${id}/submission`);
        if (subRes.ok) {
          const sub = await subRes.json();
          if (sub.pageCount > 0) {
            const blobs = await Promise.all(
              Array.from({ length: sub.pageCount }, (_, i) =>
                fetch(`/api/exam/${id}/submission?page=${i}&type=ink`)
                  .then((r) => (r.ok ? r.blob() : null))
                  .catch(() => null)
              )
            );
            setInkBlobs(blobs);
            setHasInk(blobs.map((b) => b !== null));
          }
        }
      } catch {
        setPaper(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  // Timer
  useEffect(() => {
    if (!submitted && paper && !loading) {
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [submitted, paper, loading]);

  // Poll for marking
  useEffect(() => {
    if (submitted && !markingDone) {
      pollRef.current = setInterval(async () => {
        const res = await fetch(`/api/exam/${id}/mark`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.markingStatus === "complete" || data.markingStatus === "released") {
          setMarkingDone(true);
          if (pollRef.current) clearInterval(pollRef.current);
        }
      }, 3000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [submitted, markingDone, id]);

  const saveTimeToServer = useCallback(async () => {
    await fetch(`/api/exam/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeSpentSeconds: elapsed }),
    });
  }, [id, elapsed]);

  async function handleSubmit() {
    if (!paper || submitting) return;
    setSubmitting(true);
    try {
      const form = new FormData();
      form.append("action", "submit");
      for (let i = 0; i < paper.questions.length; i++) {
        const handle = canvasHandles.current[i];
        if (handle) {
          const [composite, ink] = await Promise.all([
            handle.exportImage(),
            handle.exportInk(),
          ]);
          form.append(`page_${i}`, composite, `page_${i}.jpg`);
          form.append(`page_${i}_ink`, ink, `page_${i}_ink.png`);
        }
      }
      await Promise.all([
        fetch(`/api/exam/${id}/submission`, { method: "POST", body: form }),
        saveTimeToServer(),
      ]);
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  }

  function handleUndo() {
    if (lastDrawnIdx.current !== null) {
      canvasHandles.current[lastDrawnIdx.current]?.undo();
    }
  }

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  if (loading) {
    return (
      <div className="flex justify-center py-24">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-200 border-t-primary-500" />
      </div>
    );
  }

  if (!paper) {
    return (
      <div className="p-6 text-center py-24">
        <p className="text-slate-500">Test not found</p>
      </div>
    );
  }

  const questions = paper.questions;
  const currentQ = questions[currentIdx];

  // After submission
  if (submitted) {
    return (
      <div className="p-6 pb-24 max-w-lg mx-auto text-center">
        <div className="py-12">
          {markingDone ? (
            <>
              <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-green-600">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </div>
              <h2 className="text-xl font-bold text-slate-800 mb-2">Test Marked!</h2>
              <p className="text-sm text-slate-500 mb-6">Your focused test has been marked by AI.</p>
              <button
                onClick={() => router.push(`/exam/${id}/review?userId=${userId}`)}
                className="px-6 py-3 rounded-2xl bg-primary-500 text-white font-semibold hover:bg-primary-600"
              >
                View Results
              </button>
            </>
          ) : (
            <>
              <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary-200 border-t-primary-500 mx-auto mb-4" />
              <h2 className="text-xl font-bold text-slate-800 mb-2">Marking in progress...</h2>
              <p className="text-sm text-slate-400">AI is checking your answers. This takes about a minute.</p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-36">
      {/* Header */}
      <div className="bg-white border-b border-slate-100 px-4 py-3 flex items-center justify-between">
        <div className="min-w-0">
          <h1 className="text-sm font-bold text-slate-800 truncate">{paper.title}</h1>
          <p className="text-[11px] text-slate-400">Q{currentIdx + 1} / {questions.length}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-3">
          {/* Drawing tools */}
          <div className="flex items-center gap-0.5 bg-slate-100 rounded-lg p-0.5">
            <button
              onClick={() => setTool("pen")}
              className={`p-1.5 rounded-md transition-colors ${
                tool === "pen" ? "bg-white text-blue-600 shadow-sm" : "text-slate-400"
              }`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
              </svg>
            </button>
            <button
              onClick={() => setTool("eraser")}
              className={`p-1.5 rounded-md transition-colors ${
                tool === "eraser" ? "bg-white text-red-500 shadow-sm" : "text-slate-400"
              }`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
                <path d="M22 21H7" />
                <path d="m5 11 9 9" />
              </svg>
            </button>
            <button
              onClick={handleUndo}
              className="p-1.5 rounded-md text-slate-400 hover:text-slate-600 transition-colors"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7v6h6" />
                <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
              </svg>
            </button>
          </div>
          <span className="text-xs font-mono text-slate-400 tabular-nums">{formatTime(elapsed)}</span>
        </div>
      </div>

      <div className="max-w-2xl mx-auto">
        {/* Question image */}
        <div className="bg-white border-b border-slate-200">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={currentQ.imageData}
            alt={`Question ${currentQ.questionNum}`}
            className="w-full"
          />
        </div>

        {/* Answer drawing area */}
        <div className="bg-white">
          <div className="px-3 py-1 border-b border-slate-100">
            <span className="text-[10px] font-medium text-slate-300 uppercase tracking-wider">Write your answer below</span>
          </div>
          <AnswerCanvas
            key={currentIdx}
            ref={(el) => { canvasHandles.current[currentIdx] = el; }}
            tool={tool}
            inkBlob={inkBlobs[currentIdx] ?? undefined}
            onStrokeStart={() => {
              lastDrawnIdx.current = currentIdx;
              setHasInk((prev) => {
                const next = [...prev];
                next[currentIdx] = true;
                return next;
              });
            }}
          />
        </div>
      </div>

      {/* Bottom bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 px-4 py-3 z-10">
        <div className="max-w-2xl mx-auto">
          {/* Question dots */}
          <div className="flex justify-center gap-1.5 mb-3">
            {questions.map((q, i) => (
              <button
                key={q.id}
                onClick={() => setCurrentIdx(i)}
                className={`w-2.5 h-2.5 rounded-full transition-colors ${
                  i === currentIdx
                    ? "bg-primary-500"
                    : hasInk[i]
                    ? "bg-green-400"
                    : "bg-slate-200"
                }`}
              />
            ))}
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => setCurrentIdx((i) => Math.max(0, i - 1))}
              disabled={currentIdx === 0}
              className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-600 font-medium hover:bg-slate-50 disabled:opacity-30 text-sm"
            >
              Previous
            </button>
            {currentIdx < questions.length - 1 ? (
              <button
                onClick={() => setCurrentIdx((i) => i + 1)}
                className="flex-1 py-2.5 rounded-xl bg-primary-600 text-white font-medium hover:bg-primary-700 text-sm"
              >
                Next
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={submitting}
                className="flex-1 py-2.5 rounded-xl bg-green-500 text-white font-medium hover:bg-green-600 disabled:opacity-50 text-sm"
              >
                {submitting ? "Submitting..." : "Submit Test"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Answer drawing canvas ────────────────────────────────────────────────

const AnswerCanvas = forwardRef<
  AnswerCanvasHandle,
  { tool: DrawTool; inkBlob?: Blob; onStrokeStart: () => void }
>(function AnswerCanvas({ tool, inkBlob, onStrokeStart }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawing = useRef(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const history = useRef<ImageData[]>([]);
  const pendingSnapshot = useRef<ImageData | null>(null);
  const snapshotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inkApplied = useRef(false);
  const CANVAS_W = 1200;
  const CANVAS_H = 600;

  function drawBackground(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.strokeStyle = "#e2e8f0";
    ctx.lineWidth = 1;
    for (let y = 40; y < CANVAS_H; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(CANVAS_W, y);
      ctx.stroke();
    }
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    drawBackground(canvas.getContext("2d")!);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (inkBlob && !inkApplied.current && canvasRef.current?.width) {
      inkApplied.current = true;
      const url = URL.createObjectURL(inkBlob);
      const img = new Image();
      img.onload = () => {
        canvasRef.current?.getContext("2d")?.drawImage(img, 0, 0, CANVAS_W, CANVAS_H);
        URL.revokeObjectURL(url);
      };
      img.src = url;
    }
  }, [inkBlob]);

  useImperativeHandle(ref, () => ({
    exportImage(): Promise<Blob> {
      return new Promise((resolve, reject) => {
        const canvas = canvasRef.current;
        if (!canvas) { reject(new Error("Not ready")); return; }
        canvas.toBlob(
          (blob) => blob ? resolve(blob) : reject(new Error("Export failed")),
          "image/jpeg", 0.88
        );
      });
    },
    exportInk(): Promise<Blob> {
      return new Promise((resolve, reject) => {
        const canvas = canvasRef.current;
        if (!canvas) { reject(new Error("Not ready")); return; }
        canvas.toBlob(
          (blob) => blob ? resolve(blob) : reject(new Error("Export failed")),
          "image/png"
        );
      });
    },
    undo() {
      const canvas = canvasRef.current;
      if (!canvas || history.current.length === 0) return;
      canvas.getContext("2d")!.putImageData(history.current.pop()!, 0, 0);
    },
  }));

  function saveSnapshot() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    history.current.push(canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height));
    if (history.current.length > 30) history.current.shift();
  }

  function cancelPendingCapture() {
    if (snapshotTimer.current) {
      clearTimeout(snapshotTimer.current);
      snapshotTimer.current = null;
    }
  }

  function scheduleSnapshotCapture() {
    cancelPendingCapture();
    snapshotTimer.current = setTimeout(() => {
      snapshotTimer.current = null;
      const canvas = canvasRef.current;
      if (!canvas) return;
      pendingSnapshot.current = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
    }, 300);
  }

  function getPos(clientX: number, clientY: number) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * (canvas.width / rect.width),
      y: (clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  function applyStyle(ctx: CanvasRenderingContext2D) {
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    if (tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
      ctx.lineWidth = 24;
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "rgba(37,99,235,0.85)";
      ctx.lineWidth = 3;
    }
  }

  function onStart(clientX: number, clientY: number) {
    cancelPendingCapture();
    onStrokeStart();
    isDrawing.current = true;
    if (pendingSnapshot.current) {
      history.current.push(pendingSnapshot.current);
      if (history.current.length > 30) history.current.shift();
      pendingSnapshot.current = null;
    } else if (history.current.length === 0) {
      saveSnapshot();
    }
    const pos = getPos(clientX, clientY);
    lastPos.current = pos;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    applyStyle(ctx);
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, tool === "eraser" ? 12 : 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  function onMove(clientX: number, clientY: number) {
    if (!isDrawing.current || !lastPos.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const pos = getPos(clientX, clientY);
    applyStyle(ctx);
    ctx.beginPath();
    ctx.moveTo(lastPos.current.x, lastPos.current.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    lastPos.current = pos;
  }

  function onEnd() {
    isDrawing.current = false;
    lastPos.current = null;
    scheduleSnapshotCapture();
  }

  // Use native event listeners for zero-overhead pointer handling
  const toolRef = useRef(tool);
  toolRef.current = tool;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    function handlePointerDown(e: PointerEvent) {
      e.preventDefault();
      onStart(e.clientX, e.clientY);
    }
    function handlePointerMove(e: PointerEvent) {
      if (!isDrawing.current) return;
      e.preventDefault();
      onMove(e.clientX, e.clientY);
    }
    function handlePointerUp() {
      onEnd();
    }
    function handleContextMenu(e: Event) {
      e.preventDefault();
    }

    canvas.addEventListener("pointerdown", handlePointerDown, { passive: false });
    canvas.addEventListener("pointermove", handlePointerMove, { passive: false });
    canvas.addEventListener("pointerup", handlePointerUp);
    canvas.addEventListener("pointercancel", handlePointerUp);
    canvas.addEventListener("contextmenu", handleContextMenu);

    return () => {
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerup", handlePointerUp);
      canvas.removeEventListener("pointercancel", handlePointerUp);
      canvas.removeEventListener("contextmenu", handleContextMenu);
      cancelPendingCapture();
    };
  }); // Re-attach when component re-renders to capture latest closures

  return (
    <div style={{ touchAction: "none" }}>
      <canvas
        ref={canvasRef}
        className="w-full border-0"
        style={{
          aspectRatio: `${CANVAS_W} / ${CANVAS_H}`,
          cursor: tool === "pen" ? PEN_CURSOR : "cell",
          touchAction: "none",
        }}
      />
    </div>
  );
});
