"use client";

import { Suspense, useEffect, useState, useRef, useImperativeHandle, forwardRef, use } from "react";
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
  transcribedSubparts: { label: string; text: string; diagramBase64?: string | null }[] | null;
  diagramImageData: string | null;
  marksAvailable: number | null;
  syllabusTopic: string | null;
}

interface QuizPaper {
  id: string;
  title: string;
  metadata: { quizType: "mcq" | "mcq-oeq"; sourceLabels?: Record<string, string | null> } | null;
  completedAt: string | null;
  markingStatus: string | null;
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

  // OEQ drawing
  const [tool, setTool] = useState<DrawTool>("pen");
  const oeqCanvasHandles = useRef<Record<string, AnswerCanvasHandle | null>>({});
  const lastDrawnId = useRef<string | null>(null);

  // Submission
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [mcqScore, setMcqScore] = useState<{ correct: number; total: number } | null>(null);
  const [markingOeq, setMarkingOeq] = useState(false);
  const [markingDone, setMarkingDone] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

      // Save MCQ answers to DB via PATCH
      await Promise.all(
        mcqQuestions.map(q =>
          fetch(`/api/exam/questions/${q.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              studentAnswer: mcqAnswers[q.id] || null,
              marksAwarded: mcqAnswers[q.id] === normalizeMcqAnswer(q.answer) ? (q.marksAvailable ?? 1) : 0,
            }),
          })
        )
      );

      // For MCQ+OEQ: save OEQ drawings (action "save" — don't trigger marking yet)
      if (hasOeq) {
        const form = new FormData();
        form.append("action", "save");
        for (let i = 0; i < oeqQuestions.length; i++) {
          const handle = oeqCanvasHandles.current[oeqQuestions[i].id];
          if (handle) {
            const [composite, ink] = await Promise.all([
              handle.exportImage(),
              handle.exportInk(),
            ]);
            // Save using sequential index so marking can find them
            form.append(`page_${i}`, composite, `page_${i}.jpg`);
            form.append(`page_${i}_ink`, ink, `page_${i}_ink.png`);
          }
        }
        await fetch(`/api/exam/${id}/submission`, { method: "POST", body: form });
      }

      // Save time and mark as completed
      await fetch(`/api/exam/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeSpentSeconds: elapsed, completedAt: new Date().toISOString() }),
      });

      // Trigger marking (handles both MCQ-only and MCQ+OEQ)
      await fetch(`/api/exam/${id}/mark`, { method: "POST" });
      if (hasOeq) setMarkingOeq(true);

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
                <p className="text-sm text-green-600 font-medium">Written answers have been marked!</p>
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

  // ─── Quiz taking view — single scrollable paper ───
  const answeredCount = Object.keys(mcqAnswers).length;

  return (
    <div className="min-h-screen bg-slate-50 pb-24 select-none" style={{ WebkitTouchCallout: "none", WebkitUserSelect: "none" }}>
      {/* Header */}
      <div className="bg-white border-b border-slate-100 px-4 py-3 flex items-center justify-between sticky top-0 z-20">
        <div className="min-w-0">
          <h1 className="text-sm font-bold text-slate-800 truncate">{paper.title}</h1>
          <p className="text-[11px] text-slate-400">
            {answeredCount} / {mcqQuestions.length} MCQ answered
            {hasOeq ? ` + ${oeqQuestions.length} written` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-3">
          {/* Drawing tools — only for MCQ+OEQ */}
          {hasOeq && (
            <div className="flex items-center gap-0.5 bg-slate-100 rounded-lg p-0.5">
              <button
                onClick={() => setTool("pen")}
                className={`p-1.5 rounded-md transition-colors ${tool === "pen" ? "bg-white text-blue-600 shadow-sm" : "text-slate-400"}`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
                </svg>
              </button>
              <button
                onClick={() => setTool("eraser")}
                className={`p-1.5 rounded-md transition-colors ${tool === "eraser" ? "bg-white text-red-500 shadow-sm" : "text-slate-400"}`}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
                  <path d="M22 21H7" /><path d="m5 11 9 9" />
                </svg>
              </button>
              <button
                onClick={() => { if (lastDrawnId.current) oeqCanvasHandles.current[lastDrawnId.current]?.undo(); }}
                className="p-1.5 rounded-md text-slate-400 hover:text-slate-600 transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 7v6h6" /><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
                </svg>
              </button>
            </div>
          )}
          <span className="text-xs font-mono text-slate-400 tabular-nums">{formatTime(elapsed)}</span>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="px-3 py-1 rounded-lg bg-green-500 text-white text-xs font-medium hover:bg-green-600 disabled:opacity-50"
          >
            {submitting ? "..." : "Submit"}
          </button>
        </div>
      </div>

      {/* Single scrollable paper */}
      <div className="max-w-2xl mx-auto px-4 py-4 space-y-4">
        {/* Section A: MCQ */}
        {mcqQuestions.length > 0 && (
          <>
            {hasOeq && (
              <div className="text-center">
                <h2 className="text-sm font-bold text-slate-600 uppercase tracking-wider">Section A: Multiple Choice</h2>
                <p className="text-xs text-slate-400">Select one answer for each question</p>
              </div>
            )}
            {mcqQuestions.map((q, idx) => (
              <McqQuestionCard
                key={q.id}
                question={q}
                index={idx}
                sourceLabel={paper?.metadata?.sourceLabels?.[q.questionNum] ?? null}
                selected={mcqAnswers[q.id] ?? null}
                onSelect={(opt) => selectMcqAnswer(q.id, opt)}
              />
            ))}
          </>
        )}

        {/* Section B: Written / OEQ */}
        {hasOeq && (
          <>
            <div className="text-center pt-4">
              <h2 className="text-sm font-bold text-slate-600 uppercase tracking-wider">Section B: Written Answers</h2>
              <p className="text-xs text-slate-400">Write your answers in the space provided</p>
            </div>
            {oeqQuestions.map((q, idx) => (
              <OeqQuestionCard
                key={q.id}
                question={q}
                index={mcqQuestions.length + idx}
                sourceLabel={paper?.metadata?.sourceLabels?.[q.questionNum] ?? null}
                tool={tool}
                onCanvasRef={(handle) => { oeqCanvasHandles.current[q.id] = handle; }}
                onStrokeStart={() => { lastDrawnId.current = q.id; }}
              />
            ))}
          </>
        )}

      </div>
    </div>
  );
}

/* ────────────── MCQ Question Card ────────────── */

function McqQuestionCard({
  question,
  index,
  sourceLabel,
  selected,
  onSelect,
}: {
  question: QuizQuestion;
  index: number;
  sourceLabel: string | null;
  selected: string | null;
  onSelect: (option: string) => void;
}) {
  const options = question.transcribedOptions as string[] | null;
  const optionImages = question.transcribedOptionImages as string[] | null;
  const hasImageOptions = optionImages && optionImages.some(img => img);

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
      {sourceLabel && (
        <p className="text-[10px] text-slate-400 mb-1">{sourceLabel}</p>
      )}
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

      {question.diagramImageData && (
        <div className="mb-3 flex justify-center">
          <img
            src={`data:image/jpeg;base64,${question.diagramImageData}`}
            alt="Diagram"
            className="w-full rounded-lg border border-slate-100"
          />
        </div>
      )}

      <div className="space-y-2">
        {hasImageOptions ? (
          <div className="grid grid-cols-2 gap-2">
          {[0, 1, 2, 3].map(i => {
            const optVal = String(i + 1);
            const isSelected = selected === optVal;
            const imgSrc = optionImages?.[i];
            return (
              <button
                key={i}
                onClick={() => onSelect(optVal)}
                className={`flex flex-col items-center gap-1 p-2 rounded-xl border-2 transition-all ${
                  isSelected ? "border-primary-500 bg-primary-50" : "border-slate-100 hover:border-slate-200"
                }`}
              >
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                  isSelected ? "bg-primary-500 text-white" : "bg-slate-100 text-slate-500"
                }`}>({i + 1})</span>
                {imgSrc ? (
                  <img src={`data:image/jpeg;base64,${imgSrc}`} alt={`Option ${i + 1}`} className="w-full rounded" />
                ) : (
                  <span className="text-sm text-slate-400">No image</span>
                )}
              </button>
            );
          })}
          </div>
        ) : (
          [0, 1, 2, 3].map(i => {
            const optVal = String(i + 1);
            const isSelected = selected === optVal;
            const text = options?.[i] ?? `Option ${i + 1}`;
            return (
              <button
                key={i}
                onClick={() => onSelect(optVal)}
                className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all text-left ${
                  isSelected ? "border-primary-500 bg-primary-50" : "border-slate-100 hover:border-slate-200"
                }`}
              >
                <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                  isSelected ? "bg-primary-500 text-white" : "bg-slate-100 text-slate-500"
                }`}>({i + 1})</span>
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

/* ────────────── OEQ Question Card ────────────── */

function OeqQuestionCard({
  question,
  index,
  sourceLabel,
  tool,
  onCanvasRef,
  onStrokeStart,
}: {
  question: QuizQuestion;
  index: number;
  sourceLabel: string | null;
  tool: DrawTool;
  onCanvasRef: (handle: AnswerCanvasHandle | null) => void;
  onStrokeStart: () => void;
}) {
  const allSubparts = question.transcribedSubparts as { label: string; text: string; diagramBase64?: string | null; refImageBase64?: string | null }[] | null;
  // rebuild ref image map from sentinels
  const subRefMap: Record<string, string> = {};
  if (allSubparts) for (const sp of allSubparts) if (sp.label.startsWith("_subref-")) subRefMap[sp.label.slice(8)] = sp.diagramBase64 ?? "";
  const subparts = allSubparts ? allSubparts.filter(sp => !sp.label.startsWith("_")).map(sp => ({ ...sp, refImageBase64: subRefMap[sp.label] ?? sp.refImageBase64 ?? null })) : null;
  const drawableDiagramBase64 = allSubparts?.find(sp => sp.label === "_drawable")?.diagramBase64 ?? null;
  const hasSubparts = subparts && subparts.length > 0;

  // For subparts: one canvas per subpart, stitched on export
  const subCanvasRefs = useRef<Record<string, AnswerCanvasHandle | null>>({});

  // Expose a combined handle that stitches all sub-canvases into one image
  useEffect(() => {
    if (!hasSubparts) return;
    const allLabels = subparts!.map(s => s.label);
    const combinedHandle: AnswerCanvasHandle = {
      async exportImage() {
        const blobs: Blob[] = [];
        for (const label of allLabels) {
          const h = subCanvasRefs.current[label];
          if (h) blobs.push(await h.exportImage());
        }
        return await stitchBlobs(blobs);
      },
      async exportInk() {
        const blobs: Blob[] = [];
        for (const label of allLabels) {
          const h = subCanvasRefs.current[label];
          if (h) blobs.push(await h.exportInk());
        }
        return await stitchBlobs(blobs);
      },
      undo() {
        for (let i = allLabels.length - 1; i >= 0; i--) {
          const h = subCanvasRefs.current[allLabels[i]];
          if (h) { h.undo(); break; }
        }
      },
    };
    onCanvasRef(combinedHandle);
    return () => onCanvasRef(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSubparts]);

  return (
    <div className="bg-white rounded-2xl border border-amber-200 shadow-sm overflow-hidden">
      {/* Question text */}
      <div className="p-4 pb-2">
        {sourceLabel && (
          <p className="text-[10px] text-slate-400 mb-1">{sourceLabel}</p>
        )}
        <span className="inline-block bg-amber-50 text-amber-700 text-xs font-bold px-2 py-0.5 rounded-lg mb-2">
          Q{index + 1}
        </span>
        {question.transcribedStem && (
          <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
            {question.transcribedStem}
          </p>
        )}

        {/* Diagram — show as static reference unless it's a draw-on-diagram question */}
        {question.diagramImageData && (
          <div className="mt-2 flex justify-center">
            <img
              src={`data:image/jpeg;base64,${question.diagramImageData}`}
              alt="Diagram"
              className="w-full rounded-lg border border-slate-100"
            />
          </div>
        )}

        {question.marksAvailable && (
          <p className="text-xs text-slate-400 mt-2 text-right">[{question.marksAvailable} mark{question.marksAvailable > 1 ? "s" : ""}]</p>
        )}
      </div>

      {/* Sub-parts with individual canvases */}
      {hasSubparts ? (
        <div>
          {subparts!.map(sp => (
            <div key={sp.label}>
              <div className="px-4 pt-2 pb-1">
                <p className="text-sm text-slate-700">
                  <span className="font-medium text-amber-700">({sp.label})</span> {sp.text}
                </p>
                {sp.refImageBase64 && (
                  <img
                    src={`data:image/jpeg;base64,${sp.refImageBase64}`}
                    alt={`(${sp.label}) diagram`}
                    className="mt-2 max-w-full rounded border border-slate-200"
                  />
                )}
              </div>
              <div className="border-t border-amber-100">
                <BlankCanvas
                  ref={(h) => { subCanvasRefs.current[sp.label] = h; }}
                  tool={tool}
                  onStrokeStart={onStrokeStart}
                  height={sp.diagramBase64 ? 300 : 200}
                  backgroundImage={sp.diagramBase64 ?? null}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="border-t border-amber-100">
          <BlankCanvas
            ref={onCanvasRef}
            tool={tool}
            onStrokeStart={onStrokeStart}
            height={drawableDiagramBase64 ? 320 : 250}
            backgroundImage={drawableDiagramBase64}
          />
        </div>
      )}
    </div>
  );
}

/** Stitch multiple image blobs vertically into one */
async function stitchBlobs(blobs: Blob[]): Promise<Blob> {
  if (blobs.length === 0) return new Blob([], { type: "image/jpeg" });
  if (blobs.length === 1) return blobs[0];

  const images = await Promise.all(blobs.map(b => {
    return new Promise<HTMLImageElement>((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.src = URL.createObjectURL(b);
    });
  }));

  const width = Math.max(...images.map(i => i.width));
  const totalHeight = images.reduce((sum, i) => sum + i.height, 0);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = totalHeight;
  const ctx = canvas.getContext("2d")!;
  let y = 0;
  for (const img of images) {
    ctx.drawImage(img, 0, y);
    y += img.height;
    URL.revokeObjectURL(img.src);
  }

  return new Promise<Blob>((resolve) => {
    canvas.toBlob(b => resolve(b!), "image/jpeg", 0.9);
  });
}

/* ────────────── Blank Canvas (for writing answers) ────────────── */

const PEN_CURSOR =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='4'%3E%3Ccircle cx='2' cy='2' r='2' fill='%232563eb'/%3E%3C/svg%3E\") 2 2, crosshair";

interface AnswerCanvasHandle {
  exportImage(): Promise<Blob>;
  exportInk(): Promise<Blob>;
  undo(): void;
}

const BlankCanvas = forwardRef<
  AnswerCanvasHandle,
  { tool: DrawTool; onStrokeStart: () => void; height: number; backgroundImage?: string | null }
>(function BlankCanvas({ tool, onStrokeStart, height, backgroundImage }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inkCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const bgImageRef = useRef<HTMLImageElement | null>(null);
  const isDrawing = useRef(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const history = useRef<ImageData[]>([]);
  const pendingSnapshot = useRef<ImageData | null>(null);
  const snapshotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ready, setReady] = useState(false);

  // Canvas dimensions: full width, fixed height
  const CANVAS_W = 800;
  const CANVAS_H = height * 2; // retina-ish

  function drawBackground(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    if (bgImageRef.current) {
      // Draw diagram centered, scaled to fit
      const img = bgImageRef.current;
      const scale = Math.min(CANVAS_W / img.width, CANVAS_H / img.height, 1);
      const w = img.width * scale;
      const h = img.height * scale;
      const x = (CANVAS_W - w) / 2;
      const y = (CANVAS_H - h) / 2;
      ctx.drawImage(img, x, y, w, h);
    } else {
      // Ruled lines
      ctx.strokeStyle = "#e2e8f0";
      ctx.lineWidth = 1;
      for (let y = 40; y < CANVAS_H; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(CANVAS_W, y);
        ctx.stroke();
      }
    }
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;

    const inkCanvas = document.createElement("canvas");
    inkCanvas.width = CANVAS_W;
    inkCanvas.height = CANVAS_H;
    inkCanvasRef.current = inkCanvas;

    function init() {
      const ctx = canvas!.getContext("2d", { desynchronized: true })!;
      drawBackground(ctx);
      setReady(true);
    }

    if (backgroundImage) {
      const img = new Image();
      img.onload = () => { bgImageRef.current = img; init(); };
      img.src = backgroundImage.startsWith("data:") ? backgroundImage : `data:image/jpeg;base64,${backgroundImage}`;
    } else {
      init();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [CANVAS_W, CANVAS_H, backgroundImage]);

  function redrawComposite() {
    const canvas = canvasRef.current;
    const inkCanvas = inkCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { desynchronized: true })!;
    ctx.globalCompositeOperation = "source-over";
    drawBackground(ctx);
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
    if (!ready) return;
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
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ touchAction: "none" }}>
      <canvas
        ref={canvasRef}
        className="w-full border-0"
        style={{
          height: `${height}px`,
          cursor: tool === "pen" ? PEN_CURSOR : "cell",
          touchAction: "none",
        }}
      />
    </div>
  );
});
