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
  answerImageData?: string | null;
  // Quiz-specific transcription fields
  transcribedStem?: string | null;
  transcribedOptions?: string[] | null;
  transcribedOptionImages?: string[] | null;
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
  const [releasing, setReleasing] = useState(false);
  const [released, setReleased] = useState(false);

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
          paperIsQuiz = paper.paperType === "quiz" || paper.paperType === "focused";
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
              if (pq.answerImageData) q.answerImageData = pq.answerImageData;
              // For quizzes, also attach transcription data
              if (paperIsQuiz) {
                q.transcribedStem = pq.transcribedStem ?? null;
                q.transcribedOptions = pq.transcribedOptions ?? null;
                q.transcribedOptionImages = pq.transcribedOptionImages ?? null;
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

  async function handleRelease() {
    setReleasing(true);
    try {
      await fetch(`/api/exam/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markingStatus: "released" }),
      });
      setReleased(true);
    } finally {
      setReleasing(false);
    }
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

  const isStudent = userId === assignedToId;
  const backPath = assignedToId && !isStudent
    ? `/home/${userId}?view=progress&student=${assignedToId}`
    : `/home/${userId}?view=progress`;

  if (loading) {
    return (
      <div className="flex justify-center py-24 bg-[#f8f9ff] min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-[#dce9ff] border-t-[#001e40]" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-[#f8f9ff] flex items-center justify-center p-6 text-center">
        <div>
          <p className="text-[#43474f] mb-4">Could not load results.</p>
          <button onClick={() => router.replace(backPath)} className="px-6 py-2.5 rounded-2xl bg-[#001e40] text-white font-bold text-sm">
            Go Home
          </button>
        </div>
      </div>
    );
  }

  if (data.markingStatus !== "released" && !(instantFeedback && data.markingStatus === "complete")) {
    return (
      <div className="min-h-screen bg-[#f8f9ff] flex items-center justify-center p-6 text-center">
        <div>
          <p className="text-[#43474f] mb-4">Results are not available yet.</p>
          <button onClick={() => router.replace(backPath)} className="px-6 py-2.5 rounded-2xl bg-[#001e40] text-white font-bold text-sm">
            Go Home
          </button>
        </div>
      </div>
    );
  }

  const writtenQuestions = isStudent && !isQuiz
    ? data.questions.filter((q) => q.marksAwarded !== null)
    : data.questions;

  const incorrectQuestions = writtenQuestions.filter((q) => {
    if (q.marksAwarded === null || q.marksAvailable === null) return false;
    return q.marksAwarded < q.marksAvailable;
  });

  const displayQuestions = showAll ? writtenQuestions : incorrectQuestions;
  const currentQ = displayQuestions[currentIdx] ?? null;

  // For quiz OEQ: index of currentQ among all OEQ questions (no text or image MCQ options)
  const allOeqQuestions = data.questions.filter(q => !q.transcribedOptions && !q.transcribedOptionImages);
  const currentQOeqIndex = currentQ ? allOeqQuestions.findIndex(q => q.id === currentQ.id) : -1;

  const baseSubmissionPage = currentQ ? getSubmissionPage(currentQ.pageIndex) : 0;
  const effectiveSubmissionPage = submissionPageOverride ?? baseSubmissionPage;

  const totalM = totalMarks ? Number(totalMarks) : null;
  const pct = totalM && totalM > 0 ? Math.round(((data.score ?? 0) / totalM) * 100) : null;
  const scoreBorderColor = pct === null ? "#d3e4fe"
    : pct >= 75 ? "#6cf8bb"
    : pct >= 50 ? "#ffb952"
    : "#ffdad6";
  const scoreTextColor = pct === null ? "#001e40"
    : pct >= 75 ? "#006c49"
    : pct >= 50 ? "#633f00"
    : "#ba1a1a";

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

  // Renders marking notes: bolds all verdict labels like "(a) Correct" / "(b) Incorrect"
  function renderMarkingNotes(text: string) {
    // Split into pipe-separated sections (e.g. "Detected: X | (a) Correct. (b) Wrong")
    return text.split("|").map((part, i, arr) => {
      const trimmed = part.trim();
      // Globally bold every "(x) [Partially] Correct/Incorrect" phrase in each section
      const verdictRe = /(\([a-zA-Z]\)\s+(?:Partially\s+)?(?:Correct|Incorrect))/gi;
      const segments: React.ReactNode[] = [];
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = verdictRe.exec(trimmed)) !== null) {
        if (m.index > last) segments.push(trimmed.slice(last, m.index));
        segments.push(<strong key={m.index}>{m[1]}</strong>);
        last = m.index + m[1].length;
      }
      if (last < trimmed.length) segments.push(trimmed.slice(last));
      return (
        <span key={i}>
          {segments.length > 0 ? segments : trimmed}
          {i < arr.length - 1 ? <br /> : null}
        </span>
      );
    });
  }

  return (
    <div className="min-h-screen bg-[#f8f9ff]">
      {/* ── Top bar ── */}
      <header className="fixed top-0 w-full z-50 bg-[#f8f9ff] backdrop-blur-xl shadow-sm">
        {/* Mobile: centered title */}
        <div className="lg:hidden flex items-center justify-between px-4 h-16">
          <button
            onClick={() => router.replace(backPath)}
            className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-[#eff4ff] transition-colors"
          >
            <span className="material-symbols-outlined text-[#001e40]">arrow_back</span>
          </button>
          <h1 className="font-headline font-bold text-lg text-[#001e40]">Quiz Review</h1>
          {isQuiz && !isStudent ? (
            <button
              onClick={handleRelease}
              disabled={releasing || released}
              className={`px-3 py-1.5 rounded-full text-xs font-bold transition-colors disabled:opacity-50 ${released ? "bg-[#6cf8bb]/30 text-[#006c49]" : "bg-[#001e40] text-white"}`}
            >
              {released ? "Reviewed ✓" : releasing ? "…" : "Mark Reviewed"}
            </button>
          ) : !isQuiz ? (
            <button
              onClick={downloadPdf}
              disabled={downloading}
              className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-[#eff4ff] transition-colors disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[#001e40]">download</span>
            </button>
          ) : <div className="w-10" />}
        </div>
        {/* Desktop: left-aligned with title + download */}
        <div className="hidden lg:flex items-center justify-between px-8 py-3 max-w-5xl mx-auto">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => router.replace(backPath)}
              className="p-2 rounded-xl text-[#43474f] hover:bg-[#eff4ff] transition-colors shrink-0"
            >
              <span className="material-symbols-outlined">arrow_back</span>
            </button>
            <p className="font-headline font-bold text-[#001e40] truncate">{paperTitle}</p>
          </div>
          <div className="flex items-center gap-3">
            {isQuiz && !isStudent && (
              <button
                onClick={handleRelease}
                disabled={releasing || released}
                className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-colors disabled:opacity-50 shrink-0 ${released ? "bg-[#6cf8bb]/30 text-[#006c49] border border-[#6cf8bb]" : "bg-[#001e40] text-white hover:bg-[#003366]"}`}
              >
                <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>{released ? "task_alt" : "check_circle"}</span>
                {released ? "Marked as Reviewed" : releasing ? "Saving…" : "Mark as Reviewed"}
              </button>
            )}
            {!isQuiz && (
              <button
                onClick={downloadPdf}
                disabled={downloading}
                className="flex items-center gap-2 px-4 py-2 rounded-xl border border-[#c3c6d1] text-sm font-semibold text-[#43474f] hover:bg-[#eff4ff] transition-colors disabled:opacity-50 shrink-0"
              >
                <span className="material-symbols-outlined text-base">download</span>
                {downloading ? "Downloading…" : "Download"}
              </button>
            )}
          </div>
        </div>
      </header>

      <div className="pt-16 pb-24 max-w-5xl mx-auto px-4 lg:px-8">

        {/* ── Hero Score Section ── */}
        {/* Mobile: compact single card */}
        <section className="mt-5 mb-5 lg:hidden">
          <div className="bg-white rounded-2xl p-5 shadow-sm relative overflow-hidden">
            <div className="absolute -top-4 -right-4 w-24 h-24 bg-[#003366]/5 rounded-full blur-2xl" />
            <div className="flex items-center gap-5">
              {/* Circular progress ring */}
              <div
                className="w-20 h-20 rounded-full flex items-center justify-center shrink-0"
                style={{
                  background: `radial-gradient(closest-side, white 78%, transparent 0% 100%), conic-gradient(${scoreBorderColor} ${pct ?? 0}%, #dce9ff 0)`,
                }}
              >
                <span className="font-headline font-extrabold text-xl" style={{ color: scoreTextColor }}>
                  {pct !== null ? `${pct}%` : `${data.score ?? 0}`}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="font-headline font-bold text-xl text-[#001e40]">
                  {pct !== null && pct >= 75 ? "Well done!" : pct !== null && pct >= 50 ? "Good effort!" : "Keep practising!"}
                </h2>
                <p className="text-sm text-[#43474f] font-medium mt-0.5">
                  {pct !== null ? `${data.score ?? 0} / ${totalMarks} marks` : paperTitle}
                </p>
                <div className="flex gap-2 flex-wrap mt-2">
                  <span className="px-3 py-1 bg-[#eff4ff] rounded-full text-[10px] font-bold text-[#001e40]">{writtenQuestions.length} Qs</span>
                  <span className="px-3 py-1 bg-[#ffdad6] rounded-full text-[10px] font-bold text-[#ba1a1a]">{incorrectQuestions.length} to review</span>
                </div>
              </div>
            </div>
            {data.feedbackSummary && isStudent && (
              <p className="text-sm text-[#43474f] leading-relaxed mt-4 max-h-32 overflow-y-auto">{data.feedbackSummary}</p>
            )}
            {data.feedbackSummary && !isStudent && (
              <details className="mt-4">
                <summary className="text-xs font-semibold text-[#43474f] uppercase tracking-wide cursor-pointer select-none">Summary</summary>
                <p className="text-sm text-[#43474f] leading-relaxed whitespace-pre-line mt-2">{data.feedbackSummary}</p>
              </details>
            )}
          </div>
        </section>

        {/* Desktop: bento grid */}
        <section className="hidden lg:grid grid-cols-3 gap-6 my-10">
          <div className="col-span-2 bg-white rounded-3xl p-8 flex flex-row items-center gap-8 relative overflow-hidden shadow-sm">
            <div className="absolute top-0 right-0 w-64 h-64 bg-[#6cf8bb]/10 rounded-full -mr-20 -mt-20 blur-3xl" />
            <div
              className="relative z-10 flex flex-col items-center justify-center w-44 h-44 rounded-full shrink-0"
              style={{ background: `radial-gradient(closest-side, white 82%, transparent 82%), conic-gradient(${scoreBorderColor} ${pct ?? 0}%, #dce9ff 0)` }}
            >
              <span className="font-headline text-5xl font-extrabold" style={{ color: scoreTextColor }}>
                {pct !== null ? `${pct}%` : `${data.score ?? 0}`}
              </span>
              <span className="text-xs font-medium text-[#43474f] mt-1">
                {pct !== null ? `${data.score ?? 0} / ${totalMarks}` : "Score"}
              </span>
            </div>
            <div className="flex-1">
              <h1 className="font-headline text-3xl font-extrabold text-[#001e40] mb-2">
                {pct !== null && pct >= 75 ? "Well done!" : pct !== null && pct >= 50 ? "Good effort!" : "Keep practising!"}
              </h1>
              {data.feedbackSummary ? (
                isStudent ? (
                  <p className="text-sm text-[#43474f] leading-relaxed whitespace-pre-line mb-4 max-h-32 overflow-y-auto">{data.feedbackSummary}</p>
                ) : (
                  <details className="mb-4">
                    <summary className="text-xs font-semibold text-[#43474f] uppercase tracking-wide cursor-pointer hover:text-[#001e40] select-none">Summary</summary>
                    <p className="text-sm text-[#43474f] leading-relaxed whitespace-pre-line mt-2">{data.feedbackSummary}</p>
                  </details>
                )
              ) : null}
              {data.bookletScores && data.bookletScores.length > 0 && (
                <div className="flex flex-wrap gap-3">
                  {data.bookletScores.map((b) => (
                    <span key={b.label} className="px-3 py-1 bg-[#eff4ff] rounded-full text-xs font-bold text-[#001e40]">
                      {b.label}: {b.awarded}/{b.available}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-4">
            <div className="bg-white rounded-3xl p-5 flex items-center gap-4 shadow-sm flex-1">
              <div className="w-12 h-12 rounded-2xl bg-[#eff4ff] flex items-center justify-center text-[#001e40] shrink-0">
                <span className="material-symbols-outlined">quiz</span>
              </div>
              <div>
                <p className="text-[10px] text-[#43474f] uppercase tracking-wider font-bold">Questions</p>
                <p className="font-headline text-xl font-bold text-[#001e40]">{writtenQuestions.length}</p>
              </div>
            </div>
            <div className="bg-white rounded-3xl p-5 flex items-center gap-4 shadow-sm flex-1">
              <div className="w-12 h-12 rounded-2xl bg-[#ffdad6] flex items-center justify-center text-[#ba1a1a] shrink-0">
                <span className="material-symbols-outlined">cancel</span>
              </div>
              <div>
                <p className="text-[10px] text-[#43474f] uppercase tracking-wider font-bold">To Review</p>
                <p className="font-headline text-xl font-bold text-[#ba1a1a]">{incorrectQuestions.length}</p>
              </div>
            </div>
          </div>
        </section>

        {/* Advisory — parents only */}
        {!isStudent && (
          <div className="rounded-2xl bg-[#ffddb4]/40 border border-[#ffb952]/30 px-4 py-3 mb-6 flex items-start gap-3">
            <span className="material-symbols-outlined text-[#633f00] shrink-0 mt-0.5">info</span>
            <p className="text-sm text-[#633f00] leading-relaxed">
              We encourage you to review your child&apos;s mistakes together and discuss the correct approach.
            </p>
          </div>
        )}

        {/* ── Tabs ── */}
        <div className="mb-6">
          <div className="flex items-center gap-1 p-1 bg-white rounded-2xl w-fit shadow-sm">
            <button
              onClick={() => { setShowAll(false); setCurrentIdx(0); setSubmissionPageOverride(null); }}
              className={`px-6 py-2.5 rounded-xl text-sm font-bold transition-all ${!showAll ? "bg-[#001e40] text-white shadow-sm" : "text-[#43474f] hover:bg-[#eff4ff]"}`}
            >
              Incorrect ({incorrectQuestions.length})
            </button>
            <button
              onClick={() => { setShowAll(true); setCurrentIdx(0); setSubmissionPageOverride(null); }}
              className={`px-6 py-2.5 rounded-xl text-sm font-bold transition-all ${showAll ? "bg-[#001e40] text-white shadow-sm" : "text-[#43474f] hover:bg-[#eff4ff]"}`}
            >
              All ({writtenQuestions.length})
            </button>
          </div>
        </div>

        {/* ── Question Review ── */}
        {displayQuestions.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-3xl shadow-sm">
            {incorrectQuestions.length === 0 ? (
              <>
                <div className="text-5xl mb-4">🎉</div>
                <p className="font-headline text-xl font-extrabold text-[#001e40] mb-1">Perfect score!</p>
                <p className="text-sm text-[#43474f]">You got every question right.</p>
              </>
            ) : (
              <p className="text-sm text-[#43474f]">No questions to show.</p>
            )}
          </div>
        ) : (
          <div>
            {/* Navigation header — desktop */}
            <div className="hidden lg:flex items-center justify-between mb-4">
              <h2 className="font-headline text-2xl font-extrabold text-[#001e40]">Question Review</h2>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => { setCurrentIdx((i) => Math.max(0, i - 1)); setSubmissionPageOverride(null); }}
                  disabled={currentIdx === 0}
                  className="w-10 h-10 rounded-full border border-[#c3c6d1]/40 flex items-center justify-center text-[#001e40] hover:bg-[#eff4ff] disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                >
                  <span className="material-symbols-outlined">chevron_left</span>
                </button>
                <span className="text-sm font-bold text-[#001e40] tabular-nums">
                  {String(currentIdx + 1).padStart(2, "0")} of {String(displayQuestions.length).padStart(2, "0")}
                </span>
                <button
                  onClick={() => { setCurrentIdx((i) => Math.min(displayQuestions.length - 1, i + 1)); setSubmissionPageOverride(null); }}
                  disabled={currentIdx === displayQuestions.length - 1}
                  className="w-10 h-10 rounded-full border border-[#c3c6d1]/40 flex items-center justify-center text-[#001e40] hover:bg-[#eff4ff] disabled:opacity-30 disabled:cursor-not-allowed transition-all"
                >
                  <span className="material-symbols-outlined">chevron_right</span>
                </button>
              </div>
            </div>

            {/* Navigation — mobile: prominent centered style */}
            <nav className="lg:hidden flex items-center justify-between px-2 mb-4">
              <button
                onClick={() => { setCurrentIdx((i) => Math.max(0, i - 1)); setSubmissionPageOverride(null); }}
                disabled={currentIdx === 0}
                className="w-12 h-12 flex items-center justify-center rounded-xl bg-[#eff4ff] text-[#001e40] hover:scale-105 transition-transform disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <span className="material-symbols-outlined">chevron_left</span>
              </button>
              <div className="flex flex-col items-center">
                <span className="text-[10px] font-bold text-[#43474f] tracking-[0.2em] uppercase mb-1">Question</span>
                <span className="font-headline font-extrabold text-2xl text-[#001e40]">
                  {currentIdx + 1} <span className="text-[#43474f] font-medium text-lg">of {displayQuestions.length}</span>
                </span>
              </div>
              <button
                onClick={() => { setCurrentIdx((i) => Math.min(displayQuestions.length - 1, i + 1)); setSubmissionPageOverride(null); }}
                disabled={currentIdx === displayQuestions.length - 1}
                className="w-12 h-12 flex items-center justify-center rounded-xl bg-[#eff4ff] text-[#001e40] hover:scale-105 transition-transform disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <span className="material-symbols-outlined">chevron_right</span>
              </button>
            </nav>

            {/* Current question card */}
            {currentQ && (() => {
              const isCorrect = (currentQ.marksAwarded ?? 0) >= (currentQ.marksAvailable ?? 1);
              const isPartial = !isCorrect && (currentQ.marksAwarded ?? 0) > 0;
              const badgeBg = isCorrect ? "#d1fae5" : isPartial ? "#fef3c7" : "#ffdad6";
              const badgeText = isCorrect ? "#006c49" : isPartial ? "#633f00" : "#ba1a1a";

              return (
              <div className="relative bg-[#eff4ff]/40 rounded-3xl p-5 lg:p-8 border border-[#e5eeff]">
                <div className="flex flex-col md:flex-row gap-5 lg:gap-8">
                  {/* Number badge */}
                  <div
                    className="w-12 h-12 rounded-full flex items-center justify-center font-headline font-bold text-lg shrink-0"
                    style={{ backgroundColor: badgeBg, color: badgeText }}
                  >
                    {currentQ.questionNum}
                  </div>

                  <div className="flex-1 min-w-0">
                    {/* Topic + marks */}
                    <div className="flex items-center gap-3 mb-4 flex-wrap">
                      {currentQ.marksAvailable !== null && (
                        <span className="px-3 py-1 bg-white rounded-full text-xs font-bold text-[#001e40] shadow-sm">
                          {currentQ.marksAwarded ?? 0} / {currentQ.marksAvailable} marks
                        </span>
                      )}
                      {isCorrect && (
                        <span className="flex items-center gap-1 text-xs font-bold text-[#006c49]">
                          <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                          Correct
                        </span>
                      )}
                      {!isCorrect && !isPartial && (
                        <span className="flex items-center gap-1 text-xs font-bold text-[#ba1a1a]">
                          <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>cancel</span>
                          Incorrect
                        </span>
                      )}
                      {isPartial && (
                        <span className="flex items-center gap-1 text-xs font-bold text-[#633f00]">
                          <span className="material-symbols-outlined text-base">remove_circle</span>
                          Partial
                        </span>
                      )}
                    </div>

                    {/* Quiz question text */}
                    {isQuiz && currentQ.transcribedStem ? (
                      <div className="space-y-3 mb-5">
                        {(() => {
                          type SubpartEntry = { label: string; text: string; diagramBase64?: string | null; refImageBase64?: string | null };
                          const allSubs = currentQ.transcribedSubparts as SubpartEntry[] | null;
                          const subRefMap: Record<string, string> = {};
                          if (allSubs) for (const sp of allSubs) if (sp.label.startsWith("_subref-")) subRefMap[sp.label.slice(8)] = sp.diagramBase64 ?? "";
                          const drawableDiagram = allSubs?.find(sp => sp.label === "_drawable")?.diagramBase64 ?? null;
                          const realSubs = allSubs
                            ? allSubs.filter(sp => !sp.label.startsWith("_")).map(sp => ({ ...sp, refImageBase64: subRefMap[sp.label] ?? sp.refImageBase64 ?? null }))
                            : null;
                          const toSrc = (b64: string) => b64.startsWith("data:") ? b64 : `data:image/jpeg;base64,${b64}`;
                          return (
                            <>
                              <h3 className="font-headline text-lg lg:text-xl font-semibold text-[#001e40] leading-relaxed whitespace-pre-wrap">
                                {currentQ.transcribedStem}
                              </h3>
                              {currentQ.diagramImageData && (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={toSrc(currentQ.diagramImageData)} alt="Diagram" className="w-full rounded-xl border border-[#e5eeff]" />
                              )}
                              {/* MCQ options — image grid */}
                              {currentQ.transcribedOptionImages && currentQ.transcribedOptionImages.some(img => img) && (
                                <div className="grid grid-cols-2 gap-3 mt-2">
                                  {[0, 1, 2, 3].map(i => {
                                    const optNum = String(i + 1);
                                    const isOptCorrect = currentQ.answer?.trim().replace(/[().]/g, "").trim() === optNum;
                                    const isSelected = currentQ.studentAnswer === optNum;
                                    const imgSrc = currentQ.transcribedOptionImages![i];
                                    return (
                                      <div key={i} className={`flex flex-col items-center gap-2 p-3 rounded-xl border-2 ${
                                        isOptCorrect ? "bg-[#6cf8bb]/20 border-[#006c49]/40" : isSelected ? "bg-[#ffdad6] border-[#ba1a1a]/40" : "bg-[#eff4ff] border-transparent"
                                      }`}>
                                        <span className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
                                          isOptCorrect ? "bg-[#006c49] text-white" : isSelected ? "bg-[#ba1a1a] text-white" : "bg-white border border-[#c3c6d1]/30 text-[#001e40]"
                                        }`}>{i + 1}</span>
                                        {imgSrc ? (
                                          // eslint-disable-next-line @next/next/no-img-element
                                          <img src={`data:image/jpeg;base64,${imgSrc}`} alt={`Option ${i + 1}`} className="w-full rounded" />
                                        ) : null}
                                        {isOptCorrect && <span className="text-[10px] font-bold text-[#006c49]">Correct</span>}
                                        {!isOptCorrect && isSelected && <span className="text-[10px] font-bold text-[#ba1a1a]">Your answer</span>}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                              {/* MCQ options — text list */}
                              {currentQ.transcribedOptions && currentQ.transcribedOptions.length > 0 && (
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2">
                                  {currentQ.transcribedOptions.map((opt, i) => {
                                    const optNum = String(i + 1);
                                    const isOptCorrect = currentQ.answer?.trim().replace(/[().]/g, "").trim() === optNum;
                                    const isSelected = currentQ.studentAnswer === optNum;
                                    return (
                                      <div key={i} className={`p-4 rounded-2xl flex items-center justify-between gap-3 ${
                                        isOptCorrect ? "bg-[#6cf8bb]/20 border border-[#006c49]/20" : isSelected ? "bg-[#ffdad6] border border-[#ba1a1a]/20" : "bg-white border border-[#e5eeff]"
                                      }`}>
                                        <div className="flex items-center gap-3 min-w-0">
                                          <span className={`w-10 h-10 rounded-full flex items-center justify-center font-headline font-bold shrink-0 ${
                                            isOptCorrect ? "bg-[#006c49] text-white" : isSelected ? "bg-[#ba1a1a] text-white" : "bg-[#eff4ff] text-[#001e40]"
                                          }`}>{i + 1}</span>
                                          <span className={`font-headline font-semibold text-base ${isOptCorrect || isSelected ? "text-[#001e40]" : "text-[#43474f]"}`}>{opt}</span>
                                        </div>
                                        {isOptCorrect && isSelected && <span className="text-xs font-bold text-[#006c49] shrink-0">Correct</span>}
                                        {isOptCorrect && !isSelected && <span className="material-symbols-outlined text-[#006c49] shrink-0" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>}
                                        {!isOptCorrect && isSelected && <span className="material-symbols-outlined text-[#ba1a1a] shrink-0" style={{ fontVariationSettings: "'FILL' 1" }}>cancel</span>}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                              {/* Subparts */}
                              {realSubs && realSubs.length > 0 && (
                                <div className="space-y-2 mt-2">
                                  {realSubs.map((sp) => {
                                    const imgSrc = sp.refImageBase64 ? toSrc(sp.refImageBase64) : sp.diagramBase64 ? toSrc(sp.diagramBase64) : null;
                                    return (
                                      <div key={sp.label}>
                                        <p className="text-sm text-[#0b1c30]">
                                          <span className="font-bold text-[#001e40]">({sp.label})</span> {sp.text}
                                        </p>
                                        {imgSrc && (
                                          // eslint-disable-next-line @next/next/no-img-element
                                          <img src={imgSrc} alt={`(${sp.label}) diagram`} className="w-full rounded-xl border border-[#e5eeff] mt-1" />
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    ) : !isStudent && currentQ.imageData ? (
                      <div className="mb-5 rounded-2xl overflow-hidden border border-[#e5eeff]">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={currentQ.imageData} alt={`Question ${currentQ.questionNum}`} className="w-full h-auto" />
                      </div>
                    ) : null}

                    {/* Submission image + solution side-by-side */}
                    <div className="md:flex gap-5">
                      {(!isQuiz || (isQuiz && currentQOeqIndex >= 0)) && !currentQ.transcribedOptions && !currentQ.transcribedOptionImages && (
                        <div className="md:w-1/2 md:shrink-0 mb-4 md:mb-0 rounded-2xl overflow-hidden border border-[#e5eeff] relative">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={isQuiz
                              ? `/api/exam/${id}/submission?page=${currentQOeqIndex}`
                              : `/api/exam/${id}/submission?page=${effectiveSubmissionPage}`}
                            alt={`Submission page for Q${currentQ.questionNum}`}
                            className="w-full h-auto"
                          />
                          {submissionPageCount > 1 && (
                            <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-black/50 rounded-full px-3 py-1">
                              <button
                                onClick={() => setSubmissionPageOverride(Math.max(0, effectiveSubmissionPage - 1))}
                                disabled={effectiveSubmissionPage === 0}
                                className="text-white/80 hover:text-white disabled:text-white/30"
                              >
                                <span className="material-symbols-outlined text-sm">chevron_left</span>
                              </button>
                              <span className="text-[10px] text-white/80 min-w-[2rem] text-center">{effectiveSubmissionPage + 1}/{submissionPageCount}</span>
                              <button
                                onClick={() => setSubmissionPageOverride(Math.min(submissionPageCount - 1, effectiveSubmissionPage + 1))}
                                disabled={effectiveSubmissionPage === submissionPageCount - 1}
                                className="text-white/80 hover:text-white disabled:text-white/30"
                              >
                                <span className="material-symbols-outlined text-sm">chevron_right</span>
                              </button>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Solutions panel */}
                      <div className="flex-1 space-y-4">
                        {/* OEQ typed answer */}
                        {currentQ.studentAnswer && !currentQ.transcribedOptions && (
                          <div>
                            <p className="text-[10px] font-extrabold uppercase tracking-widest text-[#43474f] mb-2">Your Answer</p>
                            <div className={`text-sm leading-relaxed rounded-2xl p-4 ${
                              isCorrect ? "bg-[#6cf8bb]/20 text-[#006c49]" : "bg-[#ffdad6] text-[#93000a]"
                            }`}>
                              {currentQ.studentAnswer}
                            </div>
                          </div>
                        )}

                        {/* Correct answer */}
                        {(currentQ.answer || currentQ.answerImageData) && !(isQuiz && currentQ.transcribedOptions) && (
                          <div>
                            <p className="text-[10px] font-extrabold uppercase tracking-widest text-[#43474f] mb-2">Correct Answer</p>
                            {currentQ.answer && (
                              <div className="text-sm text-[#0b1c30] leading-relaxed max-h-48 overflow-y-auto rounded-2xl bg-white p-4 border border-[#e5eeff]">
                                {renderWithNewlines(currentQ.answer)}
                              </div>
                            )}
                            {currentQ.answerImageData && (
                              <img
                                src={currentQ.answerImageData}
                                alt="Answer diagram"
                                className="mt-2 max-w-full rounded-xl border border-[#e5eeff]"
                              />
                            )}
                          </div>
                        )}

                        {/* Marking notes */}
                        {currentQ.markingNotes && (
                          <div>
                            <p className="text-[10px] font-extrabold uppercase tracking-widest text-[#43474f] mb-2">Marking Notes</p>
                            <p className="text-sm text-[#43474f] leading-relaxed">
                              {renderMarkingNotes(currentQ.markingNotes)}
                            </p>
                          </div>
                        )}

                      </div>
                    </div>

                    {/* AI Elaboration — full width below submission + solutions */}
                    {currentQ.marksAwarded !== null && (
                      <div className="mt-4">
                        {elaborations[currentQ.id] ? (
                          <div className="p-4 lg:p-5 bg-white rounded-2xl shadow-sm flex gap-3 items-start border-l-4 border-[#ffb952] lg:border-l-0 lg:bg-white/70 lg:backdrop-blur-md lg:border lg:border-white/40">
                            <div className="mt-0.5 p-1.5 bg-[#ffddb4] rounded-lg lg:hidden">
                              <span className="material-symbols-outlined text-[#633f00] text-lg" style={{ fontVariationSettings: "'FILL' 1" }}>lightbulb</span>
                            </div>
                            <div className="w-10 h-10 rounded-xl bg-[#001e40] text-white items-center justify-center shrink-0 hidden lg:flex">
                              <span className="material-symbols-outlined text-base">psychology</span>
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-bold text-[#001e40] mb-1 flex items-center gap-2">
                                AI Insight
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
                                    className="text-[10px] font-normal text-[#003366] hover:underline normal-case"
                                  >
                                    Save
                                  </button>
                                )}
                              </p>
                              {!isStudent ? (
                                <textarea
                                  value={elaborations[currentQ.id]}
                                  onChange={e => setElaborations(prev => ({ ...prev, [currentQ.id]: e.target.value }))}
                                  rows={5}
                                  className="w-full text-sm text-[#43474f] leading-relaxed rounded-xl bg-[#eff4ff] border border-[#c3c6d1] p-3 focus:outline-none focus:border-[#001e40] resize-y"
                                />
                              ) : (
                                <p className="text-sm text-[#43474f] leading-relaxed whitespace-pre-line">{elaborations[currentQ.id]}</p>
                              )}
                            </div>
                          </div>
                        ) : (
                          <button
                            onClick={() => fetchElaboration(currentQ.id)}
                            disabled={elaborating === currentQ.id}
                            className="w-full h-14 bg-gradient-to-r from-[#001e40] to-[#003366] hover:from-[#003366] hover:to-[#001e40] text-white rounded-2xl flex items-center justify-center gap-3 font-headline font-bold transition-all shadow-md active:scale-95 disabled:opacity-50"
                          >
                            <span className="material-symbols-outlined">psychology_alt</span>
                            {elaborating === currentQ.id ? (
                              <span className="flex items-center gap-2">
                                <span className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white inline-block" />
                                Generating…
                              </span>
                            ) : "AI Elaboration"}
                          </button>
                        )}
                      </div>
                    )}

                    {/* Flag toggle — bottom center */}
                    <div className="mt-6 pt-5 border-t border-[#e5eeff] flex justify-center">
                      <button
                        onClick={() => toggleFlag(currentQ.id)}
                        disabled={flagging === currentQ.id}
                        className={`flex flex-col items-center gap-1 transition-all disabled:opacity-50 group ${
                          flaggedIds.has(currentQ.id) ? "text-[#ba1a1a]" : "text-[#43474f] opacity-60 hover:opacity-100 hover:text-[#001e40]"
                        }`}
                      >
                        {/* Triangle on mobile, flag on desktop */}
                        <span
                          className="material-symbols-outlined text-3xl lg:hidden transform rotate-180"
                          style={flaggedIds.has(currentQ.id) ? { fontVariationSettings: "'FILL' 1" } : {}}
                        >
                          change_history
                        </span>
                        <span
                          className="material-symbols-outlined text-3xl hidden lg:block"
                          style={flaggedIds.has(currentQ.id) ? { fontVariationSettings: "'FILL' 1" } : {}}
                        >
                          flag
                        </span>
                        <span className="text-[10px] font-bold uppercase tracking-wider">
                          {flaggedIds.has(currentQ.id) ? "Flagged" : "Flag for Review"}
                        </span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
