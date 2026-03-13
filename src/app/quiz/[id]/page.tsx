"use client";

import { Suspense, useEffect, useState, useRef, useCallback, useImperativeHandle, forwardRef, use } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/* ────────────── types ────────────── */

interface QuizQuestion {
  id: string;
  questionNum: string;
  answer: string | null;
  imageData: string;
  transcribedStem: string | null;
  transcribedOptions: string[] | null;
  transcribedOptionImages: string[] | null;
  transcribedSubparts: { label: string; text: string }[] | null;
  diagramImageData: string | null;
  marksAvailable: number | null;
  syllabusTopic: string | null;
}

interface QuizPaper {
  id: string;
  title: string;
  metadata: { quizType: "mcq" | "mcq-oeq" } | null;
  completedAt: string | null;
  timeSpentSeconds: number;
  questions: QuizQuestion[];
}

type DrawTool = "pen" | "eraser";

/* ────────────── helpers ────────────── */

function normalizeMcqAnswer(ans: string | null): string {
  if (!ans) return "";
  return ans.trim().replace(/[().]/g, "").trim();
}

function isMcq(answer: string | null): boolean {
  const n = normalizeMcqAnswer(answer);
  return n === "1" || n === "2" || n === "3" || n === "4";
}

const formatTime = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
};

/* ────────────── main page ────────────── */

export default function QuizPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense>
      <QuizContent id={id} />
    </Suspense>
  );
}

function QuizContent({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";

  const [paper, setPaper] = useState<QuizPaper | null>(null);
  const [loading, setLoading] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // MCQ answers: questionId -> selected option (1-4)
  const [mcqAnswers, setMcqAnswers] = useState<Record<string, string>>({});

  // OEQ state
  const [currentOeqIdx, setCurrentOeqIdx] = useState(0);
  const [oeqTool, setOeqTool] = useState<DrawTool>("pen");
  const oeqCanvasHandles = useRef<(AnswerCanvasHandle | null)[]>([]);
  const [oeqHasInk, setOeqHasInk] = useState<boolean[]>([]);
  const lastDrawnIdx = useRef<number | null>(null);

  // Submission
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [mcqScore, setMcqScore] = useState<{ correct: number; total: number } | null>(null);
  const [markingOeq, setMarkingOeq] = useState(false);
  const [markingDone, setMarkingDone] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // View mode: "mcq" or "oeq" (for MCQ+OEQ quizzes)
  const [viewMode, setViewMode] = useState<"mcq" | "oeq">("mcq");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/exam/${id}`);
        if (!res.ok) throw new Error("Not found");
        const data = await res.json();
        setPaper(data);
        setElapsed(data.timeSpentSeconds || 0);
        if (data.completedAt) {
          setSubmitted(true);
          if (data.markingStatus === "complete" || data.markingStatus === "released") {
            setMarkingDone(true);
          }
        }
        // Initialize OEQ ink tracking
        const oeqCount = data.questions.filter((q: QuizQuestion) => !isMcq(q.answer)).length;
        setOeqHasInk(new Array(oeqCount).fill(false));
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
      timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [submitted, paper, loading]);

  // Poll for OEQ marking
  useEffect(() => {
    if (markingOeq && !markingDone) {
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
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [markingOeq, markingDone, id]);

  if (loading) {
    return (
      <div className="flex justify-center py-24">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-200 border-t-primary-500" />
      </div>
    );
  }
  if (!paper) {
    return <div className="p-6 text-center py-24"><p className="text-slate-500">Quiz not found</p></div>;
  }

  const quizType = paper.metadata?.quizType ?? "mcq";
  const mcqQuestions = paper.questions.filter(q => isMcq(q.answer));
  const oeqQuestions = paper.questions.filter(q => !isMcq(q.answer));
  const hasOeq = quizType === "mcq-oeq" && oeqQuestions.length > 0;

  function selectMcqAnswer(questionId: string, option: string) {
    setMcqAnswers(prev => ({ ...prev, [questionId]: option }));
  }

  async function handleSubmit() {
    if (submitting) return;
    setSubmitting(true);
    try {
      // Score MCQ instantly
      let correct = 0;
      for (const q of mcqQuestions) {
        const selected = mcqAnswers[q.id];
        const correctAns = normalizeMcqAnswer(q.answer);
        if (selected === correctAns) correct++;
      }
      setMcqScore({ correct, total: mcqQuestions.length });

      // Save MCQ answers to DB
      await Promise.all(
        mcqQuestions.map(q =>
          fetch(`/api/exam/questions/${q.id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              studentAnswer: mcqAnswers[q.id] || null,
              marksAwarded: mcqAnswers[q.id] === normalizeMcqAnswer(q.answer) ? (q.marksAvailable ?? 1) : 0,
            }),
          })
        )
      );

      // For MCQ+OEQ: submit OEQ drawings for AI marking
      if (hasOeq) {
        const form = new FormData();
        form.append("action", "submit");
        // OEQ questions need canvas submissions
        for (let i = 0; i < oeqQuestions.length; i++) {
          const handle = oeqCanvasHandles.current[i];
          if (handle) {
            const [composite, ink] = await Promise.all([
              handle.exportImage(),
              handle.exportInk(),
            ]);
            // Page index for OEQ = mcqQuestions.length + i
            const pageIdx = mcqQuestions.length + i;
            form.append(`page_${pageIdx}`, composite, `page_${pageIdx}.jpg`);
            form.append(`page_${pageIdx}_ink`, ink, `page_${pageIdx}_ink.png`);
          }
        }
        await fetch(`/api/exam/${id}/submission`, { method: "POST", body: form });
        setMarkingOeq(true);
      }

      // Save time and mark as completed
      await fetch(`/api/exam/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeSpentSeconds: elapsed, completedAt: new Date().toISOString() }),
      });

      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  }

  // ─── Post-submission view ───
  if (submitted) {
    return (
      <div className="p-6 pb-24 max-w-lg mx-auto text-center">
        <div className="py-12">
          <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-green-600">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-slate-800 mb-2">Quiz Complete!</h2>
          <p className="text-sm text-slate-500 mb-2">Time: {formatTime(elapsed)}</p>

          {mcqScore && (
            <div className="bg-white rounded-2xl border border-slate-200 p-6 mb-4">
              <p className="text-sm text-slate-400 mb-1">MCQ Score</p>
              <p className="text-4xl font-bold text-primary-600">{mcqScore.correct} / {mcqScore.total}</p>
              <p className="text-sm text-slate-400 mt-1">
                {Math.round((mcqScore.correct / mcqScore.total) * 100)}%
              </p>
            </div>
          )}

          {hasOeq && (
            markingDone ? (
              <div className="bg-white rounded-2xl border border-slate-200 p-4 mb-4">
                <p className="text-sm text-green-600 font-medium">OEQ has been marked!</p>
              </div>
            ) : (
              <div className="bg-white rounded-2xl border border-slate-200 p-4 mb-4">
                <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary-200 border-t-primary-500 mx-auto mb-2" />
                <p className="text-sm text-slate-400">AI is marking your written answers...</p>
              </div>
            )
          )}

          <div className="flex gap-3 mt-6">
            <button
              onClick={() => router.push(`/exam/${id}/review?userId=${userId}`)}
              className="flex-1 px-4 py-3 rounded-2xl bg-primary-500 text-white font-semibold hover:bg-primary-600"
            >
              View Answers
            </button>
            <button
              onClick={() => router.push(`/home/${userId}`)}
              className="flex-1 px-4 py-3 rounded-2xl border-2 border-slate-200 text-slate-600 font-semibold hover:bg-slate-50"
            >
              Home
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Quiz taking view ───
  return (
    <div className="min-h-screen bg-slate-50 pb-36 select-none" style={{ WebkitTouchCallout: "none", WebkitUserSelect: "none" }}>
      {/* Header */}
      <div className="bg-white border-b border-slate-100 px-4 py-3 flex items-center justify-between sticky top-0 z-20">
        <div className="min-w-0">
          <h1 className="text-sm font-bold text-slate-800 truncate">{paper.title}</h1>
          <p className="text-[11px] text-slate-400">
            {quizType === "mcq"
              ? `${Object.keys(mcqAnswers).length} / ${mcqQuestions.length} answered`
              : viewMode === "mcq"
              ? `MCQ: ${Object.keys(mcqAnswers).length} / ${mcqQuestions.length}`
              : `OEQ: Q${currentOeqIdx + 1} / ${oeqQuestions.length}`}
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0 ml-3">
          {/* OEQ drawing tools */}
          {hasOeq && viewMode === "oeq" && (
            <div className="flex items-center gap-0.5 bg-slate-100 rounded-lg p-0.5">
              <button
                onClick={() => setOeqTool("pen")}
                className={`p-1.5 rounded-md transition-colors ${oeqTool === "pen" ? "bg-white text-blue-600 shadow-sm" : "text-slate-400"}`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
                </svg>
              </button>
              <button
                onClick={() => setOeqTool("eraser")}
                className={`p-1.5 rounded-md transition-colors ${oeqTool === "eraser" ? "bg-white text-red-500 shadow-sm" : "text-slate-400"}`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
                  <path d="M22 21H7" /><path d="m5 11 9 9" />
                </svg>
              </button>
              <button
                onClick={() => { if (lastDrawnIdx.current !== null) oeqCanvasHandles.current[lastDrawnIdx.current]?.undo(); }}
                className="p-1.5 rounded-md text-slate-400 hover:text-slate-600 transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 7v6h6" /><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
                </svg>
              </button>
            </div>
          )}
          <span className="text-xs font-mono text-slate-400 tabular-nums">{formatTime(elapsed)}</span>
        </div>
      </div>

      {/* Mode tabs for MCQ+OEQ */}
      {hasOeq && (
        <div className="bg-white border-b border-slate-100 px-4 py-2 flex gap-2">
          <button
            onClick={() => setViewMode("mcq")}
            className={`flex-1 py-2 rounded-xl text-sm font-medium transition-colors ${
              viewMode === "mcq" ? "bg-primary-500 text-white" : "bg-slate-100 text-slate-500"
            }`}
          >
            MCQ ({mcqQuestions.length})
          </button>
          <button
            onClick={() => setViewMode("oeq")}
            className={`flex-1 py-2 rounded-xl text-sm font-medium transition-colors ${
              viewMode === "oeq" ? "bg-primary-500 text-white" : "bg-slate-100 text-slate-500"
            }`}
          >
            Written ({oeqQuestions.length})
          </button>
        </div>
      )}

      {/* MCQ section */}
      {(quizType === "mcq" || viewMode === "mcq") && (
        <div className="max-w-2xl mx-auto px-4 py-4 space-y-4">
          {mcqQuestions.map((q, idx) => (
            <McqQuestionCard
              key={q.id}
              question={q}
              index={idx}
              selected={mcqAnswers[q.id] ?? null}
              onSelect={(opt) => selectMcqAnswer(q.id, opt)}
            />
          ))}
        </div>
      )}

      {/* OEQ section */}
      {hasOeq && viewMode === "oeq" && (
        <div className="max-w-2xl mx-auto">
          <div className="bg-white">
            <AnswerCanvas
              key={currentOeqIdx}
              ref={(el) => { oeqCanvasHandles.current[currentOeqIdx] = el; }}
              tool={oeqTool}
              questionImageSrc={oeqQuestions[currentOeqIdx].imageData}
              onStrokeStart={() => {
                lastDrawnIdx.current = currentOeqIdx;
                setOeqHasInk(prev => {
                  const next = [...prev];
                  next[currentOeqIdx] = true;
                  return next;
                });
              }}
            />
          </div>
        </div>
      )}

      {/* Bottom bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 px-4 py-3 z-10">
        <div className="max-w-2xl mx-auto">
          {/* OEQ dots */}
          {hasOeq && viewMode === "oeq" && (
            <div className="flex justify-center gap-1.5 mb-3">
              {oeqQuestions.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setCurrentOeqIdx(i)}
                  className={`w-2.5 h-2.5 rounded-full transition-colors ${
                    i === currentOeqIdx ? "bg-primary-500" : oeqHasInk[i] ? "bg-green-400" : "bg-slate-200"
                  }`}
                />
              ))}
            </div>
          )}

          <div className="flex gap-3">
            {/* OEQ navigation */}
            {hasOeq && viewMode === "oeq" && (
              <>
                <button
                  onClick={() => setCurrentOeqIdx(i => Math.max(0, i - 1))}
                  disabled={currentOeqIdx === 0}
                  className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-600 font-medium hover:bg-slate-50 disabled:opacity-30 text-sm"
                >
                  Previous
                </button>
                <button
                  onClick={() => setCurrentOeqIdx(i => Math.min(oeqQuestions.length - 1, i + 1))}
                  disabled={currentOeqIdx === oeqQuestions.length - 1}
                  className="flex-1 py-2.5 rounded-xl bg-primary-600 text-white font-medium hover:bg-primary-700 disabled:opacity-30 text-sm"
                >
                  Next
                </button>
              </>
            )}

            {/* Submit button */}
            {(!hasOeq || viewMode === "mcq") && (
              <button
                onClick={handleSubmit}
                disabled={submitting}
                className="flex-1 py-2.5 rounded-xl bg-green-500 text-white font-medium hover:bg-green-600 disabled:opacity-50 text-sm"
              >
                {submitting ? "Submitting..." : "Submit Quiz"}
              </button>
            )}
            {hasOeq && viewMode === "oeq" && currentOeqIdx === oeqQuestions.length - 1 && (
              <button
                onClick={handleSubmit}
                disabled={submitting}
                className="flex-1 py-2.5 rounded-xl bg-green-500 text-white font-medium hover:bg-green-600 disabled:opacity-50 text-sm"
              >
                {submitting ? "Submitting..." : "Submit Quiz"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ────────────── MCQ Question Card ────────────── */

function McqQuestionCard({
  question,
  index,
  selected,
  onSelect,
}: {
  question: QuizQuestion;
  index: number;
  selected: string | null;
  onSelect: (option: string) => void;
}) {
  const options = question.transcribedOptions as string[] | null;
  const optionImages = question.transcribedOptionImages as string[] | null;
  const hasImageOptions = optionImages && optionImages.some(img => img);

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
      {/* Question number + stem */}
      <div className="mb-3">
        <span className="inline-block bg-primary-50 text-primary-700 text-xs font-bold px-2 py-0.5 rounded-lg mb-2">
          Q{index + 1}
        </span>
        {question.transcribedStem && (
          <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
            {question.transcribedStem}
          </p>
        )}
      </div>

      {/* Diagram */}
      {question.diagramImageData && (
        <div className="mb-3 flex justify-center">
          <img
            src={`data:image/jpeg;base64,${question.diagramImageData}`}
            alt="Diagram"
            className="max-h-48 rounded-lg border border-slate-100"
          />
        </div>
      )}

      {/* Options */}
      <div className="space-y-2">
        {hasImageOptions ? (
          // Image-based options
          [0, 1, 2, 3].map(i => {
            const optVal = String(i + 1);
            const isSelected = selected === optVal;
            const imgSrc = optionImages?.[i];
            return (
              <button
                key={i}
                onClick={() => onSelect(optVal)}
                className={`w-full flex items-center gap-3 p-2 rounded-xl border-2 transition-all ${
                  isSelected
                    ? "border-primary-500 bg-primary-50"
                    : "border-slate-100 hover:border-slate-200"
                }`}
              >
                <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                  isSelected ? "bg-primary-500 text-white" : "bg-slate-100 text-slate-500"
                }`}>
                  ({i + 1})
                </span>
                {imgSrc ? (
                  <img src={`data:image/jpeg;base64,${imgSrc}`} alt={`Option ${i + 1}`} className="max-h-16 rounded" />
                ) : (
                  <span className="text-sm text-slate-400">No image</span>
                )}
              </button>
            );
          })
        ) : (
          // Text-based options
          [0, 1, 2, 3].map(i => {
            const optVal = String(i + 1);
            const isSelected = selected === optVal;
            const text = options?.[i] ?? `Option ${i + 1}`;
            return (
              <button
                key={i}
                onClick={() => onSelect(optVal)}
                className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all text-left ${
                  isSelected
                    ? "border-primary-500 bg-primary-50"
                    : "border-slate-100 hover:border-slate-200"
                }`}
              >
                <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                  isSelected ? "bg-primary-500 text-white" : "bg-slate-100 text-slate-500"
                }`}>
                  ({i + 1})
                </span>
                <span className={`text-sm ${isSelected ? "text-primary-700 font-medium" : "text-slate-700"}`}>
                  {text}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ────────────── Answer Canvas (for OEQ) ────────────── */

const PEN_CURSOR =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='4'%3E%3Ccircle cx='2' cy='2' r='2' fill='%232563eb'/%3E%3C/svg%3E\") 2 2, crosshair";

interface AnswerCanvasHandle {
  exportImage(): Promise<Blob>;
  exportInk(): Promise<Blob>;
  undo(): void;
}

const AnswerCanvas = forwardRef<
  AnswerCanvasHandle,
  { tool: DrawTool; questionImageSrc: string; onStrokeStart: () => void }
>(function AnswerCanvas({ tool, questionImageSrc, onStrokeStart }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inkCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  const isDrawing = useRef(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const history = useRef<ImageData[]>([]);
  const pendingSnapshot = useRef<ImageData | null>(null);
  const snapshotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [canvasSize, setCanvasSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const img = new window.Image();
    img.onload = () => {
      bgImageRef.current = img;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      setCanvasSize({ w, h });
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d", { desynchronized: true })!.drawImage(img, 0, 0, w, h);
      }
      const inkCanvas = document.createElement("canvas");
      inkCanvas.width = w;
      inkCanvas.height = h;
      inkCanvasRef.current = inkCanvas;
    };
    img.src = questionImageSrc;
  }, [questionImageSrc]);

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
        const canvas = canvasRef.current;
        if (!canvas) { reject(new Error("Not ready")); return; }
        redrawComposite();
        canvas.toBlob(b => b ? resolve(b) : reject(new Error("Export failed")), "image/jpeg", 0.88);
      });
    },
    exportInk(): Promise<Blob> {
      return new Promise((resolve, reject) => {
        const inkCanvas = inkCanvasRef.current;
        if (!inkCanvas) { reject(new Error("Not ready")); return; }
        inkCanvas.toBlob(b => b ? resolve(b) : reject(new Error("Export failed")), "image/png");
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
    if (snapshotTimer.current) { clearTimeout(snapshotTimer.current); snapshotTimer.current = null; }
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

  const toolRef = useRef(tool);
  toolRef.current = tool;
  const onStrokeStartRef = useRef(onStrokeStart);
  onStrokeStartRef.current = onStrokeStart;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { desynchronized: true })!;

    function applyStyleVisible() {
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      if (toolRef.current === "eraser") {
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
      applyStyleVisible();
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, toolRef.current === "eraser" ? 12 : 1.5, 0, Math.PI * 2);
      ctx.fill();
      const inkCtx = inkCanvasRef.current?.getContext("2d");
      if (inkCtx) {
        applyStyleInk(inkCtx);
        inkCtx.beginPath();
        inkCtx.arc(pos.x, pos.y, toolRef.current === "eraser" ? 12 : 1.5, 0, Math.PI * 2);
        inkCtx.fill();
      }
      if (toolRef.current === "eraser") redrawComposite();
    }

    function handlePointerMove(e: PointerEvent) {
      if (!isDrawing.current || !lastPos.current) return;
      e.preventDefault();
      const pos = getPos(e.clientX, e.clientY);
      applyStyleVisible();
      ctx.beginPath();
      ctx.moveTo(lastPos.current.x, lastPos.current.y);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
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
      if (toolRef.current === "eraser") redrawComposite();
      scheduleSnapshotCapture();
    }

    function handleContextMenu(e: Event) { e.preventDefault(); }

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
