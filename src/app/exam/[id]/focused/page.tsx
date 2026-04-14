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
  // Snapshots — kept as refs so they never race with React state. compositeBlobsRef is the
  // composite JPG (question image + ink), inkBlobsRef is the ink-only PNG. Both are the source
  // of truth on submit. The state setInkBlobs is only used to pass the latest ink back to the
  // mounted canvas as its inkBlob prop so returning to a question shows prior strokes.
  const compositeBlobsRef = useRef<(Blob | null)[]>([]);
  const inkBlobsRef = useRef<(Blob | null)[]>([]);
  // MCQ answers: questionIndex → selected option ("1"|"2"|"3"|"4")
  const [mcqAnswers, setMcqAnswers] = useState<Record<number, string>>({});

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

  // Capture the live canvas at index `idx` into both refs (and mirror ink to state so
  // the re-mounted canvas can restore strokes when you come back to this question).
  const captureCanvasAt = useCallback(async (idx: number) => {
    const handle = canvasHandles.current[idx];
    if (!handle) { console.log(`[focused] no handle at idx=${idx}`); return; }
    try {
      const [ink, composite] = await Promise.all([handle.exportInk(), handle.exportImage()]);
      compositeBlobsRef.current[idx] = composite;
      inkBlobsRef.current[idx] = ink;
      setInkBlobs(prev => {
        const next = [...prev];
        next[idx] = ink;
        return next;
      });
      console.log(`[focused] captured idx=${idx} ink=${ink.size}b composite=${composite.size}b`);
    } catch (e) {
      console.log(`[focused] capture failed idx=${idx}`, e);
    }
  }, []);

  // Autosave: every time we capture, also POST this single question's files so the server
  // has a fresh copy even if the student never clicks Save or Submit.
  const autoSaveQuestion = useCallback(async (idx: number) => {
    const composite = compositeBlobsRef.current[idx];
    const ink = inkBlobsRef.current[idx];
    if (!composite && !ink) return;
    const form = new FormData();
    form.append("action", "save");
    if (composite) form.append(`page_${idx}`, composite, `page_${idx}.jpg`);
    if (ink) form.append(`page_${idx}_ink`, ink, `page_${idx}_ink.png`);
    try {
      const res = await fetch(`/api/exam/${id}/submission`, { method: "POST", body: form });
      console.log(`[focused] autosave idx=${idx} ${res.ok ? "ok" : `failed ${res.status}`}`);
    } catch (e) {
      console.log(`[focused] autosave idx=${idx} error`, e);
    }
  }, [id]);

  // Debounce autosave — accumulate strokes for 1s before uploading
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleAutosave = useCallback((idx: number) => {
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      captureCanvasAt(idx).then(() => autoSaveQuestion(idx));
    }, 800);
  }, [captureCanvasAt, autoSaveQuestion]);

  // Wrap setCurrentIdx so we always snapshot the live canvas before unmounting it
  async function navigateTo(nextIdx: number) {
    if (nextIdx === currentIdx) return;
    // Flush any pending autosave immediately
    if (autoSaveTimer.current) { clearTimeout(autoSaveTimer.current); autoSaveTimer.current = null; }
    await captureCanvasAt(currentIdx);
    // Fire-and-forget autosave for the question we're leaving so its files exist on disk
    autoSaveQuestion(currentIdx).catch(() => {});
    setCurrentIdx(nextIdx);
  }

  async function saveProgress() {
    if (!paper) return;
    await captureCanvasAt(currentIdx);
    const form = new FormData();
    form.append("action", "save");
    for (let i = 0; i < paper.questions.length; i++) {
      const ink = inkBlobsRef.current[i];
      const composite = compositeBlobsRef.current[i];
      if (ink) form.append(`page_${i}_ink`, ink, `page_${i}_ink.png`);
      if (composite) form.append(`page_${i}`, composite, `page_${i}.jpg`);
    }
    await fetch(`/api/exam/${id}/submission`, { method: "POST", body: form });
  }

  async function handleSubmit() {
    if (!paper || submitting) return;
    setSubmitting(true);
    try {
      // Flush any debounced autosave and snapshot the live canvas
      if (autoSaveTimer.current) { clearTimeout(autoSaveTimer.current); autoSaveTimer.current = null; }
      await captureCanvasAt(currentIdx);
      // Fire one final autosave for the live canvas before the submit FormData goes out
      await autoSaveQuestion(currentIdx).catch(() => {});

      // Score MCQs client-side and persist studentAnswer/marksAwarded so the marker can count them
      const mcqUpdates = paper.questions.map((q, i) => {
        const correct = (q.answer ?? "").replace(/[().]/g, "").trim();
        const isMcq = ["1","2","3","4"].includes(correct);
        if (!isMcq) return null;
        const selected = mcqAnswers[i] ?? null;
        const isCorrect = !!selected && selected === correct;
        return fetch(`/api/exam/questions/${q.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            studentAnswer: selected,
            marksAwarded: isCorrect ? (q.marksAvailable ?? 1) : 0,
            markingNotes: selected ? (isCorrect ? "Correct" : `Student: ${selected}, Correct: ${correct}`) : "No answer",
          }),
        });
      }).filter(Boolean);
      if (mcqUpdates.length > 0) await Promise.all(mcqUpdates);

      // Upload each question's composite + ink from the snapshot refs (covers every visited canvas)
      const form = new FormData();
      form.append("action", "submit");
      let uploaded = 0;
      for (let i = 0; i < paper.questions.length; i++) {
        const composite = compositeBlobsRef.current[i];
        const ink = inkBlobsRef.current[i];
        if (composite) { form.append(`page_${i}`, composite, `page_${i}.jpg`); uploaded++; }
        if (ink) form.append(`page_${i}_ink`, ink, `page_${i}_ink.png`);
      }
      console.log(`[focused] submit uploading ${uploaded}/${paper.questions.length} composite files`);
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
    <div className="min-h-screen bg-slate-50 pb-36 select-none" style={{ WebkitTouchCallout: "none", WebkitUserSelect: "none" }}>
      {/* Header */}
      <div className="bg-white border-b border-slate-100 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <button
            onClick={() => router.push(`/home/${userId}`)}
            className="p-1.5 -ml-1 rounded-lg text-slate-500 hover:text-slate-700 hover:bg-slate-100 shrink-0"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <div className="min-w-0">
            <h1 className="text-sm font-bold text-slate-800 truncate">{paper.title}</h1>
            <p className="text-[11px] text-slate-400">Q{currentIdx + 1} / {questions.length}</p>
          </div>
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
        {/* Question image with drawing overlay */}
        <div className="bg-white">
          <AnswerCanvas
            key={currentIdx}
            ref={(el) => { canvasHandles.current[currentIdx] = el; }}
            tool={tool}
            questionImageSrc={currentQ.imageData}
            inkBlob={inkBlobs[currentIdx] ?? undefined}
            onStrokeStart={() => {
              lastDrawnIdx.current = currentIdx;
              setHasInk((prev) => {
                const next = [...prev];
                next[currentIdx] = true;
                return next;
              });
            }}
            onStrokeEnd={() => { scheduleAutosave(currentIdx); }}
          />
        </div>
        {/* MCQ option picker — only shown for MCQ questions */}
        {(() => {
          const correctLetter = (currentQ.answer ?? "").replace(/[().]/g, "").trim();
          if (!["1","2","3","4"].includes(correctLetter)) return null;
          const selected = mcqAnswers[currentIdx] ?? null;
          return (
            <div className="bg-white border-t border-slate-100 px-4 py-4">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-2">Select your answer</p>
              <div className="grid grid-cols-4 gap-2">
                {["1","2","3","4"].map(opt => (
                  <button
                    key={opt}
                    onClick={() => setMcqAnswers(prev => ({ ...prev, [currentIdx]: opt }))}
                    className={`py-3 rounded-xl border-2 font-bold transition-all ${selected === opt ? "border-blue-600 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"}`}
                  >
                    ({opt})
                  </button>
                ))}
              </div>
            </div>
          );
        })()}
      </div>

      {/* Bottom bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 px-4 py-3 z-10">
        <div className="max-w-2xl mx-auto">
          {/* Question dots */}
          <div className="flex justify-center gap-1.5 mb-3">
            {questions.map((q, i) => (
              <button
                key={q.id}
                onClick={() => navigateTo(i)}
                className={`w-2.5 h-2.5 rounded-full transition-colors ${
                  i === currentIdx
                    ? "bg-primary-500"
                    : hasInk[i] || mcqAnswers[i]
                    ? "bg-green-400"
                    : "bg-slate-200"
                }`}
              />
            ))}
          </div>

          <div className="flex gap-3">
            <button
              onClick={() => saveProgress().catch(() => {})}
              className="px-3 py-2.5 rounded-xl border border-slate-200 text-slate-600 text-xs font-medium hover:bg-slate-50"
              title="Save progress so you can safely refresh"
            >
              Save
            </button>
            <button
              onClick={() => navigateTo(Math.max(0, currentIdx - 1))}
              disabled={currentIdx === 0}
              className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-600 font-medium hover:bg-slate-50 disabled:opacity-30 text-sm"
            >
              Previous
            </button>
            {currentIdx < questions.length - 1 ? (
              <button
                onClick={() => navigateTo(currentIdx + 1)}
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
  { tool: DrawTool; questionImageSrc: string; inkBlob?: Blob; onStrokeStart: () => void; onStrokeEnd?: () => void }
>(function AnswerCanvas({ tool, questionImageSrc, inkBlob, onStrokeStart, onStrokeEnd }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inkCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  const isDrawing = useRef(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const history = useRef<ImageData[]>([]);
  const pendingSnapshot = useRef<ImageData | null>(null);
  const snapshotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inkApplied = useRef(false);
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number } | null>(null);

  // Load question image and set canvas size
  useEffect(() => {
    const img = new window.Image();
    img.onload = () => {
      bgImageRef.current = img;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      setCanvasSize({ w, h });

      // Set up visible canvas with question image background
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { desynchronized: true })!;
        ctx.drawImage(img, 0, 0, w, h);
      }

      // Set up off-screen ink canvas
      const inkCanvas = document.createElement("canvas");
      inkCanvas.width = w;
      inkCanvas.height = h;
      inkCanvasRef.current = inkCanvas;
    };
    img.src = questionImageSrc;
  }, [questionImageSrc]);

  // Apply saved ink blob
  useEffect(() => {
    if (inkBlob && !inkApplied.current && canvasSize) {
      inkApplied.current = true;
      const url = URL.createObjectURL(inkBlob);
      const img = new window.Image();
      img.onload = () => {
        const { w, h } = canvasSize;
        // Draw ink on the off-screen ink canvas
        inkCanvasRef.current?.getContext("2d")?.drawImage(img, 0, 0, w, h);
        // Draw ink on the visible canvas (on top of background)
        canvasRef.current?.getContext("2d", { desynchronized: true })?.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
      };
      img.src = url;
    }
  }, [inkBlob, canvasSize]);

  // Redraw composite (background + ink) from ink canvas
  function redrawComposite() {
    const canvas = canvasRef.current;
    const bg = bgImageRef.current;
    const inkCanvas = inkCanvasRef.current;
    if (!canvas || !bg) return;
    const ctx = canvas.getContext("2d", { desynchronized: true })!;
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(bg, 0, 0, canvas.width, canvas.height);
    if (inkCanvas) ctx.drawImage(inkCanvas, 0, 0);
  }

  useImperativeHandle(ref, () => ({
    exportImage(): Promise<Blob> {
      return new Promise((resolve, reject) => {
        // Export the visible canvas (background + ink)
        const canvas = canvasRef.current;
        if (!canvas) { reject(new Error("Not ready")); return; }
        // Redraw to ensure composite is clean
        redrawComposite();
        canvas.toBlob(
          (blob) => blob ? resolve(blob) : reject(new Error("Export failed")),
          "image/jpeg", 0.88
        );
      });
    },
    exportInk(): Promise<Blob> {
      return new Promise((resolve, reject) => {
        // Export only the ink layer (transparent background)
        const inkCanvas = inkCanvasRef.current;
        if (!inkCanvas) { reject(new Error("Not ready")); return; }
        inkCanvas.toBlob(
          (blob) => blob ? resolve(blob) : reject(new Error("Export failed")),
          "image/png"
        );
      });
    },
    undo() {
      const inkCanvas = inkCanvasRef.current;
      if (!inkCanvas || history.current.length === 0) return;
      inkCanvas.getContext("2d")!.putImageData(history.current.pop()!, 0, 0);
      redrawComposite();
    },
  }));

  function saveSnapshot() {
    const inkCanvas = inkCanvasRef.current;
    if (!inkCanvas) return;
    history.current.push(inkCanvas.getContext("2d")!.getImageData(0, 0, inkCanvas.width, inkCanvas.height));
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
      const inkCanvas = inkCanvasRef.current;
      if (!inkCanvas) return;
      pendingSnapshot.current = inkCanvas.getContext("2d")!.getImageData(0, 0, inkCanvas.width, inkCanvas.height);
    }, 300);
  }

  // Cache bounding rect to avoid forced layout reflow on every pointer event
  const cachedRect = useRef<DOMRect | null>(null);
  function invalidateRect() { cachedRect.current = null; }

  function getPos(clientX: number, clientY: number) {
    const canvas = canvasRef.current!;
    if (!cachedRect.current) cachedRect.current = canvas.getBoundingClientRect();
    const rect = cachedRect.current;
    return {
      x: (clientX - rect.left) * (canvas.width / rect.width),
      y: (clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  useEffect(() => {
    window.addEventListener("scroll", invalidateRect, true);
    window.addEventListener("resize", invalidateRect);
    return () => {
      window.removeEventListener("scroll", invalidateRect, true);
      window.removeEventListener("resize", invalidateRect);
    };
  }, []);

  // Store tool and onStrokeStart in refs so native listeners always see latest values
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const onStrokeStartRef = useRef(onStrokeStart);
  onStrokeStartRef.current = onStrokeStart;
  const onStrokeEndRef = useRef(onStrokeEnd);
  onStrokeEndRef.current = onStrokeEnd;

  // Stable native event listeners — attached once, never re-attached
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d", { desynchronized: true })!;

    function applyStyleVisible() {
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      if (toolRef.current === "eraser") {
        // For eraser on visible canvas: draw background color to "erase"
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = "rgba(255,255,255,1)";
        ctx.lineWidth = 24;
      } else {
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = "rgba(37,99,235,0.85)";
        ctx.lineWidth = 3;
      }
    }

    function applyStyleInk(inkCtx: CanvasRenderingContext2D) {
      inkCtx.lineCap = "round"; inkCtx.lineJoin = "round";
      if (toolRef.current === "eraser") {
        inkCtx.globalCompositeOperation = "destination-out";
        inkCtx.strokeStyle = "rgba(0,0,0,1)";
        inkCtx.lineWidth = 24;
      } else {
        inkCtx.globalCompositeOperation = "source-over";
        inkCtx.strokeStyle = "rgba(37,99,235,0.85)";
        inkCtx.lineWidth = 3;
      }
    }

    function handlePointerDown(e: PointerEvent) {
      e.preventDefault();
      cancelPendingCapture();
      onStrokeStartRef.current();
      isDrawing.current = true;
      if (pendingSnapshot.current) {
        history.current.push(pendingSnapshot.current);
        if (history.current.length > 30) history.current.shift();
        pendingSnapshot.current = null;
      } else if (history.current.length === 0) {
        saveSnapshot();
      }
      const pos = getPos(e.clientX, e.clientY);
      lastPos.current = pos;

      // Draw dot on visible canvas
      applyStyleVisible();
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, toolRef.current === "eraser" ? 12 : 1.5, 0, Math.PI * 2);
      ctx.fill();

      // Draw dot on ink canvas
      const inkCtx = inkCanvasRef.current?.getContext("2d");
      if (inkCtx) {
        applyStyleInk(inkCtx);
        inkCtx.beginPath();
        inkCtx.arc(pos.x, pos.y, toolRef.current === "eraser" ? 12 : 1.5, 0, Math.PI * 2);
        inkCtx.fill();
      }

      // After eraser, redraw composite to show background through erased areas
      if (toolRef.current === "eraser") {
        redrawComposite();
      }
    }

    function handlePointerMove(e: PointerEvent) {
      if (!isDrawing.current || !lastPos.current) return;
      e.preventDefault();
      const pos = getPos(e.clientX, e.clientY);

      // Draw on visible canvas
      applyStyleVisible();
      ctx.beginPath();
      ctx.moveTo(lastPos.current.x, lastPos.current.y);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();

      // Draw on ink canvas
      const inkCtx = inkCanvasRef.current?.getContext("2d");
      if (inkCtx) {
        applyStyleInk(inkCtx);
        inkCtx.beginPath();
        inkCtx.moveTo(lastPos.current.x, lastPos.current.y);
        inkCtx.lineTo(pos.x, pos.y);
        inkCtx.stroke();
      }

      lastPos.current = pos;
    }

    function handlePointerUp() {
      if (!isDrawing.current) return;
      isDrawing.current = false;
      lastPos.current = null;
      // After eraser stroke, redraw composite cleanly
      if (toolRef.current === "eraser") {
        redrawComposite();
      }
      scheduleSnapshotCapture();
      // Notify parent the stroke is complete so it can snapshot the canvas to its refs
      onStrokeEndRef.current?.();
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
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ touchAction: "none" }}>
      <canvas
        ref={canvasRef}
        className="w-full border-0"
        style={{
          aspectRatio: canvasSize ? `${canvasSize.w} / ${canvasSize.h}` : "4 / 3",
          cursor: tool === "pen" ? PEN_CURSOR : "cell",
          touchAction: "none",
        }}
      />
    </div>
  );
});
