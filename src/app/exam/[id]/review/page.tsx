"use client";

import { Suspense, useEffect, useState, use } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { jsPDF } from "jspdf";

interface ReviewQuestion {
  id: string;
  questionNum: string;
  pageIndex: number;
  answer: string | null;
  marksAwarded: number | null;
  marksAvailable: number | null;
  markingNotes: string | null;
  studentAnswer: string | null;
  elaboration: string | null;
  flagged: boolean;
  imageData?: string;
  // Quiz-specific transcription fields
  transcribedStem?: string | null;
  transcribedOptions?: string[] | null;
  transcribedSubparts?: { label: string; text: string; refImageBase64?: string | null; diagramBase64?: string | null }[] | null;
  diagramImageData?: string | null;
}

interface BookletScore {
  label: string;
  awarded: number;
  available: number;
}

interface ReviewData {
  markingStatus: string | null;
  score: number | null;
  feedbackSummary: string | null;
  questions: ReviewQuestion[];
  bookletScores?: BookletScore[];
}

export default function ExamReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <Suspense>
      <ExamReviewContent id={id} />
    </Suspense>
  );
}

function ExamReviewContent({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";

  const [data, setData] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [paperTitle, setPaperTitle] = useState("");
  const [totalMarks, setTotalMarks] = useState<string | null>(null);
  const [assignedToId, setAssignedToId] = useState<string | null>(null);
  const [answerPages, setAnswerPages] = useState<number[]>([]);
  const [pageCount, setPageCount] = useState(0);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [submissionPageOverride, setSubmissionPageOverride] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [submissionPageCount, setSubmissionPageCount] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [elaborations, setElaborations] = useState<Record<string, string>>({});
  const [elaborating, setElaborating] = useState<string | null>(null);
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());
  const [flagging, setFlagging] = useState<string | null>(null);
  const [instantFeedback, setInstantFeedback] = useState(false);
  const [isQuiz, setIsQuiz] = useState(false);

  useEffect(() => {
    async function fetchData() {
      try {
        const [markRes, paperRes] = await Promise.all([
          fetch(`/api/exam/${id}/mark`),
          fetch(`/api/exam/${id}`),
        ]);
        // Build maps from paper questions (imageData + transcription data for quizzes)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let paperQuestionMap: Record<string, any> = {};
        let paperIsQuiz = false;
        if (paperRes.ok) {
          const paper = await paperRes.json();
          setPaperTitle(paper.title ?? "");
          setTotalMarks(paper.totalMarks ?? null);
          setAssignedToId(paper.assignedToId ?? null);
          setInstantFeedback(paper.instantFeedback === true);
          paperIsQuiz = paper.paperType === "quiz";
          setIsQuiz(paperIsQuiz);
          setAnswerPages(paper.metadata?.answerPages ?? []);
          setPageCount(paper.pageCount ?? 0);
          const ap = paper.metadata?.answerPages ?? [];
          setSubmissionPageCount((paper.pageCount ?? 0) - ap.length);
          // Map questionNum → full question data from paper
          for (const q of paper.questions ?? []) {
            if (q.questionNum) {
              paperQuestionMap[q.questionNum] = q;
            }
          }
        }
        if (markRes.ok) {
          const markData = await markRes.json();
          // Attach data from paper questions to mark data
          for (const q of markData.questions ?? []) {
            const pq = paperQuestionMap[q.questionNum];
            if (pq) {
              if (pq.imageData) q.imageData = pq.imageData;
              // For quizzes, also attach transcription data
              if (paperIsQuiz) {
                q.transcribedStem = pq.transcribedStem ?? null;
                q.transcribedOptions = pq.transcribedOptions ?? null;
                q.transcribedSubparts = pq.transcribedSubparts ?? null;
                q.diagramImageData = pq.diagramImageData ?? null;
              }
            }
          }
          setData(markData);
          // Pre-populate cached elaborations and flagged state
          const cached: Record<string, string> = {};
          const flagged = new Set<string>();
          for (const q of markData.questions ?? []) {
            if (q.elaboration) cached[q.id] = q.elaboration;
            if (q.flagged) flagged.add(q.id);
          }
          if (Object.keys(cached).length > 0) setElaborations(cached);
          if (flagged.size > 0) setFlaggedIds(flagged);
        }
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [id]);

  function getSubmissionPage(originalPageIdx: number): number {
    const answerPageSet = new Set(answerPages.map((p) => p - 1));
    let idx = 0;
    for (let i = 0; i < pageCount; i++) {
      if (!answerPageSet.has(i)) {
        if (i === originalPageIdx) return idx;
        idx++;
      }
    }
    return originalPageIdx;
  }

  async function downloadPdf() {
    setDownloading(true);
    try {
      const metaRes = await fetch(`/api/exam/${id}/submission`);
      const meta = await metaRes.json();
      const count = meta.pageCount ?? 0;
      if (count === 0) return;

      const pages: { dataUrl: string; w: number; h: number }[] = [];
      for (let i = 0; i < count; i++) {
        const res = await fetch(`/api/exam/${id}/submission?page=${i}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const el = new window.Image();
          el.onload = () => resolve(el);
          el.onerror = reject;
          el.src = url;
        });
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext("2d")!.drawImage(img, 0, 0);
        pages.push({ dataUrl: canvas.toDataURL("image/jpeg", 0.92), w: img.naturalWidth, h: img.naturalHeight });
        URL.revokeObjectURL(url);
      }

      const first = pages[0];
      const pdf = new jsPDF({
        orientation: first.w > first.h ? "landscape" : "portrait",
        unit: "px",
        format: [first.w, first.h],
      });
      pdf.addImage(first.dataUrl, "JPEG", 0, 0, first.w, first.h);
      for (let i = 1; i < pages.length; i++) {
        const pg = pages[i];
        pdf.addPage([pg.w, pg.h], pg.w > pg.h ? "landscape" : "portrait");
        pdf.addImage(pg.dataUrl, "JPEG", 0, 0, pg.w, pg.h);
      }
      pdf.save(`${paperTitle}.pdf`);
    } catch (err) {
      console.error("Download failed:", err);
    } finally {
      setDownloading(false);
    }
  }

  async function fetchElaboration(questionId: string) {
    if (elaborations[questionId]) return;
    setElaborating(questionId);
    try {
      const res = await fetch(`/api/exam/${id}/elaborate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId }),
      });
      if (res.ok) {
        const { elaboration } = await res.json();
        setElaborations((prev) => ({ ...prev, [questionId]: elaboration }));
      }
    } catch {
      // ignore
    } finally {
      setElaborating(null);
    }
  }

  async function toggleFlag(questionId: string) {
    setFlagging(questionId);
    try {
      const res = await fetch(`/api/exam/${id}/flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId, userId }),
      });
      if (res.ok) {
        const { flagged } = await res.json();
        setFlaggedIds((prev) => {
          const next = new Set(prev);
          if (flagged) next.add(questionId);
          else next.delete(questionId);
          return next;
        });
      }
    } catch {
      // ignore
    } finally {
      setFlagging(null);
    }
  }

  const backPath = `/home/${userId}`;

  if (loading) {
    return (
      <div className="flex justify-center py-24">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-200 border-t-primary-500" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-6 text-center py-24">
        <p className="text-slate-500">Could not load results.</p>
        <button onClick={() => router.push(backPath)} className="mt-4 text-primary-500 underline">
          Go Home
        </button>
      </div>
    );
  }

  if (data.markingStatus !== "released" && !(instantFeedback && data.markingStatus === "complete")) {
    return (
      <div className="p-6 text-center py-24">
        <p className="text-slate-500">Results are not available yet.</p>
        <button onClick={() => router.push(backPath)} className="mt-4 text-primary-500 underline">
          Go Home
        </button>
      </div>
    );
  }

  const isStudent = userId === assignedToId;

  // For students, only show questions that were actually marked (have a marking result)
  // For quizzes, show all questions since they're all marked (MCQ instantly, OEQ by AI)
  const writtenQuestions = isStudent && !isQuiz
    ? data.questions.filter((q) => q.marksAwarded !== null)
    : data.questions;

  const incorrectQuestions = writtenQuestions.filter((q) => {
    if (q.marksAwarded === null || q.marksAvailable === null) return false;
    return q.marksAwarded < q.marksAvailable;
  });

  const displayQuestions = showAll ? writtenQuestions : incorrectQuestions;
  const currentQ = displayQuestions[currentIdx] ?? null;

  // Compute the effective submission page for the current question
  const baseSubmissionPage = currentQ ? getSubmissionPage(currentQ.pageIndex) : 0;
  const effectiveSubmissionPage = submissionPageOverride ?? baseSubmissionPage;

  function renderWithNewlines(text: string) {
    return text.split("|").map((part, i, arr) => (
      <span key={i}>
        {part.trim().split(/(\*\*[^*]+\*\*)/).map((seg, j) =>
          seg.startsWith("**") && seg.endsWith("**")
            ? <strong key={j}>{seg.slice(2, -2)}</strong>
            : seg
        )}
        {i < arr.length - 1 ? <br /> : null}
      </span>
    ));
  }

  return (
    <div className="min-h-screen bg-white">
      {/* Sticky header */}
      <div className="bg-white border-b border-slate-100 px-4 py-3 flex items-center gap-3">
        <button
          onClick={() => router.push(backPath)}
          className="p-1.5 -ml-1 rounded-lg text-slate-500 hover:text-slate-700 hover:bg-slate-100 shrink-0"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-slate-800 truncate">{paperTitle}</p>
        </div>
      </div>

      <div className="p-4 pb-24 w-full">
        {/* Score — large and prominent */}
        <div className="text-center py-4 mb-2">
          <p className="text-5xl font-extrabold text-primary-600">
            {data.score ?? 0}
            {totalMarks ? <span className="text-2xl font-normal text-slate-400"> / {totalMarks}</span> : null}
          </p>
          <p className="text-sm text-slate-400 mt-1">Total Score</p>
          {data.bookletScores && data.bookletScores.length > 0 && (
            <div className="flex justify-center flex-wrap gap-3 mt-2">
              {data.bookletScores.map((b) => (
                <span key={b.label} className="text-xs text-slate-500">
                  {b.label}: <span className="font-semibold text-slate-700">{b.awarded}/{b.available}</span>
                </span>
              ))}
            </div>
          )}
          {!isQuiz && (
            <button
              onClick={downloadPdf}
              disabled={downloading}
              className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 rounded-xl border border-slate-200 text-xs font-medium text-slate-500 hover:bg-slate-50 transition-colors disabled:opacity-50"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              {downloading ? "Downloading..." : "Download my paper"}
            </button>
          )}
        </div>

        {/* Incorrect / All toggle */}
        <div className="flex justify-end mb-3">
          <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden text-xs font-medium">
            <button
              onClick={() => { setShowAll(false); setCurrentIdx(0); setSubmissionPageOverride(null); }}
              className={`px-3 py-1.5 transition-colors ${!showAll ? "bg-primary-500 text-white" : "text-slate-500 hover:bg-slate-50"}`}
            >
              Incorrect ({incorrectQuestions.length})
            </button>
            <button
              onClick={() => { setShowAll(true); setCurrentIdx(0); setSubmissionPageOverride(null); }}
              className={`px-3 py-1.5 transition-colors ${showAll ? "bg-primary-500 text-white" : "text-slate-500 hover:bg-slate-50"}`}
            >
              All ({writtenQuestions.length})
            </button>
          </div>
        </div>

        {/* Advisory message — parents only */}
        {!isStudent && (
          <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3 mb-4">
            <p className="text-xs text-amber-700 leading-relaxed">
              We encourage you to verify and understand where your child has made mistakes, and go through with him/her the mistakes.
            </p>
          </div>
        )}

        {/* Feedback summary — prominent for students, collapsible for parents */}
        {data.feedbackSummary ? (
          isStudent ? (
            <div className="rounded-2xl bg-gradient-to-r from-primary-50 to-blue-50 border border-slate-100 mb-6 px-4 py-4">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Summary</p>
              <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-line">
                {data.feedbackSummary}
              </p>
            </div>
          ) : (
            <details className="rounded-2xl bg-gradient-to-r from-primary-50 to-blue-50 border border-slate-100 mb-6 overflow-hidden">
              <summary className="px-4 py-3 cursor-pointer text-xs font-semibold text-slate-400 uppercase tracking-wide select-none hover:text-slate-600">
                Summary
              </summary>
              <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-line px-4 pb-4">
                {data.feedbackSummary}
              </p>
            </details>
          )
        ) : null}

        {/* Questions to review — flip-through */}
        {displayQuestions.length === 0 ? (
          <div className="text-center py-12">
            {incorrectQuestions.length === 0 ? (
              <>
                <p className="text-3xl mb-3">&#127881;</p>
                <p className="text-slate-600 font-medium">Perfect score!</p>
                <p className="text-slate-400 text-sm mt-1">You got every question right.</p>
              </>
            ) : (
              <p className="text-slate-400 text-sm">No questions to show.</p>
            )}
          </div>
        ) : (
          <div>
            {/* Navigation header */}
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                {showAll ? "All Questions" : "Questions to Review"}
              </h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { setCurrentIdx((i) => Math.max(0, i - 1)); setSubmissionPageOverride(null); }}
                  disabled={currentIdx === 0}
                  className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
                    fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m15 18-6-6 6-6" />
                  </svg>
                </button>
                <span className="text-xs font-medium text-slate-500 min-w-[3rem] text-center">
                  {currentIdx + 1} / {displayQuestions.length}
                </span>
                <button
                  onClick={() => { setCurrentIdx((i) => Math.min(displayQuestions.length - 1, i + 1)); setSubmissionPageOverride(null); }}
                  disabled={currentIdx === displayQuestions.length - 1}
                  className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
                    fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </button>
              </div>
            </div>

            {/* Current question card */}
            {currentQ ? (
              <div>
              <div className="rounded-2xl border border-slate-100 bg-white shadow-sm overflow-hidden">
                {/* Question header */}
                <div className="flex items-center justify-between px-4 py-3 bg-slate-50 border-b border-slate-100">
                  <span className="text-sm font-semibold text-slate-700">
                    Question {currentQ.questionNum}
                  </span>
                  <span className={`text-sm font-bold ${
                    (currentQ.marksAwarded ?? 0) >= (currentQ.marksAvailable ?? 0) ? "text-green-600" :
                    (currentQ.marksAwarded ?? 0) === 0 ? "text-red-500" : "text-amber-600"
                  }`}>
                    {currentQ.marksAwarded ?? 0} / {currentQ.marksAvailable ?? 0}
                  </span>
                </div>

                {/* Quiz question text — show transcribed stem, diagram, options/subparts */}
                {isQuiz && currentQ.transcribedStem ? (
                  <div className="border-b border-slate-100 px-4 py-3 space-y-2">
                    <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
                      {currentQ.transcribedStem}
                    </p>
                    {currentQ.diagramImageData ? (
                      <div>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`data:image/jpeg;base64,${currentQ.diagramImageData}`}
                          alt="Diagram"
                          className="w-full rounded-lg border border-slate-100"
                        />
                      </div>
                    ) : null}
                    {currentQ.transcribedOptions && currentQ.transcribedOptions.length > 0 ? (
                      <div className="space-y-1">
                        {currentQ.transcribedOptions.map((opt, i) => {
                          const optNum = String(i + 1);
                          const isCorrect = currentQ.answer?.trim().replace(/[().]/g, "").trim() === optNum;
                          const isSelected = currentQ.studentAnswer === optNum;
                          return (
                            <div
                              key={i}
                              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm ${
                                isCorrect
                                  ? "bg-green-50 border border-green-200 text-green-800 font-medium"
                                  : isSelected
                                  ? "bg-red-50 border border-red-200 text-red-700"
                                  : "text-slate-600"
                              }`}
                            >
                              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                                isCorrect ? "bg-green-500 text-white" : isSelected ? "bg-red-400 text-white" : "bg-slate-100 text-slate-500"
                              }`}>
                                {i + 1}
                              </span>
                              <span>{opt}</span>
                              {isCorrect && isSelected ? <span className="ml-auto text-xs text-green-600">Correct</span> : null}
                              {isCorrect && !isSelected ? <span className="ml-auto text-xs text-green-600">Answer</span> : null}
                              {!isCorrect && isSelected ? <span className="ml-auto text-xs text-red-500">Your pick</span> : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                    {currentQ.transcribedSubparts && currentQ.transcribedSubparts.length > 0 ? (
                      <div className="space-y-2 mt-1">
                        {currentQ.transcribedSubparts.map((sp) => (
                          <div key={sp.label}>
                            <p className="text-sm text-slate-700">
                              <span className="font-medium text-amber-700">({sp.label})</span> {sp.text}
                            </p>
                            {sp.refImageBase64 && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={`data:image/jpeg;base64,${sp.refImageBase64}`}
                                alt={`(${sp.label}) diagram`}
                                className="w-full rounded-lg border border-slate-100 mt-1"
                              />
                            )}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : !isStudent && currentQ.imageData ? (
                  /* Extracted question image — shown to parents only for regular exams */
                  <div className="border-b border-slate-100 bg-slate-50 px-2 py-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={currentQ.imageData}
                      alt={`Question ${currentQ.questionNum}`}
                      className="w-full h-auto rounded-lg"
                    />
                  </div>
                ) : null}

                {/* Side-by-side on wide screens, stacked on mobile */}
                <div className="md:flex">
                  {/* Submission page image with page navigation — not shown for quizzes */}
                  {!isQuiz && (
                  <div className="border-b border-slate-100 md:border-b-0 md:border-r md:w-1/2 md:shrink-0 relative">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/exam/${id}/submission?page=${effectiveSubmissionPage}`}
                      alt={`Submission page for Q${currentQ.questionNum}`}
                      className="w-full h-auto"
                    />
                    {/* Page navigation overlay */}
                    {submissionPageCount > 1 && (
                      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-black/50 rounded-full px-2 py-1">
                        <button
                          onClick={() => setSubmissionPageOverride(Math.max(0, effectiveSubmissionPage - 1))}
                          disabled={effectiveSubmissionPage === 0}
                          className="text-white/80 hover:text-white disabled:text-white/30 transition-colors"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                            fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="m15 18-6-6 6-6" />
                          </svg>
                        </button>
                        <span className="text-[10px] text-white/80 min-w-[2.5rem] text-center">
                          {effectiveSubmissionPage + 1} / {submissionPageCount}
                        </span>
                        <button
                          onClick={() => setSubmissionPageOverride(Math.min(submissionPageCount - 1, effectiveSubmissionPage + 1))}
                          disabled={effectiveSubmissionPage === submissionPageCount - 1}
                          className="text-white/80 hover:text-white disabled:text-white/30 transition-colors"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                            fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="m9 18 6-6-6-6" />
                          </svg>
                        </button>
                      </div>
                    )}
                  </div>
                  )}

                  {/* Solutions panel */}
                  <div className="px-4 py-3 space-y-3 md:flex-1 md:overflow-y-auto md:max-h-[70vh]">
                    {/* Student's answer — for quiz OEQ (MCQ already shown in options above) */}
                    {isQuiz && currentQ.studentAnswer && !currentQ.transcribedOptions ? (
                      <div>
                        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                          Your Answer
                        </p>
                        <div className={`text-sm leading-relaxed rounded-lg p-3 border ${
                          (currentQ.marksAwarded ?? 0) >= (currentQ.marksAvailable ?? 0)
                            ? "bg-green-50 border-green-200 text-green-800"
                            : "bg-red-50 border-red-200 text-red-800"
                        }`}>
                          {currentQ.studentAnswer}
                        </div>
                      </div>
                    ) : null}

                    {/* Correct answer — skip for quiz MCQs (already shown inline in options) */}
                    {currentQ.answer && !(isQuiz && currentQ.transcribedOptions) ? (
                      <div>
                        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                          Correct Answer
                        </p>
                        <div className="text-sm text-slate-800 leading-relaxed max-h-48 overflow-y-auto rounded-lg bg-slate-50 p-3 border border-slate-100">
                          {renderWithNewlines(currentQ.answer)}
                        </div>
                      </div>
                    ) : null}

                    {/* Marking notes */}
                    {currentQ.markingNotes ? (
                      <div>
                        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                          Marking Notes
                        </p>
                        <p className="text-sm text-slate-600 leading-relaxed">
                          {renderWithNewlines(currentQ.markingNotes)}
                        </p>
                      </div>
                    ) : null}

                    {/* AI Elaboration — available for all marked questions */}
                    {currentQ.marksAwarded !== null && (
                      <div>
                        {elaborations[currentQ.id] ? (
                          <div>
                            <p className="text-xs font-semibold text-teal-500 uppercase tracking-wide mb-1">
                              AI Elaboration
                              {!isStudent && (
                                <button
                                  onClick={async () => {
                                    const updated = elaborations[currentQ.id];
                                    if (!updated) return;
                                    try {
                                      await fetch(`/api/exam/questions/${currentQ.id}`, {
                                        method: "PATCH",
                                        headers: { "Content-Type": "application/json" },
                                        body: JSON.stringify({ elaboration: updated }),
                                      });
                                    } catch { /* ignore */ }
                                  }}
                                  className="ml-2 text-[10px] font-normal text-teal-400 hover:text-teal-600 normal-case"
                                >
                                  Save
                                </button>
                              )}
                            </p>
                            {!isStudent ? (
                              <textarea
                                value={elaborations[currentQ.id]}
                                onChange={e => setElaborations(prev => ({ ...prev, [currentQ.id]: e.target.value }))}
                                rows={6}
                                className="w-full text-sm text-teal-800 leading-relaxed whitespace-pre-line rounded-lg bg-teal-50 border border-teal-200 p-3 focus:outline-none focus:border-teal-400 resize-y"
                              />
                            ) : (
                              <div className="text-sm text-teal-800 leading-relaxed whitespace-pre-line rounded-lg bg-teal-50 border border-teal-200 p-3">
                                {elaborations[currentQ.id]}
                              </div>
                            )}
                          </div>
                        ) : (
                          <button
                            onClick={() => fetchElaboration(currentQ.id)}
                            disabled={elaborating === currentQ.id}
                            className="w-full py-2.5 rounded-xl border border-teal-200 bg-teal-50 text-teal-600 text-xs font-semibold hover:bg-teal-100 transition-colors disabled:opacity-50"
                          >
                            {elaborating === currentQ.id ? (
                              <span className="inline-flex items-center gap-2">
                                <span className="animate-spin rounded-full h-3 w-3 border-2 border-teal-200 border-t-teal-600 inline-block" />
                                Generating...
                              </span>
                            ) : (
                              "AI Elaboration"
                            )}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Flag button — below card, bottom-left */}
              <div className="mt-2 flex items-center gap-1.5">
                <button
                  onClick={() => toggleFlag(currentQ.id)}
                  disabled={flagging === currentQ.id}
                  className="p-1 rounded-lg transition-colors disabled:opacity-50 hover:bg-slate-100"
                  title={flaggedIds.has(currentQ.id) ? "Unflag this question" : "Flag incorrect Q&A"}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
                    fill={flaggedIds.has(currentQ.id) ? "#eab308" : "none"}
                    stroke={flaggedIds.has(currentQ.id) ? "#eab308" : "#94a3b8"}
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                    <line x1="12" y1="9" x2="12" y2="13" />
                    <line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                </button>
                <span className="text-xs text-slate-400">
                  {flaggedIds.has(currentQ.id) ? "Flagged" : "Flag Q&A for improvement"}
                </span>
              </div>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
