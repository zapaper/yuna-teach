"use client";

import { Suspense, useEffect, useState, useRef, useImperativeHandle, forwardRef, use } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import EnglishQuizSection from "@/components/EnglishQuizSection";

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
  studentAnswer: string | null;
}

interface QuizPaper {
  id: string;
  title: string;
  metadata: {
    quizType: "mcq" | "mcq-oeq";
    sourceLabels?: Record<string, string | null>;
    englishSections?: Array<{ label: string; startIndex: number; endIndex: number; passage?: string }>;
  } | null;
  completedAt: string | null;
  markingStatus: string | null;
  timeSpentSeconds: number;
  questions: QuizQuestion[];
  requesterIsAdmin?: boolean;
}

type DrawTool = "type" | "pen" | "eraser" | "eraser-large";

/* ────────────── helpers ────────────── */

function normalizeMcqAnswer(ans: string | null): string {
  if (!ans) return "";
  return ans.trim().replace(/[().]/g, "").trim();
}

/** Render __underline__ markup */
function renderUnderline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /__([^_]+)__/g;
  let lastIdx = 0;
  let m;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push(text.slice(lastIdx, m.index));
    parts.push(<span key={m.index} className="underline decoration-2">{m[1]}</span>);
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx === 0) return text;
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return <>{parts}</>;
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
  const isDiagnostic = searchParams.get("diagnostic") === "1";
  const diagnosticParentId = searchParams.get("parentId") ?? "";
  const [showDiagnosticModal, setShowDiagnosticModal] = useState(false);

  const [paper, setPaper] = useState<QuizPaper | null>(null);
  const [loading, setLoading] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // MCQ answers: questionId -> selected option (1-4)
  const [mcqAnswers, setMcqAnswers] = useState<Record<string, string>>({});

  // OEQ drawing
  const isEnglishQuiz = !!paper?.metadata?.englishSections;
  const [tool, setTool] = useState<DrawTool>("pen");
  const toolInitRef = useRef(false);
  if (isEnglishQuiz && !toolInitRef.current) { toolInitRef.current = true; setTool("type"); }
  const oeqCanvasHandles = useRef<Record<string, AnswerCanvasHandle | null>>({});
  const oeqSubpartHandles = useRef<Record<string, Record<string, AnswerCanvasHandle | null>>>({});
  const lastDrawnId = useRef<string | null>(null);
  const canvasHeights = useRef<Record<string, number>>({});

  // Submission
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [emptyFieldIds, setEmptyFieldIds] = useState<Set<string>>(new Set());
  const [mcqScore, setMcqScore] = useState<{ correct: number; total: number } | null>(null);
  const [markingOeq, setMarkingOeq] = useState(false);
  const [markingDone, setMarkingDone] = useState(false);
  const [savingProgress, setSavingProgress] = useState(false);
  const [progressSaved, setProgressSaved] = useState(false);
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Badge system
  const [badgePopup, setBadgePopup] = useState<{ badge: string; image: string; message: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/exam/${id}${userId ? `?userId=${userId}` : ""}`);
        if (!res.ok) throw new Error("Not found");
        const data = await res.json();
        setPaper(data);
        setElapsed(data.timeSpentSeconds || 0);
        // Load saved MCQ answers (progress recovery)
        const savedAnswers: Record<string, string> = {};
        for (const q of data.questions ?? []) {
          if (q.studentAnswer) savedAnswers[q.id] = q.studentAnswer;
        }
        if (Object.keys(savedAnswers).length > 0) setMcqAnswers(savedAnswers);
        // Load saved canvas heights
        const savedHeights = (data.metadata as { canvasHeights?: Record<string, number> } | null)?.canvasHeights;
        if (savedHeights) canvasHeights.current = savedHeights;
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
      <div className="flex justify-center py-24 bg-[#f8f9ff] min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-[#dce9ff] border-t-[#001e40]" />
      </div>
    );
  }
  if (!paper) {
    return <div className="p-6 text-center py-24"><p className="text-[#43474f]">Quiz not found</p></div>;
  }

  // Build set of question IDs handled by typed English sections (not OEQ canvasses)
  const typedSectionQIds = new Set<string>();
  if (paper.metadata?.englishSections) {
    for (const sec of paper.metadata.englishSections) {
      const label = sec.label.toLowerCase();
      const isTyped = label.includes("grammar cloze") || label.includes("editing") ||
        label.includes("comprehension cloze") || (label.includes("comp") && label.includes("cloze")) ||
        label.includes("visual text") || label.includes("synthesis") ||
        label.includes("comprehension oeq") || label.includes("comp oeq") || label.includes("comprehension open");
      if (isTyped) {
        for (let i = sec.startIndex; i <= sec.endIndex; i++) {
          if (paper.questions[i]) typedSectionQIds.add(paper.questions[i].id);
        }
      }
    }
  }

  const mcqQuestions = paper.questions.filter(q => isMcq(q.answer));
  const oeqQuestions = paper.questions.filter(q => !isMcq(q.answer) && !typedSectionQIds.has(q.id));
  const hasOeq = oeqQuestions.length > 0;

  function selectMcqAnswer(questionId: string, option: string) {
    setMcqAnswers(prev => ({ ...prev, [questionId]: option }));
  }

  async function handleSaveProgress() {
    if (savingProgress) return;
    setSavingProgress(true);
    try {
      // Save all answers (MCQ + typed sections like cloze/editing)
      const questionsWithAnswers = (paper?.questions ?? []).filter(q => mcqAnswers[q.id]);
      await Promise.all(
        questionsWithAnswers.map(q =>
          fetch(`/api/exam/questions/${q.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ studentAnswer: mcqAnswers[q.id] }),
          })
        )
      );

      // Save OEQ drawings (all questions with canvas handles)
      const saveOeqQs = (paper?.questions ?? []).filter(q => oeqCanvasHandles.current[q.id]);
      if (saveOeqQs.length > 0) {
        const form = new FormData();
        form.append("action", "save");
        for (let i = 0; i < saveOeqQs.length; i++) {
          const q = saveOeqQs[i];
          const handle = oeqCanvasHandles.current[q.id];
          if (handle) {
            const [composite, ink] = await Promise.all([handle.exportImage(), handle.exportInk()]);
            form.append(`page_${i}`, composite, `page_${i}.jpg`);
            form.append(`page_${i}_ink`, ink, `page_${i}_ink.png`);
          }
          const spRefs = oeqSubpartHandles.current[q.id];
          if (spRefs) {
            for (const [label, spHandle] of Object.entries(spRefs)) {
              if (spHandle) {
                const [spComposite, spInk] = await Promise.all([spHandle.exportImage(), spHandle.exportInk()]);
                form.append(`page_${i}_${label}`, spComposite, `page_${i}_${label}.jpg`);
                form.append(`page_${i}_${label}_ink`, spInk, `page_${i}_${label}_ink.png`);
              }
            }
          }
        }
        await fetch(`/api/exam/${id}/submission`, { method: "POST", body: form });
      }

      // Save elapsed time + canvas heights
      const existingMeta = paper?.metadata ?? {};
      await fetch(`/api/exam/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          timeSpentSeconds: elapsed,
          metadata: { ...existingMeta, canvasHeights: canvasHeights.current },
        }),
      });

      setProgressSaved(true);
      setTimeout(() => setProgressSaved(false), 2000);
    } catch {
      alert("Failed to save progress");
    } finally {
      setSavingProgress(false);
    }
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

      // Save & score typed section answers
      // Simple comparison: Grammar Cloze, Editing, Comp Cloze
      // AI marking needed: Synthesis, Comp OEQ (just save answer, let markQuizPaper handle)
      const aiMarkSectionLabels = new Set<string>();
      if (paper!.metadata?.englishSections) {
        for (const sec of (paper!.metadata.englishSections as Array<{ label: string; startIndex: number; endIndex: number }>)) {
          const l = sec.label.toLowerCase();
          if (l.includes("synthesis") || l.includes("comprehension oeq") || l.includes("comp oeq") || l.includes("comprehension open")) {
            for (let i = sec.startIndex; i <= sec.endIndex; i++) {
              if (paper!.questions[i]) aiMarkSectionLabels.add(paper!.questions[i].id);
            }
          }
        }
      }
      const simpleCompareQs = paper!.questions.filter(q => typedSectionQIds.has(q.id) && !aiMarkSectionLabels.has(q.id) && !isMcq(q.answer));
      const aiMarkQs = paper!.questions.filter(q => aiMarkSectionLabels.has(q.id));

      if (simpleCompareQs.length > 0) {
        await Promise.all(
          simpleCompareQs.map(q => {
            const isGrammarClozeQ = (q.syllabusTopic ?? "").toLowerCase().includes("grammar") && (q.syllabusTopic ?? "").toLowerCase().includes("cloze");
            const studentAns = (mcqAnswers[q.id] ?? "").trim();
            const studentCmp = studentAns.toUpperCase();
            const correctCmp = (q.answer ?? "").trim().toUpperCase();
            // Accept any slash-separated alternative (e.g., "tempted/enticed/inclined")
            const acceptableAnswers = correctCmp.split("/").map(a => a.trim());
            const isCorrect = studentCmp !== "" && acceptableAnswers.includes(studentCmp);
            return fetch(`/api/exam/questions/${q.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                studentAnswer: (isGrammarClozeQ ? studentAns.toUpperCase() : studentAns) || null,
                marksAwarded: isCorrect ? (q.marksAvailable ?? 1) : 0,
                markingNotes: studentAns ? (isCorrect ? "Correct" : `Wrong. Student: "${studentAns}", Correct: "${correctCmp}"`) : "No answer",
              }),
            });
          })
        );
      }
      // Save typed answers for AI-marked sections (synthesis, comp OEQ)
      if (aiMarkQs.length > 0) {
        await Promise.all(
          aiMarkQs.map(q => {
            const studentAns = (mcqAnswers[q.id] ?? "").trim();
            return fetch(`/api/exam/questions/${q.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ studentAnswer: studentAns || null }),
            });
          })
        );
      }

      // Save ALL OEQ drawings (including inline synthesis/comp OEQ sections)
      const allOeqWithHandles = paper!.questions.filter(q => oeqCanvasHandles.current[q.id]);
      if (allOeqWithHandles.length > 0) {
        const form = new FormData();
        form.append("action", "save");
        for (let i = 0; i < allOeqWithHandles.length; i++) {
          const q = allOeqWithHandles[i];
          const handle = oeqCanvasHandles.current[q.id];
          if (handle) {
            const [composite, ink] = await Promise.all([
              handle.exportImage(),
              handle.exportInk(),
            ]);
            // Save combined image
            form.append(`page_${i}`, composite, `page_${i}.jpg`);
            form.append(`page_${i}_ink`, ink, `page_${i}_ink.png`);
          }
          // Save individual subpart images
          const spRefs = oeqSubpartHandles.current[q.id];
          if (spRefs) {
            for (const [label, spHandle] of Object.entries(spRefs)) {
              if (spHandle) {
                const [spComposite, spInk] = await Promise.all([
                  spHandle.exportImage(),
                  spHandle.exportInk(),
                ]);
                form.append(`page_${i}_${label}`, spComposite, `page_${i}_${label}.jpg`);
                form.append(`page_${i}_${label}_ink`, spInk, `page_${i}_${label}_ink.png`);
              }
            }
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
      // Start polling if there are AI-marked questions (OEQ canvas or typed synthesis/comp OEQ)
      const hasAiMarking = hasOeq || (isEnglishQuiz && paper!.questions.some(q => {
        const t = (q.syllabusTopic ?? "").toLowerCase();
        return t.includes("synthesis") || (t.includes("comprehension") && (t.includes("open") || t.includes("oeq")));
      }));
      if (hasAiMarking) setMarkingOeq(true);

      // Check for badge milestone
      try {
        const badgeRes = await fetch(`/api/user/${userId}/quiz-badge`);
        if (badgeRes.ok) {
          const badgeData = await badgeRes.json();
          if (badgeData.newBadge) setBadgePopup(badgeData.newBadge);
        }
      } catch { /* badge check is non-critical */ }

      setSubmitted(true);
      if (isDiagnostic) setShowDiagnosticModal(true);
    } finally {
      setSubmitting(false);
    }
  }

  // ─── Post-submission view ───
  if (submitted) {
    return (
      <div className="min-h-screen bg-[#f8f9ff] flex items-center justify-center p-6">
        <div className="bg-white rounded-3xl shadow-xl max-w-md w-full p-10 text-center">
          <div className="w-20 h-20 rounded-full bg-[#6cf8bb]/30 flex items-center justify-center mx-auto mb-6">
            <span className="material-symbols-outlined text-4xl text-[#006c49]" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
          </div>
          <h2 className="font-headline text-2xl font-extrabold text-[#001e40] mb-1">Quiz Complete!</h2>
          <p className="text-sm text-[#43474f] mb-6">Time: {formatTime(elapsed)}</p>

          {mcqScore && mcqScore.total > 0 && (
            <div className="bg-[#eff4ff] rounded-2xl p-6 mb-4">
              <p className="text-xs font-extrabold uppercase tracking-widest text-[#43474f] mb-2">MCQ Score</p>
              <p className="font-headline text-5xl font-black text-[#001e40]">{mcqScore.correct}<span className="text-2xl font-bold text-[#43474f]"> / {mcqScore.total}</span></p>
              <p className="text-sm font-bold text-[#006c49] mt-2">{Math.round((mcqScore.correct / mcqScore.total) * 100)}%</p>
            </div>
          )}

          {markingOeq && (
            markingDone ? (
              <div className="bg-[#6cf8bb]/20 rounded-2xl p-4 mb-4 flex items-center gap-3">
                <span className="material-symbols-outlined text-[#006c49]" style={{ fontVariationSettings: "'FILL' 1" }}>task_alt</span>
                <p className="text-sm font-semibold text-[#006c49]">All answers marked!</p>
              </div>
            ) : (
              <div className="bg-[#eff4ff] rounded-2xl p-4 mb-4 flex items-center gap-3">
                <div className="animate-spin rounded-full h-5 w-5 border-2 border-[#dce9ff] border-t-[#003366] shrink-0" />
                <p className="text-sm text-[#43474f]">AI is marking your answers…</p>
              </div>
            )
          )}

          <div className="flex gap-3 mt-6">
            <button
              onClick={() => router.push(`/exam/${id}/review?userId=${userId}`)}
              disabled={markingOeq && !markingDone}
              className="flex-1 px-4 py-3 rounded-2xl bg-[#001e40] text-white font-bold text-sm hover:bg-[#003366] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {markingOeq && !markingDone ? "Marking in progress…" : "Review Answers"}
            </button>
            <button
              onClick={() => router.push(`/home/${userId}`)}
              className="flex-1 px-4 py-3 rounded-2xl bg-[#eff4ff] text-[#001e40] font-bold text-sm hover:bg-[#dce9ff] transition-colors"
            >
              Home
            </button>
          </div>
        </div>

        {/* Badge milestone popup */}
        {badgePopup && !showDiagnosticModal && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
            onClick={() => setBadgePopup(null)}>
            <div className="bg-white rounded-3xl max-w-sm w-full p-6 shadow-2xl text-center"
              onClick={e => e.stopPropagation()}>
              <div className="relative mx-auto w-28 h-28 mb-4">
                <div className="absolute inset-0 animate-ping rounded-full bg-yellow-200 opacity-30" />
                <img src={badgePopup.image} alt={badgePopup.badge} className="relative w-28 h-28 object-contain drop-shadow-lg" />
              </div>
              <h2 className="font-headline text-xl font-extrabold text-[#001e40] mb-2">Congratulations!</h2>
              <p className="text-sm text-[#43474f] leading-relaxed mb-5">{badgePopup.message}</p>
              <button
                onClick={() => setBadgePopup(null)}
                className="px-6 py-2.5 rounded-2xl bg-[#001e40] text-white font-bold hover:bg-[#003366] transition-colors"
              >
                Awesome!
              </button>
            </div>
          </div>
        )}

        {/* Diagnostic quiz completion modal */}
        {showDiagnosticModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
            style={{ background: "rgba(11,28,48,0.4)", backdropFilter: "blur(4px)" }}
          >
            <div className="w-full max-w-md rounded-lg overflow-hidden flex flex-col"
              style={{ background: "#ffffff", boxShadow: "0 20px 40px rgba(11,28,48,0.06)" }}
            >
              {/* Header */}
              <div className="px-6 pt-8 pb-4 flex flex-col items-center text-center">
                <div className="mb-4 w-12 h-12 rounded-full flex items-center justify-center relative"
                  style={{ background: "#d3e4fe" }}
                >
                  <span className="material-symbols-outlined text-2xl" style={{ color: "#003366", fontVariationSettings: "'FILL' 1" }}>
                    notifications
                  </span>
                  <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full"
                    style={{ background: "#006c49", border: "2px solid #ffffff" }}
                  />
                </div>
                <h3 className="text-xl font-extrabold tracking-tight" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", color: "#0b1c30" }}>
                  Congratulations!
                </h3>
              </div>

              {/* Body */}
              <div className="px-8 pb-8 text-center">
                <p className="leading-relaxed" style={{ color: "#43474f", fontSize: "15px" }}>
                  Congratulations on finishing your first diagnostic quiz. Let&apos;s open a new tab for the parent&apos;s homepage to see the diagnostics.
                </p>
              </div>

              {/* Action */}
              <div className="px-8 pb-8">
                <button
                  onClick={() => {
                    setShowDiagnosticModal(false);
                    if (diagnosticParentId) {
                      window.open(`/home/${diagnosticParentId}?diagnosticWelcome=1`, "_blank");
                    }
                  }}
                  className="w-full py-4 px-6 text-white font-bold rounded-lg transition-all duration-200 active:scale-95 flex items-center justify-center gap-2"
                  style={{
                    fontFamily: "'Plus Jakarta Sans', sans-serif",
                    background: "linear-gradient(to right, #001e40, #003366)",
                    boxShadow: "0 4px 12px rgba(0,30,64,0.15)",
                  }}
                >
                  Go parent&apos;s homepage
                  <span className="material-symbols-outlined text-sm">arrow_forward</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ─── Quiz taking view — single scrollable paper ───
  const answeredCount = Object.keys(mcqAnswers).length;

  return (
    <div className="min-h-screen bg-[#f8f9ff] pb-24 select-none" style={{ WebkitTouchCallout: "none", WebkitUserSelect: "none" }}>
      {/* ── Mobile Top Bar (floating pill) ── */}
      <header className="lg:hidden fixed top-0 w-full z-50 px-6 py-4 flex justify-center bg-[#f8f9ff]/80 backdrop-blur-md">
        <div className="bg-white/90 backdrop-blur-xl rounded-full px-2 py-1.5 flex items-center gap-0.5 shadow-lg border border-white/30">
          {isEnglishQuiz && (
            <button
              onClick={() => setTool("type")}
              className={`flex items-center gap-1.5 px-3 py-2.5 rounded-full transition-all font-headline font-bold text-sm ${tool === "type" ? "bg-[#eff4ff] text-[#001e40]" : "text-[#43474f]"}`}
            >
              <span className="material-symbols-outlined text-xl">keyboard</span>
              <span>Type</span>
            </button>
          )}
          <button
            onClick={() => setTool("pen")}
            className={`flex items-center gap-1.5 px-3 py-2.5 rounded-full transition-all font-headline font-bold text-sm ${tool === "pen" ? "bg-[#eff4ff] text-[#001e40]" : "text-[#43474f]"}`}
          >
            <span className="material-symbols-outlined text-xl">edit</span>
            <span>Draw</span>
          </button>
          <button
            onClick={() => setTool(tool === "eraser" ? "eraser-large" : tool === "eraser-large" ? "eraser" : "eraser")}
            className={`p-3 rounded-full transition-colors ${tool === "eraser" || tool === "eraser-large" ? "bg-[#eff4ff] text-[#001e40]" : "text-[#737780]"} hover:text-[#001e40]`}
          >
            <span className={`material-symbols-outlined ${tool === "eraser-large" ? "text-3xl" : "text-xl"}`}>ink_eraser</span>
          </button>
          <button
            onClick={() => { if (lastDrawnId.current) oeqCanvasHandles.current[lastDrawnId.current]?.undo(); }}
            className="p-3 rounded-full text-[#737780] hover:text-[#001e40] transition-colors"
          >
            <span className="material-symbols-outlined text-xl">undo</span>
          </button>
          <button
            onClick={handleSaveProgress}
            disabled={savingProgress}
            className="flex items-center gap-1.5 bg-white text-[#003366] border border-[#003366]/20 rounded-full px-4 py-3 font-headline font-bold text-sm hover:bg-[#eff4ff] transition-colors disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-lg">save</span>
            {savingProgress ? "…" : progressSaved ? "✓ Saved" : "Save"}
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="flex items-center gap-1.5 bg-[#003366] text-white rounded-full px-5 py-3 ml-1 font-headline font-bold text-sm hover:scale-105 transition-transform disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-xl" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
            {submitting ? "…" : "Submit"}
          </button>
        </div>
      </header>

      {/* ── Desktop Top App Bar ── */}
      <header className="hidden lg:flex fixed top-0 left-0 w-full z-50 items-center justify-between px-6 py-3 bg-[#f8f9ff] shadow-sm">
        <div className="flex items-center gap-6">
          <h1 className="font-headline text-lg font-bold text-[#001e40]">QuizWorkspace</h1>
          <div className="h-6 w-px bg-[#c3c6d1]/40" />
          <div className="flex items-center gap-4">
            <span className="font-headline text-sm font-semibold text-[#001e40]">{paper.title}</span>
            {mcqQuestions.length > 0 && !isEnglishQuiz && (
              <span className="px-3 py-1 bg-[#dce9ff] rounded-full font-label text-xs font-bold text-[#001e40]">
                {answeredCount} / {mcqQuestions.length} MCQ
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-4">
          {/* Drawing tools */}
          <div className="flex items-center bg-[#eff4ff] rounded-lg p-1 border border-[#c3c6d1]/10">
            {isEnglishQuiz && (
              <button
                onClick={() => setTool("type")}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md transition-colors font-headline text-[10px] uppercase tracking-wider font-bold ${tool === "type" ? "bg-[#003366]/20 text-[#001e40]" : "text-[#737780]"}`}
              >
                <span className="material-symbols-outlined text-xl">keyboard</span>
                Type
              </button>
            )}
            <button
              onClick={() => setTool("pen")}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md transition-colors font-headline text-[10px] uppercase tracking-wider font-bold ${tool === "pen" ? "bg-[#003366]/20 text-[#001e40]" : "text-[#737780]"}`}
            >
              <span className="material-symbols-outlined text-xl">edit</span>
              Pen
            </button>
            <button
              onClick={() => setTool(tool === "eraser" ? "eraser-large" : tool === "eraser-large" ? "eraser" : "eraser")}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md transition-colors font-headline text-[10px] uppercase tracking-wider font-bold ${tool === "eraser" || tool === "eraser-large" ? "bg-[#003366]/20 text-[#001e40]" : "text-[#737780]"}`}
            >
              <span className={`material-symbols-outlined ${tool === "eraser-large" ? "text-3xl" : "text-xl"}`}>ink_eraser</span>
              {tool === "eraser-large" ? "Big Erase" : "Erase"}
            </button>
            <button
              onClick={() => { if (lastDrawnId.current) oeqCanvasHandles.current[lastDrawnId.current]?.undo(); }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[#737780] hover:bg-[#dce9ff] transition-colors font-headline text-[10px] uppercase tracking-wider font-bold"
            >
              <span className="material-symbols-outlined text-xl">undo</span>
              Undo
            </button>
          </div>
          <div className="h-8 w-px bg-[#c3c6d1]/20 mx-1" />
          <div className="flex items-center gap-2 px-4 py-1.5 bg-[#eff4ff] rounded-lg">
            <span className="material-symbols-outlined text-[#001e40] text-lg">timer</span>
            <span className="font-headline font-bold text-[#001e40] tabular-nums">{formatTime(elapsed)}</span>
          </div>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="bg-[#001e40] text-white px-6 py-2 rounded-lg font-headline font-bold text-sm hover:scale-95 active:scale-90 transition-transform shadow-md disabled:opacity-50"
          >
            {submitting ? "…" : "Submit"}
          </button>
          <button
            onClick={handleSaveProgress}
            disabled={savingProgress}
            className="bg-white text-[#003366] border border-[#003366]/20 px-4 py-2 rounded-lg font-headline font-bold text-sm hover:bg-[#eff4ff] transition-colors disabled:opacity-50"
          >
            {savingProgress ? "Saving…" : progressSaved ? "✓ Saved" : "Save Progress"}
          </button>
        </div>
      </header>

      {/* Single scrollable paper */}
      <div className="pt-24 pb-8 max-w-4xl mx-auto px-4 lg:px-16">

        {/* Mobile progress bar */}
        {mcqQuestions.length > 0 && !isEnglishQuiz && (
          <div className="lg:hidden mb-8">
            <div className="flex justify-between items-end mb-3">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-widest text-[#43474f] opacity-70">Progress</span>
                <h2 className="font-headline text-2xl font-extrabold text-[#001e40]">{answeredCount} / {mcqQuestions.length} MCQ</h2>
              </div>
              <span className="font-headline font-bold text-[#001e40] tabular-nums text-sm flex items-center gap-1">
                <span className="material-symbols-outlined text-base">timer</span>
                {formatTime(elapsed)}
              </span>
            </div>
            <div className="h-3 w-full bg-[#dce9ff] rounded-full overflow-hidden">
              <div className="h-full bg-gradient-to-r from-[#006c49] to-[#4edea3] rounded-full transition-all duration-500"
                style={{ width: `${mcqQuestions.length > 0 ? (answeredCount / mcqQuestions.length) * 100 : 0}%` }} />
            </div>
          </div>
        )}

        {/* Questions — English sections or standard MCQ */}
        {(mcqQuestions.length > 0 || paper.metadata?.englishSections) && (
          <>
            {paper.metadata?.englishSections ? (
              // English quiz: render sections by type
              <>
                {paper.metadata.englishSections.map((sec, si) => {
                  // Get ALL questions for this section (not just MCQ)
                  const secQuestions = paper.questions.slice(sec.startIndex, sec.endIndex + 1);
                  if (secQuestions.length === 0) return null;

                  const label = sec.label.toLowerCase();
                  const isGrammarCloze = label.includes("grammar cloze");
                  const isEditing = label.includes("editing");
                  const isCompCloze = label.includes("comprehension cloze") || (label.includes("comp") && label.includes("cloze"));
                  const isVisualText = label.includes("visual text");
                  const isSynthesis = label.includes("synthesis");
                  const isCompOeq = label.includes("comprehension oeq") || label.includes("comp oeq") || label.includes("comprehension open");
                  const isTypedSection = isGrammarCloze || isEditing || isCompCloze || isVisualText;

                  if (isTypedSection) {
                    return (
                      <EnglishQuizSection
                        key={si}
                        sectionLabel={sec.label}
                        passage={sec.passage ?? null}
                        questions={secQuestions}
                        sectionType={isGrammarCloze ? "grammar-cloze" : isEditing ? "editing" : isCompCloze ? "comprehension-cloze" : "visual-text-mcq"}
                        answers={mcqAnswers}
                        onAnswer={selectMcqAnswer}
                        tool={tool}
                        onToolChange={(t) => setTool(t)}
                        emptyFieldIds={emptyFieldIds}
                        flaggedIds={flaggedIds}
                        onToggleFlag={(qId) => setFlaggedIds(prev => { const n = new Set(prev); n.has(qId) ? n.delete(qId) : n.add(qId); return n; })}
                      />
                    );
                  }

                  // Synthesis / Comp OEQ: typed answer sections
                  if (isSynthesis || isCompOeq) {
                    return (
                      <EnglishQuizSection
                        key={si}
                        sectionLabel={sec.label}
                        passage={sec.passage ?? null}
                        questions={secQuestions}
                        sectionType={isSynthesis ? "synthesis" : "comprehension-oeq"}
                        answers={mcqAnswers}
                        onAnswer={selectMcqAnswer}
                        tool={tool}
                        onToolChange={(t) => setTool(t)}
                        emptyFieldIds={emptyFieldIds}
                        flaggedIds={flaggedIds}
                        onToggleFlag={(qId) => setFlaggedIds(prev => { const n = new Set(prev); n.has(qId) ? n.delete(qId) : n.add(qId); return n; })}
                      />
                    );
                  }

                  // Standard MCQ section (Grammar MCQ, Vocab MCQ, Vocab Cloze MCQ)
                  return (
                    <div key={si} className="mb-12">
                      <div className="mb-8 mt-4">
                        <h2 className="font-headline text-xl lg:text-2xl font-extrabold text-[#001e40] tracking-tight">{sec.label.toUpperCase()}</h2>
                        <p className="text-[#737780] mt-1 text-sm">Choose the most appropriate answer for each question.</p>
                      </div>

                      {/* Vocab Cloze passage — rich text with formatted blanks */}
                      {sec.passage && !sec.passage.startsWith("[") && !sec.passage.startsWith("data:") && (
                        <div className="bg-[#eff4ff] rounded-2xl p-5 lg:p-8 mb-6 border border-[#d3e4fe]">
                          {sec.passage.split("\n").map((line, li) => {
                            if (!line.trim()) return <br key={li} />;
                            // Skip table separators
                            if (line.match(/^\s*\|[\s-:|]+\|\s*$/)) return null;
                            // Table rows
                            if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
                              const cells = line.trim().replace(/\|\s*$/, "|").split("|").slice(1, -1).map(c => c.trim());
                              return (
                                <div key={li} className="flex gap-2 my-1">
                                  {cells.map((cell, ci) => (
                                    <span key={ci} className="flex-1 text-center text-xs font-medium text-[#001e40] bg-white/60 rounded px-2 py-1">{cell}</span>
                                  ))}
                                </div>
                              );
                            }
                            // Rich text: replace **(N)text** with styled blanks
                            const parts: React.ReactNode[] = [];
                            const regex = /\*\*\((\d+)\)([^*]*)\*\*/g;
                            let lastIdx2 = 0;
                            let m;
                            while ((m = regex.exec(line)) !== null) {
                              if (m.index > lastIdx2) parts.push(<span key={`t${lastIdx2}`}>{renderUnderline(line.slice(lastIdx2, m.index))}</span>);
                              const qNum = m[1];
                              parts.push(
                                <span key={`q${qNum}`} className="inline-flex items-center gap-0.5 mx-0.5">
                                  <span className="text-[10px] font-bold text-blue-700 bg-blue-100 px-1 rounded">({qNum})</span>
                                  <span className="border-b-2 border-[#001e40]/30 px-2 text-sm">________</span>
                                </span>
                              );
                              lastIdx2 = m.index + m[0].length;
                            }
                            if (lastIdx2 < line.length) parts.push(<span key="end">{renderUnderline(line.slice(lastIdx2))}</span>);
                            const indent = line.match(/^(\s{2,}|\t)/);
                            return (
                              <p key={li} className="leading-relaxed text-base text-[#001e40] my-1" style={indent ? { textIndent: "2em" } : undefined}>
                                {parts.length > 0 ? parts : line}
                              </p>
                            );
                          })}
                        </div>
                      )}
                      {sec.passage && label.includes("vocab") && label.includes("cloze") && (
                        <p className="text-sm text-[#737780] mb-6 italic">Which word best completes the blanks?</p>
                      )}

                      <div className="space-y-10">
                        {secQuestions.filter(q => isMcq(q.answer)).map((q, idx) => (
                          <McqQuestionCard
                            key={q.id}
                            question={q}
                            index={sec.startIndex + idx}
                            selected={mcqAnswers[q.id] ?? null}
                            onSelect={(opt) => selectMcqAnswer(q.id, opt)}
                            flagged={flaggedIds.has(q.id)}
                            onToggleFlag={() => setFlaggedIds(prev => { const n = new Set(prev); n.has(q.id) ? n.delete(q.id) : n.add(q.id); return n; })}
                            tool={tool}
                            hideScratchPad
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </>
            ) : (
              // Non-English: standard section
              <>
                <div className="hidden lg:block mb-10 mt-4">
                  <h2 className="font-headline text-2xl lg:text-3xl font-extrabold text-[#001e40] tracking-tight">SECTION A: MULTIPLE CHOICE</h2>
                  <p className="text-[#737780] mt-1 text-sm">Choose the most appropriate answer for each question.</p>
                </div>
                <div className="space-y-10">
                  {mcqQuestions.map((q, idx) => (
                    <McqQuestionCard
                      key={q.id}
                      question={q}
                      index={idx}
                      selected={mcqAnswers[q.id] ?? null}
                      onSelect={(opt) => selectMcqAnswer(q.id, opt)}
                      flagged={flaggedIds.has(q.id)}
                      onToggleFlag={() => setFlaggedIds(prev => { const n = new Set(prev); n.has(q.id) ? n.delete(q.id) : n.add(q.id); return n; })}
                    />
              ))}
            </div>
          </>
            )}
          </>
        )}

        {/* Section B: Written / OEQ */}
        {hasOeq && (
          <>
            <div className={`hidden lg:block mb-10 ${mcqQuestions.length > 0 ? "mt-16" : "mt-4"}`}>
              <h2 className="font-headline text-3xl font-extrabold text-[#001e40] tracking-tight">SECTION B: WRITTEN ANSWERS</h2>
              <p className="text-[#737780] mt-1 text-sm">Show all workings clearly. Partial marks may be awarded for correct methodology.</p>
              <p className="text-[#737780] mt-1 text-xs italic">For Apple users: turn on &quot;Draw with Apple Pencil&quot; and turn off &quot;Scribble&quot; for smooth writing.</p>
            </div>
            <p className="lg:hidden text-[#737780] text-xs italic mb-4 px-1">For Apple users: turn on &quot;Draw with Apple Pencil&quot; and turn off &quot;Scribble&quot; for smooth writing.</p>
            <div className="space-y-12">
              {oeqQuestions.map((q, idx) => (
                <OeqQuestionCard
                  key={q.id}
                  question={q}
                  index={mcqQuestions.length + idx}
                  tool={tool}
                  onCanvasRef={(handle) => { oeqCanvasHandles.current[q.id] = handle; }}
                  onSubpartRefs={(refs) => { oeqSubpartHandles.current[q.id] = refs; }}
                  onStrokeStart={() => { lastDrawnId.current = q.id; }}
                  paperId={id}
                  oeqIndex={idx}
                  savedHeights={canvasHeights.current}
                  onHeightChange={(cid, h) => { canvasHeights.current[cid] = h; }}
                  flagged={flaggedIds.has(q.id)}
                  onToggleFlag={() => setFlaggedIds(prev => { const n = new Set(prev); n.has(q.id) ? n.delete(q.id) : n.add(q.id); return n; })}
                />
              ))}
            </div>
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
  selected,
  onSelect,
  hideStem,
  flagged,
  onToggleFlag,
  tool = "pen",
  hideScratchPad,
}: {
  question: QuizQuestion;
  index: number;
  selected: string | null;
  onSelect: (option: string) => void;
  hideStem?: boolean;
  flagged?: boolean;
  onToggleFlag?: () => void;
  tool?: DrawTool;
  hideScratchPad?: boolean;
}) {
  const options = question.transcribedOptions as string[] | null;
  const optionImages = question.transcribedOptionImages as string[] | null;
  const hasImageOptions = optionImages && optionImages.some(img => img);

  const numStr = String(index + 1).padStart(2, "0");

  return (
    /* Desktop: relative with big background number; mobile: simple card */
    <article className="relative group">
      {/* Card */}
      <div className="bg-white lg:rounded-xl rounded-3xl shadow-sm lg:shadow-[0_20px_40px_rgba(11,28,48,0.04)] overflow-hidden transition-all hover:shadow-lg relative">
        {/* Mobile: left accent bar */}
        <div className="lg:hidden absolute top-0 left-0 w-1 h-full bg-[#003366]" />

        <div className="p-5 lg:p-8">
          <div className="flex items-center gap-2 mb-3 lg:mb-5">
            <span className="font-headline font-bold text-sm text-[#001e40]">
              Question {numStr}
            </span>
            {onToggleFlag && (
              <button onClick={onToggleFlag} className={`flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded-md transition-colors ${flagged ? "text-[#ba1a1a] bg-red-50" : "text-[#737780] hover:text-[#ba1a1a] hover:bg-red-50"}`}>
                <span className="material-symbols-outlined text-sm" style={flagged ? { fontVariationSettings: "'FILL' 1" } : undefined}>flag</span>
              </button>
            )}
          </div>

          {!hideStem && question.transcribedStem && (
            <p className="font-headline text-lg lg:text-xl font-semibold leading-relaxed text-[#0b1c30] mb-5 lg:mb-6 whitespace-pre-wrap">
              {renderUnderline(question.transcribedStem)}
            </p>
          )}

          {/* Fallback: show question image if no stem text */}
          {!hideStem && !question.transcribedStem && question.imageData && question.imageData.length > 100 && (
            <div className="mb-5 lg:mb-6 rounded-xl overflow-hidden border border-[#e5eeff]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={question.imageData} alt={`Question ${numStr}`} className="w-full h-auto" />
            </div>
          )}

          {question.diagramImageData && (
            <div className="mb-5 lg:mb-6">
              <img
                src={`data:image/jpeg;base64,${question.diagramImageData}`}
                alt="Diagram"
                className="w-full rounded-xl border border-[#e5eeff]"
              />
            </div>
          )}

          {/* Options */}
          {hasImageOptions ? (
            <div className="grid grid-cols-2 gap-3 lg:gap-4">
              {[0, 1, 2, 3].map(i => {
                const optVal = String(i + 1);
                const isSelected = selected === optVal;
                const imgSrc = optionImages?.[i];
                return (
                  <button
                    key={i}
                    onClick={() => onSelect(optVal)}
                    className={`flex flex-col items-center gap-2 p-3 rounded-xl transition-all ${
                      isSelected
                        ? "bg-[#dce9ff] border-2 border-[#001e40]/20 ring-2 ring-[#001e40]/10"
                        : "bg-[#eff4ff] border-2 border-transparent hover:bg-[#dce9ff]"
                    }`}
                  >
                    <span className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                      isSelected ? "bg-[#001e40] text-white" : "bg-white border border-[#c3c6d1]/30 text-[#001e40]"
                    }`}>{i + 1}</span>
                    {imgSrc ? (
                      <img src={`data:image/jpeg;base64,${imgSrc}`} alt={`Option ${i + 1}`} className="w-full rounded" />
                    ) : (
                      <span className="text-sm text-[#737780]">No image</span>
                    )}
                  </button>
                );
              })}
            </div>
          ) : (
            /* Mobile: full-width tap-friendly; Desktop: 2-col grid */
            <div className="space-y-3 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-4">
              {[0, 1, 2, 3].map(i => {
                const optVal = String(i + 1);
                const isSelected = selected === optVal;
                const text = options?.[i] ?? `Option ${i + 1}`;
                return (
                  <button
                    key={i}
                    onClick={() => onSelect(optVal)}
                    className={`w-full flex items-center justify-between gap-4 p-4 lg:p-4 rounded-2xl transition-all text-left ${
                      isSelected
                        ? "bg-[#dce9ff] border-2 border-[#001e40]/20 ring-2 ring-[#001e40]/10 scale-[1.02] shadow-sm"
                        : "bg-[#eff4ff] border-2 border-transparent hover:bg-[#dce9ff]"
                    }`}
                  >
                    <div className="flex items-center gap-4">
                      <span className={`w-10 h-10 rounded-full flex items-center justify-center font-headline font-bold text-sm shrink-0 ${
                        isSelected ? "bg-[#001e40] text-white" : "bg-white border border-[#c3c6d1]/30 text-[#001e40]"
                      }`}>{i + 1}</span>
                      <span className={`font-headline font-semibold text-base ${isSelected ? "text-[#001e40] font-bold" : "text-[#0b1c30]"}`}>
                        {text}
                      </span>
                    </div>
                    {isSelected && (
                      <span className="material-symbols-outlined text-[#006c49] shrink-0" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                    )}
                    {!isSelected && (
                      <div className="w-6 h-6 rounded-full border-2 border-[#c3c6d1] shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {/* Expandable scratch area for workings (math/science only) */}
          {!hideScratchPad && <McqScratchPad tool={tool} />}
        </div>
      </div>
    </article>
  );
}

/** Small pull-out scratch pad for MCQ workings — starts collapsed */
function McqScratchPad({ tool }: { tool: DrawTool }) {
  const [height, setHeight] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawing = useRef(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const dragStart = useRef<{ y: number; h: number } | null>(null);
  function getPos(e: React.PointerEvent) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * (canvas.width / rect.width), y: (e.clientY - rect.top) * (canvas.height / rect.height) };
  }

  function onCanvasDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    isDrawing.current = true;
    lastPos.current = getPos(e);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onCanvasMove(e: React.PointerEvent) {
    if (!isDrawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !lastPos.current) return;
    const pos = getPos(e);
    const isEraser = tool === "eraser" || tool === "eraser-large";
    ctx.globalCompositeOperation = isEraser ? "destination-out" : "source-over";
    ctx.strokeStyle = isEraser ? "rgba(0,0,0,1)" : "#0066cc";
    ctx.lineWidth = tool === "eraser-large" ? 60 : tool === "eraser" ? 20 : 2;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(lastPos.current.x, lastPos.current.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    ctx.globalCompositeOperation = "source-over";
    lastPos.current = pos;
  }
  function onCanvasUp() { isDrawing.current = false; lastPos.current = null; }

  function onHandleDown(e: React.PointerEvent) {
    e.preventDefault();
    dragStart.current = { y: e.clientY, h: height };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onHandleMove(e: React.PointerEvent) {
    if (!dragStart.current) return;
    const delta = e.clientY - dragStart.current.y;
    setHeight(Math.max(0, dragStart.current.h + delta));
  }
  function onHandleUp() { dragStart.current = null; }

  // Preserve canvas content on resize
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || height === 0) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const w = parent.offsetWidth;
    const ctx = canvas.getContext("2d");
    // Save existing content before resize
    let savedImage: ImageData | null = null;
    if (ctx && canvas.width > 0 && canvas.height > 0) {
      savedImage = ctx.getImageData(0, 0, canvas.width, canvas.height);
    }
    canvas.style.width = `${w}px`;
    canvas.style.height = `${height}px`;
    const newW = w * 2;
    const newH = height * 2;
    canvas.width = newW;
    canvas.height = newH;
    // Restore content
    if (savedImage && ctx) {
      ctx.putImageData(savedImage, 0, 0);
    }
  }, [height]);

  return (
    <div className="mt-3">
      {height > 0 && (
        <div className="border border-[#d3e4fe] rounded-t-xl overflow-hidden bg-white">
          <canvas
            ref={canvasRef}
            style={{ touchAction: "none", width: "100%", height: `${height}px` }}
            onPointerDown={onCanvasDown}
            onPointerMove={onCanvasMove}
            onPointerUp={onCanvasUp}
            onPointerCancel={onCanvasUp}
          />
        </div>
      )}
      <div
        onPointerDown={onHandleDown}
        onPointerMove={onHandleMove}
        onPointerUp={onHandleUp}
        onPointerCancel={onHandleUp}
        className={`flex items-center justify-center cursor-ns-resize select-none transition-colors ${height > 0 ? "bg-[#eff4ff] border border-t-0 border-[#d3e4fe] rounded-b-xl" : "bg-[#f8f9ff] border border-[#e5eeff] rounded-xl hover:bg-[#eff4ff]"}`}
        style={{ touchAction: "none", height: "16px" }}
      >
        <div className="w-8 h-1 bg-[#c3c6d1] rounded-full" />
      </div>
    </div>
  );
}

/* ────────────── OEQ Question Card ────────────── */

/* Scratch overlay — transparent drawing layer on question area (not saved) */
function ScratchOverlay({ tool }: { tool: DrawTool }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawing = useRef(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);

  function getPos(e: React.PointerEvent) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * (canvas.width / rect.width), y: (e.clientY - rect.top) * (canvas.height / rect.height) };
  }

  function onDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    isDrawing.current = true;
    lastPos.current = getPos(e);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onMove(e: React.PointerEvent) {
    if (!isDrawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !lastPos.current) return;
    const pos = getPos(e);
    const isEraser = tool === "eraser" || tool === "eraser-large";
    ctx.strokeStyle = isEraser ? "rgba(0,0,0,0)" : "#0066cc";
    ctx.lineWidth = tool === "eraser-large" ? 60 : tool === "eraser" ? 20 : 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (isEraser) {
      ctx.globalCompositeOperation = "destination-out";
    } else {
      ctx.globalCompositeOperation = "source-over";
    }
    ctx.beginPath();
    ctx.moveTo(lastPos.current.x, lastPos.current.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    lastPos.current = pos;
  }

  function onUp() { isDrawing.current = false; lastPos.current = null; }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const obs = new ResizeObserver(() => {
      const w = parent.offsetWidth;
      const h = parent.offsetHeight;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.width = w * 2;
      canvas.height = h * 2;
    });
    obs.observe(parent);
    return () => obs.disconnect();
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 z-10 cursor-crosshair"
      style={{ touchAction: "none" }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    />
  );
}

function OeqQuestionCard({
  question,
  index,
  tool,
  onCanvasRef,
  onSubpartRefs,
  onStrokeStart,
  paperId,
  oeqIndex,
  savedHeights,
  onHeightChange,
  flagged,
  onToggleFlag,
}: {
  question: QuizQuestion;
  index: number;
  tool: DrawTool;
  onCanvasRef: (handle: AnswerCanvasHandle | null) => void;
  onSubpartRefs?: (refs: Record<string, AnswerCanvasHandle | null>) => void;
  onStrokeStart: () => void;
  paperId: string;
  oeqIndex: number;
  savedHeights?: Record<string, number>;
  onHeightChange?: (id: string, h: number) => void;
  flagged?: boolean;
  onToggleFlag?: () => void;
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
    if (onSubpartRefs) onSubpartRefs(subCanvasRefs.current);
    return () => { onCanvasRef(null); if (onSubpartRefs) onSubpartRefs({}); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSubparts]);

  const numStr = String(index + 1).padStart(2, "0");

  return (
    <section className="group">
      <div className="flex flex-col lg:flex-row gap-5 lg:gap-8 items-start">
        {/* Mobile: number + marks + flag in one row */}
        <div className="lg:hidden flex items-center gap-2 mb-1">
          <div className="w-10 h-10 rounded-xl bg-[#001e40] flex items-center justify-center text-white font-headline font-bold text-lg shadow-lg shrink-0">
            {index + 1}
          </div>
          {question.marksAvailable && (
            <span className="bg-[#d3e4fe] text-[#003366] px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-widest whitespace-nowrap">
              [{question.marksAvailable} mark{question.marksAvailable > 1 ? "s" : ""}]
            </span>
          )}
          {onToggleFlag && (
            <button onClick={onToggleFlag} className={`flex items-center gap-0.5 text-xs font-medium px-1.5 py-0.5 rounded-md transition-colors ${flagged ? "text-[#ba1a1a] bg-red-50" : "text-[#737780] hover:text-[#ba1a1a] hover:bg-red-50"}`}>
              <span className="material-symbols-outlined text-sm" style={flagged ? { fontVariationSettings: "'FILL' 1" } : undefined}>flag</span>
            </button>
          )}
        </div>

        {/* Desktop: number badge + flag */}
        <div className="hidden lg:flex flex-none flex-col items-center">
          <div className="w-12 h-12 rounded-xl bg-[#001e40] flex items-center justify-center text-white font-headline font-bold text-xl shadow-lg">
            {index + 1}
          </div>
          {onToggleFlag && (
            <button onClick={onToggleFlag} className={`flex items-center gap-0.5 text-xs font-medium mt-1 px-2 py-0.5 rounded-md transition-colors ${flagged ? "text-[#ba1a1a] bg-red-50" : "text-[#737780] hover:text-[#ba1a1a] hover:bg-red-50"}`}>
              <span className="material-symbols-outlined text-sm" style={flagged ? { fontVariationSettings: "'FILL' 1" } : undefined}>flag</span>
            </button>
          )}
        </div>

        {/* Content */}
        <div className="flex-grow space-y-4 lg:space-y-6 w-full min-w-0">
          {/* Question header — scratch-drawable on desktop only */}
          <div className="relative">
            <div className="flex justify-between items-start gap-4">
              <div className="flex-1 min-w-0">
                {question.transcribedStem && (
                  <p className="font-headline text-lg lg:text-xl font-bold text-[#001e40] leading-relaxed whitespace-pre-wrap">
                    {question.transcribedStem}
                  </p>
                )}
                {/* Show diagram as static image only if NOT drawable (drawable shows on canvas) */}
                {question.diagramImageData && !drawableDiagramBase64 && (
                  <div className="mt-4 p-5 bg-[#eff4ff] rounded-2xl border-l-4 border-[#006c49]/30">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`data:image/jpeg;base64,${question.diagramImageData}`}
                      alt="Diagram"
                      className="w-full rounded-lg"
                    />
                  </div>
                )}
              </div>
              {/* Desktop marks badge */}
              {question.marksAvailable && (
                <span className="hidden lg:inline-block bg-[#d3e4fe] text-[#003366] px-3 py-1 rounded-md text-xs font-bold uppercase tracking-widest whitespace-nowrap shrink-0">
                  [{question.marksAvailable} mark{question.marksAvailable > 1 ? "s" : ""}]
                </span>
              )}
            </div>
            {/* Scratch overlay — desktop only */}
            <div className="hidden lg:block"><ScratchOverlay tool={tool} /></div>
          </div>

          {/* Sub-parts with individual canvases */}
          {hasSubparts ? (
            <div className="space-y-4">
              {subparts!.map(sp => {
                const marksMatch = sp.text.match(/\[(\d+)\s*(?:m(?:ark)?s?)?\]$/i);
                const spMarks = marksMatch ? parseInt(marksMatch[1]) : null;
                const spText = marksMatch ? sp.text.slice(0, -marksMatch[0].length).trim() : sp.text;
                return (
                <div key={sp.label} className="bg-white rounded-2xl lg:rounded-3xl overflow-hidden shadow-sm ring-1 ring-[#c3c6d1]/20">
                  <div className="px-5 pt-4 pb-2">
                    {spMarks !== null && (
                      <p className="text-[10px] font-bold text-[#003366] uppercase tracking-widest mb-1">{spMarks} {spMarks === 1 ? "mark" : "marks"}</p>
                    )}
                    <p className="text-base text-[#0b1c30]">
                      <span className="font-bold text-[#001e40]">({sp.label})</span> {spText}
                    </p>
                    {sp.refImageBase64 && (
                      <img
                        src={`data:image/jpeg;base64,${sp.refImageBase64}`}
                        alt={`(${sp.label}) diagram`}
                        className="mt-2 max-w-full rounded border border-[#e5eeff]"
                      />
                    )}
                  </div>
                  <ResizableCanvas
                    ref={(h) => { subCanvasRefs.current[sp.label] = h; }}
                    tool={tool}
                    onStrokeStart={onStrokeStart}
                    defaultHeight={sp.diagramBase64 ? 340 : 260}
                    backgroundImage={sp.diagramBase64 ?? null}
                    savedInkUrl={`/api/exam/${paperId}/submission?page=${oeqIndex}&subpart=${sp.label}&type=ink`}
                    canvasId={`${question.id}_${sp.label}`}
                    savedHeight={savedHeights?.[`${question.id}_${sp.label}`]}
                    onHeightChange={onHeightChange}
                  />
                </div>
              );
              })}
            </div>
          ) : (
            <>
            <ResizableCanvas
              ref={onCanvasRef}
              tool={tool}
              onStrokeStart={onStrokeStart}
              defaultHeight={drawableDiagramBase64 ? 360 : 300}
              backgroundImage={drawableDiagramBase64}
              savedInkUrl={`/api/exam/${paperId}/submission?page=${oeqIndex}&type=ink`}
              canvasId={question.id}
              savedHeight={savedHeights?.[question.id]}
              onHeightChange={onHeightChange}
            />
            </>
          )}
        </div>
      </div>
    </section>
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

/* ────────────── Resizable Canvas Wrapper ────────────── */

const ResizableCanvas = forwardRef<
  AnswerCanvasHandle,
  { tool: DrawTool; onStrokeStart: () => void; defaultHeight: number; backgroundImage?: string | null; savedInkUrl?: string | null; canvasId?: string; savedHeight?: number; onHeightChange?: (id: string, h: number) => void }
>(function ResizableCanvas({ tool, onStrokeStart, defaultHeight, backgroundImage, savedInkUrl, canvasId, savedHeight, onHeightChange }, ref) {
  const maxCanvasHeight = 600;
  const [visibleHeight, setVisibleHeight] = useState(savedHeight ?? defaultHeight);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  function onDragStart(e: React.PointerEvent) {
    dragRef.current = { startY: e.clientY, startH: visibleHeight };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onDragMove(e: React.PointerEvent) {
    if (!dragRef.current) return;
    const delta = e.clientY - dragRef.current.startY;
    setVisibleHeight(Math.max(200, Math.min(maxCanvasHeight, dragRef.current.startH + delta)));
  }
  function onDragEnd() {
    dragRef.current = null;
    if (canvasId && onHeightChange) onHeightChange(canvasId, visibleHeight);
  }

  return (
    <div className="relative">
      <div className="bg-white rounded-2xl lg:rounded-3xl overflow-hidden shadow-sm ring-1 ring-[#c3c6d1]/20 relative" style={{ height: visibleHeight }}>
        <div className="absolute top-0 left-12 h-full w-px bg-[#ba1a1a]/10" />
        <BlankCanvas
          ref={ref}
          tool={tool}
          onStrokeStart={onStrokeStart}
          height={maxCanvasHeight}
          backgroundImage={backgroundImage}
          savedInkUrl={savedInkUrl}
        />
        {/* Ans: overlay at bottom right */}
        <div className="absolute bottom-3 right-4 pointer-events-none select-none">
          <span className="text-sm font-bold text-slate-300">Ans: ___________</span>
        </div>
      </div>
      {/* Drag handle */}
      <div
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        className="mx-auto mt-1 w-12 h-3 rounded-full bg-slate-200 hover:bg-slate-300 cursor-ns-resize active:bg-[#003366] transition-colors touch-none"
        style={{ touchAction: "none" }}
      />
    </div>
  );
});

const BlankCanvas = forwardRef<
  AnswerCanvasHandle,
  { tool: DrawTool; onStrokeStart: () => void; height: number; backgroundImage?: string | null; savedInkUrl?: string | null }
>(function BlankCanvas({ tool, onStrokeStart, height, backgroundImage, savedInkUrl }, ref) {
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
      const y = 0; // align diagram to top of canvas
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

      // Load saved ink if available
      if (savedInkUrl) {
        const inkImg = new Image();
        inkImg.crossOrigin = "anonymous";
        inkImg.onload = () => {
          // Draw ink onto visible canvas
          ctx.drawImage(inkImg, 0, 0, CANVAS_W, CANVAS_H);
          // Also draw onto ink-only canvas
          const inkCtx = inkCanvasRef.current?.getContext("2d");
          if (inkCtx) inkCtx.drawImage(inkImg, 0, 0, CANVAS_W, CANVAS_H);
          setReady(true);
        };
        inkImg.onerror = () => setReady(true);
        inkImg.src = savedInkUrl;
      } else {
        setReady(true);
      }
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
      cancelPendingCapture();
      pendingSnapshot.current = null;
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
      if (toolRef.current === "eraser" || toolRef.current === "eraser-large") {
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = "rgba(255,255,255,1)";
        ctx.lineWidth = toolRef.current === "eraser-large" ? 72 : 24;
      } else {
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = "rgba(37,99,235,0.85)";
        ctx.lineWidth = 3;
      }
    }

    function applyStyleInk(inkCtx: CanvasRenderingContext2D) {
      inkCtx.lineCap = "round"; inkCtx.lineJoin = "round";
      if (toolRef.current === "eraser" || toolRef.current === "eraser-large") {
        inkCtx.globalCompositeOperation = "destination-out";
        inkCtx.strokeStyle = "rgba(0,0,0,1)";
        inkCtx.lineWidth = toolRef.current === "eraser-large" ? 72 : 24;
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
      ctx.arc(pos.x, pos.y, toolRef.current === "eraser-large" ? 36 : (toolRef.current === "eraser" ? 12 : 1.5), 0, Math.PI * 2);
      ctx.fill();
      const inkCtx = inkCanvasRef.current?.getContext("2d");
      if (inkCtx) {
        applyStyleInk(inkCtx);
        inkCtx.beginPath();
        inkCtx.arc(pos.x, pos.y, toolRef.current === "eraser-large" ? 36 : (toolRef.current === "eraser" ? 12 : 1.5), 0, Math.PI * 2);
        inkCtx.fill();
      }
      if (toolRef.current === "eraser" || toolRef.current === "eraser-large") redrawComposite();
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
      if (toolRef.current === "eraser" || toolRef.current === "eraser-large") redrawComposite();
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
