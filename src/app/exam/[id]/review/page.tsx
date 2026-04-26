"use client";

import { Suspense, useEffect, useRef, useState, use } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { jsPDF } from "jspdf";
import FormattedText from "@/components/FormattedText";
import { VisualTextImages } from "@/components/EnglishQuizSection";
import { ReviewPenOverlay } from "@/components/ReviewPenOverlay";
import { playClick } from "@/lib/sfx";
import React from "react";

/** Submission image with spinner while loading */
function SubmissionImage({ src, alt, className, aspectRatio, onError }: {
  src: string; alt: string; className?: string; aspectRatio?: string;
  onError?: (e: React.SyntheticEvent<HTMLImageElement>) => void;
}) {
  const [loading, setLoading] = useState(true);
  // Reset loading when src changes
  const prevSrc = React.useRef(src);
  if (prevSrc.current !== src) { prevSrc.current = src; if (!loading) setLoading(true); }
  return (
    <div className="relative" style={aspectRatio ? { aspectRatio } : undefined}>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-50/80 z-10 rounded-2xl">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" />
        </div>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={src}
        src={src}
        alt={alt}
        className={className}
        onLoad={() => setLoading(false)}
        onError={(e) => { setLoading(false); onError?.(e); }}
      />
    </div>
  );
}

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

interface ReviewQuestion {
  orderIndex: number;
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
  syllabusTopic?: string | null;
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
  // Parent's red-pen review annotations: keyed by 'passage:<sectionLabel>'
  // or 'question:<questionId>', value is a PNG data URL.
  reviewAnnotations?: Record<string, string> | null;
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
  const [skipPages, setSkipPages] = useState<number[]>([]);
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
  const [paperType, setPaperType] = useState<string | null>(null);
  const [canvasHeights, setCanvasHeights] = useState<Record<string, number>>({});
  const [oeqPageMap, setOeqPageMap] = useState<Record<string, number> | null>(null);
  const [releasing, setReleasing] = useState(false);
  const [englishSections, setEnglishSections] = useState<Array<{ label: string; startIndex: number; endIndex: number; passage?: string }> | null>(null);
  const [expandedElabs, setExpandedElabs] = useState<Set<string>>(new Set());
  const [editingMarks, setEditingMarks] = useState<string | null>(null);
  const [savingMarks, setSavingMarks] = useState(false);
  const [remarking, setRemarking] = useState(false);
  const [advisoryDismissed, setAdvisoryDismissed] = useState(false);
  const [released, setReleased] = useState(false);
  const [pendingReviewIds, setPendingReviewIds] = useState<string[]>([]);
  const [sticker, setSticker] = useState<string | null>(null);
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  const isDiagnostic = searchParams?.get("diagnostic") === "1";
  const diagnosticParentId = searchParams?.get("parentId") ?? "";
  const [showFirstQuizPopup, setShowFirstQuizPopup] = useState(false);
  // Show a one-time congratulations popup when the student lands on the review page from
  // their first diagnostic quiz (URL has ?diagnostic=1&parentId=...).
  useEffect(() => {
    if (!isDiagnostic || !data || !isQuiz) return;
    if (data.markingStatus !== "complete" && data.markingStatus !== "released") return;
    setShowFirstQuizPopup(true);
  }, [isDiagnostic, data, isQuiz]);

  // Fire a confetti + star volley once, when the student opens the review for
  // the first time with a final percentage ≥ 90%. Guarded in two places:
  //   * celebrationFiredRef — blocks re-firing within the same mount (e.g.
  //     parent mark edits re-triggering data).
  //   * localStorage mfy-celebration-shown-<paperId> — blocks replay across
  //     visits, so revisiting an old high-scoring quiz doesn't re-celebrate.
  const celebrationFiredRef = useRef(false);
  useEffect(() => {
    if (!data || celebrationFiredRef.current) return;
    if (data.markingStatus !== "complete" && data.markingStatus !== "released") return;
    if (typeof window === "undefined") return;
    const celebrationKey = `mfy-celebration-shown-${id}`;
    if (localStorage.getItem(celebrationKey)) return;
    const rawTotal = totalMarks ? Number(totalMarks) : null;
    if (!rawTotal || rawTotal <= 0) return;
    const skippedMarks = data.questions
      .filter(q => q.studentAnswer === "__SKIPPED__")
      .reduce((s, q) => s + (q.marksAvailable ?? 0), 0);
    const totalM = Math.max(0, rawTotal - skippedMarks);
    if (totalM <= 0) return;
    const pctValue = Math.min(100, Math.round(((data.score ?? 0) / totalM) * 100));
    if (pctValue < 90) return;
    celebrationFiredRef.current = true;
    localStorage.setItem(celebrationKey, "1");
    (async () => {
      // Slight celebratory haptic on mobile — a short pop for the main volley
      // and a two-tap burst when the stars fire. No-ops on iOS Safari / desktop.
      const buzz = (pattern: number | number[]) => {
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
          try { navigator.vibrate(pattern); } catch { /* ignore */ }
        }
      };
      // Soft crowd cheer from /public/sounds/cheer.mp3 (or .ogg). If the file
      // is missing the load silently fails and we skip audio — so it's safe to
      // ship without the asset and drop it in later.
      try {
        const audio = new Audio("/sounds/cheer.mp3");
        audio.volume = 0.10;
        audio.play().catch(() => { /* browser blocked or file missing */ });
      } catch { /* ignore */ }
      try {
        const confetti = (await import("canvas-confetti")).default;
        buzz(60);
        confetti({
          particleCount: 120, spread: 80, startVelocity: 50,
          origin: { x: 0.5, y: 0.15 },
          colors: ["#6cf8bb", "#ffd700", "#ff6ec7", "#7fd1ff", "#a78bfa"],
        });
        setTimeout(() => {
          buzz([30, 50, 30]);
          confetti({
            particleCount: 40, spread: 70, startVelocity: 45,
            origin: { x: 0.1, y: 0.2 },
            shapes: ["star"], colors: ["#ffd700", "#fff4a3", "#ffb800"],
          });
          confetti({
            particleCount: 40, spread: 70, startVelocity: 45,
            origin: { x: 0.9, y: 0.2 },
            shapes: ["star"], colors: ["#ffd700", "#fff4a3", "#ffb800"],
          });
        }, 250);
      } catch { /* canvas-confetti optional */ }
    })();
  }, [data, totalMarks]);

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
          setPaperType(paper.paperType ?? null);
          setAnswerPages(paper.metadata?.answerPages ?? []);
          setSkipPages(paper.metadata?.skipPages ?? []);
          if (paper.metadata?.englishSections) setEnglishSections(paper.metadata.englishSections);
          if (paper.metadata?.sticker) setSticker(paper.metadata.sticker);
          if (paper.metadata?.canvasHeights) setCanvasHeights(paper.metadata.canvasHeights as Record<string, number>);
          if (paper.metadata?.oeqPageMap) setOeqPageMap(paper.metadata.oeqPageMap as Record<string, number>);
          setPageCount(paper.pageCount ?? 0);
          const ap = paper.metadata?.answerPages ?? [];
          const sp = paper.metadata?.skipPages ?? [];
          setSubmissionPageCount((paper.pageCount ?? 0) - ap.length - sp.length);
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

  // Fetch pending review papers for "Reviewed, next" button
  useEffect(() => {
    if (!assignedToId || !userId || userId === assignedToId) return; // only for parents
    fetch(`/api/exam?userId=${userId}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d?.papers) return;
        // Find papers assigned to this student that are completed but not released
        const pending = (d.papers as Array<{ id: string; assignedToId: string; completedAt: string | null; markingStatus: string | null }>)
          .filter(p => p.assignedToId === assignedToId && p.completedAt && p.markingStatus === "complete")
          .map(p => p.id)
          .filter(pid => pid !== id); // exclude current
        setPendingReviewIds(pending);
      })
      .catch(() => {});
  }, [assignedToId, userId, id]);

  function getSubmissionPage(originalPageIdx: number): number {
    const hiddenSet = new Set([
      ...answerPages.map((p) => p - 1),
      ...skipPages.map((p) => p - 1),
    ]);
    let idx = 0;
    for (let i = 0; i < pageCount; i++) {
      if (!hiddenSet.has(i)) {
        if (i === originalPageIdx) return idx;
        idx++;
      }
    }
    return originalPageIdx;
  }

  async function handleRemark() {
    if (!confirm("Re-mark this paper? This will re-run AI marking on all questions and override any manual score changes.")) return;
    setRemarking(true);
    console.log(`[review] Re-mark requested for paper ${id}`);
    try {
      const res = await fetch(`/api/exam/${id}/mark`, { method: "POST" });
      console.log(`[review] Re-mark POST → status ${res.status}`);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        alert(`Re-mark failed (HTTP ${res.status}): ${body || "no body"}`);
        setRemarking(false);
        return;
      }
      // Land parents on the selected-student progress view so they can see marking progress
      const isStudentSelf = userId === assignedToId;
      const target = assignedToId && !isStudentSelf
        ? `/home/${userId}?view=progress&student=${assignedToId}`
        : `/home/${userId}`;
      router.push(target);
    } catch (err) {
      console.error(`[review] Re-mark fetch threw`, err);
      alert(`Re-mark failed: ${err instanceof Error ? err.message : String(err)}`);
      setRemarking(false);
    }
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

  async function saveSticker(stickerName: string) {
    setShowStickerPicker(false);
    setSticker(stickerName || null);
    try {
      const paperRes = await fetch(`/api/exam/${id}`);
      if (!paperRes.ok) return;
      const paperData = await paperRes.json();
      const meta = paperData.metadata ?? {};
      await fetch(`/api/exam/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata: { ...meta, sticker: stickerName || null } }),
      });
    } catch (err) {
      console.error("Failed to save sticker:", err);
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
    if (elaborations[questionId]) {
      // Already fetched — just expand
      setExpandedElabs(prev => new Set(prev).add(questionId));
      return;
    }
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
        // Auto-expand after fetch completes
        setExpandedElabs(prev => new Set(prev).add(questionId));
      }
    } catch {
      // ignore
    } finally {
      setElaborating(null);
    }
  }

  async function updateMarks(questionId: string, newMarks: number) {
    setSavingMarks(true);
    try {
      const res = await fetch(`/api/exam/questions/${questionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marksAwarded: newMarks }),
      });
      if (res.ok) {
        setData((prev) => {
          if (!prev) return prev;
          const questions = prev.questions.map((q) =>
            q.id === questionId ? { ...q, marksAwarded: newMarks } : q
          );
          const newScore = questions.reduce((sum, q) => sum + (q.marksAwarded ?? 0), 0);
          return { ...prev, questions, score: newScore };
        });
      }
    } catch {
      // ignore
    } finally {
      setSavingMarks(false);
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
  // When a student goes back from a completed quiz, ferry the score into the
  // home URL so the experience bar can animate the points flowing in. The
  // student dashboard will replay the animation only once per paper (guarded
  // by localStorage), then strip the params.
  const canCelebrateBack = isStudent && isQuiz && (data?.markingStatus === "complete" || data?.markingStatus === "released") && (data?.score ?? 0) > 0;
  const backPath = assignedToId && !isStudent
    ? `/home/${userId}?view=progress&student=${assignedToId}`
    : canCelebrateBack
      ? `/home/${userId}?view=progress&newPoints=${data!.score}&fromPaper=${id}`
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
          <button onClick={() => { playClick(); router.replace(backPath); }} className="px-6 py-2.5 rounded-2xl bg-[#001e40] text-white font-bold text-sm">
            Go Home
          </button>
        </div>
      </div>
    );
  }

  // Students can only see results once released (or instant feedback)
  if (isStudent && data.markingStatus !== "released" && !(instantFeedback && data.markingStatus === "complete") && !(isQuiz && instantFeedback)) {
    return (
      <div className="min-h-screen bg-[#f8f9ff] flex items-center justify-center p-6 text-center">
        <div>
          <p className="text-[#43474f] mb-4">Results are not available yet.</p>
          <button onClick={() => { playClick(); router.replace(backPath); }} className="px-6 py-2.5 rounded-2xl bg-[#001e40] text-white font-bold text-sm">
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

  // Build display items: collapse typed English sections into single entries
  type DisplayItem = { type: "question"; question: ReviewQuestion } | { type: "section"; section: typeof englishSections extends (infer T)[] | null ? NonNullable<T> : never; questions: ReviewQuestion[] };
  const baseQuestions = showAll ? writtenQuestions : incorrectQuestions;
  const displayItems: DisplayItem[] = [];
  const sectionQIds = new Set<string>();

  if (englishSections) {
    // Find which sections are typed (shown as a group)
    for (const sec of englishSections) {
      const label = sec.label.toLowerCase();
      const isGrouped = label.includes("grammar cloze") || label.includes("editing") ||
        label.includes("comprehension cloze") || (label.includes("comp") && label.includes("cloze")) ||
        label.includes("vocab cloze") || (label.includes("vocab") && label.includes("cloze")) ||
        label.includes("synthesis") || label.includes("comprehension oeq") || label.includes("comprehension open") ||
        // Visual Text: the poster/article image is the passage, shared across all
        // questions in the section. Grouping keeps the passage on top and lists
        // all answers below instead of repeating the image per question.
        (label.includes("visual") && label.includes("text"));
      if (isGrouped) {
        const secQs = data.questions.slice(sec.startIndex, sec.endIndex + 1);
        const hasRelevant = secQs.some(q => baseQuestions.some(bq => bq.id === q.id));
        if (hasRelevant) {
          displayItems.push({ type: "section", section: sec, questions: secQs });
          for (const q of secQs) sectionQIds.add(q.id);
        }
      }
    }
  }
  // Add individual questions that aren't part of grouped sections
  for (const q of baseQuestions) {
    if (!sectionQIds.has(q.id)) {
      displayItems.push({ type: "question", question: q });
    }
  }
  // Sort by first question's position in data.questions
  displayItems.sort((a, b) => {
    const aIdx = data.questions.findIndex(q => q.id === (a.type === "question" ? a.question.id : a.questions[0]?.id));
    const bIdx = data.questions.findIndex(q => q.id === (b.type === "question" ? b.question.id : b.questions[0]?.id));
    return aIdx - bIdx;
  });

  const currentItem = displayItems[currentIdx] ?? null;
  const currentQ = currentItem?.type === "question" ? currentItem.question : (currentItem?.type === "section" ? currentItem.questions[0] : null);

  // Detect if current item is a typed section
  const currentSection = currentItem?.type === "section" ? currentItem.section : null;
  const currentSectionLabel = currentSection?.label.toLowerCase() ?? "";
  const isTypedSection = currentItem?.type === "section";
  const sectionQuestions = currentItem?.type === "section" ? currentItem.questions : [];

  // For quiz OEQ: determine submission page index for the current question.
  // Prefer stored oeqPageMap (set at submission time) to avoid mismatches when
  // MCQ/OEQ classification logic changes between quiz-taking and review.
  const hasOpts = (q: ReviewQuestion) => (Array.isArray(q.transcribedOptions) && q.transcribedOptions.length === 4) || (Array.isArray(q.transcribedOptionImages) && q.transcribedOptionImages.some(o => !!o));
  const allOeqQuestions = data.questions.filter(q => !hasOpts(q));
  const currentQOeqIndex = currentQ ? allOeqQuestions.findIndex(q => q.id === currentQ.id) : -1;
  // Use stored page map when available (set at submission time, immune to code changes).
  // Otherwise fall back to calculated OEQ index using current options-based classification.
  const currentQSubmissionPage = currentQ && oeqPageMap && currentQ.id in oeqPageMap
    ? oeqPageMap[currentQ.id]
    : currentQOeqIndex;

  const baseSubmissionPage = currentQ ? getSubmissionPage(currentQ.pageIndex) : 0;
  const effectiveSubmissionPage = submissionPageOverride ?? baseSubmissionPage;

  // Skipped questions still appear in review, but their marks are excluded from the denominator.
  const skippedQs = data.questions.filter(q => q.studentAnswer === "__SKIPPED__");
  const skippedMarks = skippedQs.reduce((s, q) => s + (q.marksAvailable ?? 0), 0);
  const effectiveScore = (data.score ?? 0);
  const rawTotal = totalMarks ? Number(totalMarks) : null;
  const totalM = rawTotal !== null ? Math.max(0, rawTotal - skippedMarks) : null;
  // Only show a percentage once the paper has actually been marked. Otherwise
  // effectiveScore is 0, the ring renders 0% and the "Perfect score!" branch
  // (incorrectQuestions.length === 0) fires incorrectly for an unmarked paper.
  const isMarked = data.markingStatus === "complete" || data.markingStatus === "released";
  const pct = isMarked && totalM && totalM > 0 ? Math.min(100, Math.round((effectiveScore / totalM) * 100)) : null;
  const denominatorLabel = rawTotal !== null
    ? (skippedMarks > 0 ? `${rawTotal} − ${skippedMarks} skipped` : String(rawTotal))
    : "";
  // Compute weak topics: group by syllabusTopic, take topics with marks awarded < 60%, lowest 3.
  const weakTopics: string[] = (() => {
    const byTopic: Record<string, { awarded: number; available: number }> = {};
    for (const q of data.questions) {
      const topic = (q.syllabusTopic ?? "").trim();
      if (!topic) continue;
      if (q.studentAnswer === "__SKIPPED__") continue;
      const a = q.marksAvailable ?? 0;
      if (a <= 0) continue;
      if (!byTopic[topic]) byTopic[topic] = { awarded: 0, available: 0 };
      byTopic[topic].awarded += q.marksAwarded ?? 0;
      byTopic[topic].available += a;
    }
    return Object.entries(byTopic)
      .filter(([, v]) => v.available > 0 && v.awarded / v.available < 0.6)
      .sort((a, b) => (a[1].awarded / a[1].available) - (b[1].awarded / b[1].available))
      .slice(0, 3)
      .map(([t]) => t);
  })();
  // Friendly one-liner encouragement based on percentage
  const encouragement = !isMarked ? "Not marked yet"
    : pct === null ? "Keep going!"
    : pct >= 90 ? "Outstanding work!"
    : pct >= 80 ? "Excellent work!"
    : pct >= 70 ? "Great job!"
    : pct >= 60 ? "Good effort!"
    : pct >= 40 ? "Keep practising!"
    : "Don't give up — let's review!";
  const scoreBorderColor = pct === null ? "#d3e4fe"
    : pct >= 75 ? "#6cf8bb"
    : pct >= 50 ? "#ffb952"
    : "#ffdad6";
  const scoreTextColor = pct === null ? "#001e40"
    : pct >= 75 ? "#006c49"
    : pct >= 50 ? "#633f00"
    : "#ba1a1a";

  // Parse multi-part answer string by finding known subpart labels in the text
  function parsePartAnswers(text: string | null, knownLabels?: string[]): Record<string, string> {
    if (!text) return {};
    const lower = text.toLowerCase();
    const labels = knownLabels ?? ["a", "b", "c", "d", "e", "f"];

    // Find each label's position in the text
    const found: { label: string; start: number; matchStart: number }[] = [];
    for (const label of labels) {
      const lbl = label.toLowerCase();
      // Try patterns in order of specificity:
      // 1. "(label)"  e.g. "(a)"
      // 2. "label)"   e.g. "a)" — no opening paren
      // 3. "Nlabel:"  e.g. "36a:" — question-number prefixed
      // 4. bare complex labels like "a(i)"
      const bracketed = `(${lbl})`;
      let pos = lower.indexOf(bracketed);
      if (pos !== -1) {
        let end = pos + bracketed.length;
        while (end < text.length && text[end] === " ") end++;
        found.push({ label: lbl, start: end, matchStart: pos });
        continue;
      }
      // Try "label)" pattern at word boundary (e.g. "a) 3", "b) VW")
      const closeParenRe = new RegExp(`(?:^|[\\s|])${lbl}\\)\\s*`, "i");
      const closeMatch = lower.match(closeParenRe);
      if (closeMatch && closeMatch.index !== undefined) {
        const matchStart = closeMatch.index + (closeMatch[0].startsWith(lbl) ? 0 : 1);
        const end = closeMatch.index + closeMatch[0].length;
        found.push({ label: lbl, start: end, matchStart });
        continue;
      }
      // Try "Nlabel" pattern (e.g. "7a ", "36a:", "14b:")
      const numPrefixRe = new RegExp(`\\d+${lbl}[\\s:)]+`, "i");
      const numMatch = lower.match(numPrefixRe);
      if (numMatch && numMatch.index !== undefined) {
        const end = numMatch.index + numMatch[0].length;
        found.push({ label: lbl, start: end, matchStart: numMatch.index });
        continue;
      }
      // For complex labels like "a(i)", find them directly
      if (lbl.length > 1) {
        pos = lower.indexOf(lbl);
        if (pos !== -1) {
          let end = pos + lbl.length;
          while (end < text.length && text[end] === " ") end++;
          found.push({ label: lbl, start: end, matchStart: pos });
        }
      }
    }

    if (found.length === 0) {
      // No labelled parts found at all — if there's exactly one known label
      // and the text is non-empty, assign the entire text to that label.
      // This handles standalone answers like "50 cm" for a merged (c) part.
      if (knownLabels && knownLabels.length === 1 && text.trim()) {
        return { [knownLabels[0].toLowerCase()]: text.trim() };
      }
      return {};
    }
    found.sort((a, b) => a.matchStart - b.matchStart);

    const parts: Record<string, string> = {};

    // Text BEFORE the first found label may belong to a missing earlier label.
    // E.g. answer = "The frictional force... | (b) Cause: Plastic..."
    //   with labels [a,b] — text before (b) is part (a)'s answer.
    if (knownLabels && found.length > 0) {
      const beforeFirst = text.slice(0, found[0].matchStart).trim();
      if (beforeFirst) {
        const earlierMissing = knownLabels
          .map(l => l.toLowerCase())
          .filter(l => !found.some(f => f.label === l) && l < found[0].label);
        if (earlierMissing.length === 1) {
          parts[earlierMissing[0]] = beforeFirst;
        }
      }
    }

    for (let i = 0; i < found.length; i++) {
      const end = i + 1 < found.length ? found[i + 1].matchStart : text.length;
      parts[found[i].label] = text.slice(found[i].start, end).trim();
    }

    // Text AFTER the last found label may contain answers for missing later labels.
    // E.g. answer = "(a) 12 (b) 25\n50 cm" with labels [a,b,c]:
    //   "50 cm" after newline is part (c)'s answer.
    if (knownLabels) {
      const missing = knownLabels.map(l => l.toLowerCase()).filter(l => !(l in parts));
      if (missing.length > 0 && found.length > 0) {
        const lastLabel = found[found.length - 1].label;
        const lastVal = parts[lastLabel] ?? "";
        const lines = lastVal.split("\n").map(l => l.trim()).filter(Boolean);
        if (lines.length > 1 && lines.length - 1 >= missing.length) {
          parts[lastLabel] = lines[0];
          for (let m = 0; m < missing.length && m + 1 < lines.length; m++) {
            parts[missing[m]] = lines[m + 1];
          }
        }
      }
    }

    return parts;
  }

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

  // Renders marking notes: bolds verdict labels and **keyword** markers
  function renderMarkingNotes(text: string) {
    return text.split("|").map((part, i, arr) => {
      const trimmed = part.trim();
      const boldRe = /(\*\*[^*\n]+\*\*|\([a-zA-Z]\)\s+(?:Partially\s+)?(?:Correct|Incorrect))/gi;
      const segments: React.ReactNode[] = [];
      let last = 0;
      let m: RegExpExecArray | null;
      while ((m = boldRe.exec(trimmed)) !== null) {
        if (m.index > last) segments.push(trimmed.slice(last, m.index));
        const raw = m[1];
        const label = raw.startsWith("**") ? raw.slice(2, -2) : raw;
        segments.push(<strong key={m.index}>{label}</strong>);
        last = m.index + raw.length;
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
      {/* First-quiz congratulations popup — shown when the student lands here from the diagnostic flow */}
      {showFirstQuizPopup && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-[100] p-4"
          onClick={() => setShowFirstQuizPopup(false)}
        >
          <div
            className="bg-white rounded-3xl max-w-md w-full p-8 shadow-2xl text-center animate-[popIn_0.5s_cubic-bezier(0.34,1.56,0.64,1)]"
            onClick={e => e.stopPropagation()}
          >
            <div className="w-20 h-20 rounded-full bg-[#6cf8bb]/30 flex items-center justify-center mx-auto mb-4">
              <span className="material-symbols-outlined text-4xl text-[#006c49]" style={{ fontVariationSettings: "'FILL' 1" }}>celebration</span>
            </div>
            <h2 className="font-headline text-2xl font-extrabold text-[#001e40] mb-3">Congratulations on finishing your first quiz!</h2>
            <p className="text-sm text-[#43474f] leading-relaxed mb-6">
              With each quiz, the AI gets smarter in identifying weak areas. You can build <strong className="font-bold text-[#001e40]">focused practices</strong> for those. Click &ldquo;Open parent homepage&rdquo; when you are done reviewing this quiz with your student.
            </p>
            <button
              onClick={() => setShowFirstQuizPopup(false)}
              className="px-8 py-3 rounded-2xl bg-[#001e40] text-white font-bold hover:bg-[#003366] transition-colors"
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {/* ── Top bar ── */}
      <header className="fixed top-0 w-full z-50 bg-[#f8f9ff] backdrop-blur-xl shadow-sm">
        {/* Mobile: centered title */}
        <div className="lg:hidden flex items-center justify-between px-4 h-16">
          <button
            onClick={() => { playClick(); router.replace(backPath); }}
            className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-[#eff4ff] transition-colors"
          >
            <span className="material-symbols-outlined text-[#001e40]">arrow_back</span>
          </button>
          <h1 className="font-headline font-bold text-lg text-[#001e40]">{isQuiz ? "Quiz Review" : "Exam Review"}</h1>
          {!isQuiz ? (
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
              onClick={() => { playClick(); router.replace(backPath); }}
              className="p-2 rounded-xl text-[#43474f] hover:bg-[#eff4ff] transition-colors shrink-0"
            >
              <span className="material-symbols-outlined">arrow_back</span>
            </button>
            <p className="font-headline font-bold text-[#001e40] truncate">{paperTitle}</p>
          </div>
          <div className="flex items-center gap-3">
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

      <div className="pt-16 pb-24 max-w-5xl mx-auto px-4 lg:px-8 relative">

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
                  {pct !== null ? `${pct}%` : isMarked ? `${data.score ?? 0}` : "—"}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="font-headline font-bold text-xl text-[#001e40]">
                  {pct !== null ? `${pct}% ${encouragement}` : encouragement}
                </h2>
                {weakTopics.length > 0 && (
                  <>
                    <p className="text-[10px] font-bold uppercase tracking-wider text-[#43474f] mt-2 mb-1">Weak areas identified</p>
                    <div className="flex gap-1.5 flex-wrap">
                      {weakTopics.map(t => (
                        <span key={t} className="px-2.5 py-0.5 bg-[#ffdad6] rounded-full text-[10px] font-bold text-[#ba1a1a]">{t}</span>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
            {/* Sticker top-right corner */}
            {sticker && (
              <div className="absolute top-3 right-3 z-10 group-open:hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/stickers/${sticker}`} alt="Sticker" className="w-20 h-20 object-contain drop-shadow-md" />
              </div>
            )}
            {/* Detailed AI summary tucked away — keeps the panel simple */}
            {data.feedbackSummary && (
              <details className="mt-3">
                <summary className="text-[10px] font-semibold text-[#43474f]/70 uppercase tracking-wide cursor-pointer select-none">More details</summary>
                <p className="text-xs text-[#43474f] leading-relaxed whitespace-pre-line mt-2 max-h-32 overflow-y-auto">{data.feedbackSummary}</p>
              </details>
            )}
            {/* Sticker button */}
            {!isStudent && (
              <div className="mt-3 relative">
                {!sticker ? (
                  <>
                    <button onClick={() => setShowStickerPicker(!showStickerPicker)} className="flex items-center gap-1.5 text-xs font-bold text-[#291800] bg-[#ffddb4] px-3 py-1.5 rounded-full hover:bg-[#ffcf94] transition-colors">
                      <span className="material-symbols-outlined text-sm">add_reaction</span>Add Sticker
                    </button>
                    {/* picker rendered as global modal below */}
                  </>
                ) : (
                  <button onClick={() => saveSticker("")} className="flex items-center gap-1 text-[10px] font-medium text-[#43474f] hover:text-[#ba1a1a] transition-colors">
                    <span className="material-symbols-outlined text-xs">close</span>Remove Sticker
                  </button>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Desktop: bento grid */}
        <section className="hidden lg:grid grid-cols-3 gap-6 my-10">
          <div className="col-span-2 bg-white rounded-3xl p-8 flex flex-row items-center gap-8 relative overflow-hidden shadow-sm">
            <div className="absolute top-0 right-0 w-64 h-64 bg-[#6cf8bb]/10 rounded-full -mr-20 -mt-20 blur-3xl" />
            {sticker && (
              <div className="absolute top-4 right-4 z-20">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/stickers/${sticker}`} alt="Sticker" className="w-36 h-36 object-contain drop-shadow-lg" />
              </div>
            )}
            <div
              className="relative z-10 flex flex-col items-center justify-center w-44 h-44 rounded-full shrink-0"
              style={{ background: `radial-gradient(closest-side, white 82%, transparent 82%), conic-gradient(${scoreBorderColor} ${pct ?? 0}%, #dce9ff 0)` }}
            >
              <span className="font-headline text-5xl font-extrabold" style={{ color: scoreTextColor }}>
                {pct !== null ? `${pct}%` : isMarked ? `${data.score ?? 0}` : "—"}
              </span>
              <span className="text-xs font-medium text-[#43474f] mt-1">
                {pct !== null ? `${data.score ?? 0} / ${denominatorLabel}` : isMarked ? "Score" : "Not marked"}
              </span>
            </div>
            <div className="flex-1">
              <h1 className="font-headline text-3xl font-extrabold text-[#001e40] mb-2">
                {pct !== null ? `${pct}% ${encouragement}` : encouragement}
              </h1>
              {weakTopics.length > 0 && (
                <div className="mb-3">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-[#43474f] mb-1.5">Weak areas identified</p>
                  <div className="flex gap-2 flex-wrap">
                    {weakTopics.map(t => (
                      <span key={t} className="px-3 py-1 bg-[#ffdad6] rounded-full text-xs font-bold text-[#ba1a1a]">{t}</span>
                    ))}
                  </div>
                </div>
              )}
              {data.feedbackSummary && (
                <details className="mb-4">
                  <summary className="text-[10px] font-semibold text-[#43474f]/70 uppercase tracking-wide cursor-pointer hover:text-[#001e40] select-none">More details</summary>
                  <p className="text-sm text-[#43474f] leading-relaxed whitespace-pre-line mt-2 max-h-32 overflow-y-auto">{data.feedbackSummary}</p>
                </details>
              )}
              {data.bookletScores && data.bookletScores.length > 0 && (
                <div className="flex flex-wrap gap-3">
                  {data.bookletScores.map((b) => (
                    <span key={b.label} className="px-3 py-1 bg-[#eff4ff] rounded-full text-xs font-bold text-[#001e40]">
                      {b.label}: {b.awarded}/{b.available}
                    </span>
                  ))}
                </div>
              )}
              {/* Sticker button (parent) */}
              {!isStudent && (
                <div className="mt-3 relative">
                  {!sticker ? (
                    <>
                      <button onClick={() => setShowStickerPicker(!showStickerPicker)} className="flex items-center gap-1.5 text-xs font-bold text-[#291800] bg-[#ffddb4] px-3 py-1.5 rounded-full hover:bg-[#ffcf94] transition-colors">
                        <span className="material-symbols-outlined text-sm">add_reaction</span>Add Sticker
                      </button>
                      {/* picker rendered as global modal below */}
                    </>
                  ) : (
                    <button onClick={() => saveSticker("")} className="flex items-center gap-1 text-[10px] font-medium text-[#43474f] hover:text-[#ba1a1a] transition-colors">
                      <span className="material-symbols-outlined text-xs">close</span>Remove Sticker
                    </button>
                  )}
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
            {/* Diagnostic flow only — open parent homepage in a new tab */}
            {isDiagnostic && diagnosticParentId && (
              <button
                onClick={() => window.open(`/home/${diagnosticParentId}?diagnosticWelcome=1`, "_blank")}
                className="bg-[#003366] text-white rounded-3xl p-5 flex items-center justify-center gap-3 shadow-md hover:bg-[#001e40] transition-colors font-bold text-sm"
              >
                <span className="material-symbols-outlined">open_in_new</span>
                Open parent homepage
              </button>
            )}
          </div>
        </section>

        {/* Mobile-only diagnostic CTA — same intent, sits below the score card */}
        {isDiagnostic && diagnosticParentId && (
          <button
            onClick={() => window.open(`/home/${diagnosticParentId}?diagnosticWelcome=1`, "_blank")}
            className="lg:hidden w-full bg-[#003366] text-white rounded-2xl p-4 flex items-center justify-center gap-2 shadow-md hover:bg-[#001e40] transition-colors font-bold text-sm mb-5"
          >
            <span className="material-symbols-outlined text-base">open_in_new</span>
            Open parent homepage
          </button>
        )}

        {/* Advisory — parents only */}
        {!isStudent && !advisoryDismissed && (
          <div className="rounded-2xl bg-blue-50 border border-blue-200 px-4 py-3 mb-6 flex items-start gap-3">
            <span className="material-symbols-outlined text-blue-600 shrink-0 mt-0.5">info</span>
            <p className="text-sm text-blue-700 leading-relaxed flex-1">
              We encourage you to review your child&apos;s mistakes together and discuss the correct approach.
            </p>
            <button onClick={() => setAdvisoryDismissed(true)} className="shrink-0 text-blue-400 hover:text-blue-600 transition-colors">
              <span className="material-symbols-outlined text-lg">close</span>
            </button>
          </div>
        )}

        {/* Remark button — parents, or anyone for English quizzes */}
        {(!isStudent || englishSections) && (
          <div className="mb-4 flex justify-end gap-2">
            {!isStudent && !released && (
              <>
                <button
                  onClick={handleRelease}
                  disabled={releasing}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl border-2 border-[#006c49] text-[#006c49] text-sm font-bold hover:bg-[#006c49]/10 transition-all disabled:opacity-50"
                >
                  <span className="material-symbols-outlined text-base">check_circle</span>
                  {releasing ? "Saving…" : "Mark as Reviewed"}
                </button>
                {pendingReviewIds.length > 0 && (
                  <button
                    onClick={async () => {
                      setReleasing(true);
                      try {
                        await fetch(`/api/exam/${id}`, {
                          method: "PATCH",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ markingStatus: "released" }),
                        });
                        router.push(`/exam/${pendingReviewIds[0]}/review?userId=${userId}`);
                      } catch {
                        setReleasing(false);
                      }
                    }}
                    disabled={releasing}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-[#006c49] text-white text-sm font-bold hover:bg-[#004d35] transition-all disabled:opacity-50"
                  >
                    Reviewed, next
                    <span className="material-symbols-outlined text-base">arrow_forward</span>
                  </button>
                )}
              </>
            )}
            {released && !isStudent && (
              <span className="flex items-center gap-1.5 px-4 py-2 text-sm font-bold text-[#006c49]">
                <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>Reviewed
              </span>
            )}
            <button
              onClick={handleRemark}
              disabled={remarking}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white border border-[#c3c6d1]/30 text-sm font-bold text-[#43474f] hover:bg-[#eff4ff] hover:text-[#001e40] transition-all disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-base">refresh</span>
              {remarking ? "Re-marking…" : englishSections ? "Re-mark All" : "Re-mark"}
            </button>
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
        {displayItems.length === 0 ? (
          <div className="text-center py-16 bg-white rounded-3xl shadow-sm">
            {!isMarked ? (
              <>
                <div className="text-5xl mb-4">⏳</div>
                <p className="font-headline text-xl font-extrabold text-[#001e40] mb-1">Not marked yet</p>
                <p className="text-sm text-[#43474f]">This paper hasn&apos;t been AI-marked. Come back once marking is complete.</p>
              </>
            ) : incorrectQuestions.length === 0 ? (
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
                  {currentItem?.type === "section"
                    ? `Q${currentItem.questions[0]?.questionNum}–${currentItem.questions[currentItem.questions.length - 1]?.questionNum}`
                    : String(currentIdx + 1).padStart(2, "0")
                  } of {String(displayItems.length).padStart(2, "0")}
                </span>
                <button
                  onClick={() => { setCurrentIdx((i) => Math.min(displayItems.length - 1, i + 1)); setSubmissionPageOverride(null); }}
                  disabled={currentIdx === displayItems.length - 1}
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
                  {currentItem?.type === "section"
                    ? <>{currentItem.questions[0]?.questionNum}–{currentItem.questions[currentItem.questions.length - 1]?.questionNum}</>
                    : currentIdx + 1
                  } <span className="text-[#43474f] font-medium text-lg">of {displayItems.length}</span>
                </span>
              </div>
              <button
                onClick={() => { setCurrentIdx((i) => Math.min(displayItems.length - 1, i + 1)); setSubmissionPageOverride(null); }}
                disabled={currentIdx === displayItems.length - 1}
                className="w-12 h-12 flex items-center justify-center rounded-xl bg-[#eff4ff] text-[#001e40] hover:scale-105 transition-transform disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <span className="material-symbols-outlined">chevron_right</span>
              </button>
            </nav>

            {/* Typed English section review (Grammar Cloze, Editing, etc.) */}
            {currentQ && isTypedSection && (() => {
              // Parse word bank from passage table rows
              const wordBank = new Map<string, string>();
              const passageLines = (currentSection?.passage ?? "").split("\n");
              const tableRows: string[][] = [];
              for (const line of passageLines) {
                if (line.match(/^\s*\|[\s-:|]+\|\s*$/)) continue; // skip separator
                if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
                  tableRows.push(line.trim().replace(/\|\s*$/, "|").split("|").slice(1, -1).map(c => c.trim()));
                }
              }
              // Word bank: row 0 = letters (A, B, C...), row 1 = words
              if (tableRows.length >= 2) {
                for (let c = 0; c < tableRows[0].length; c++) {
                  const letter = tableRows[0][c].toUpperCase();
                  const word = tableRows[1]?.[c] ?? "";
                  if (letter && word) wordBank.set(letter, word);
                }
                // Handle additional rows (letters continue): row 2 = more letters, row 3 = more words
                for (let r = 2; r + 1 < tableRows.length; r += 2) {
                  for (let c = 0; c < tableRows[r].length; c++) {
                    const letter = tableRows[r][c].toUpperCase();
                    const word = tableRows[r + 1]?.[c] ?? "";
                    if (letter && word) wordBank.set(letter, word);
                  }
                }
              }

              const isGrammarCloze = currentSectionLabel.includes("grammar cloze");
              const isEditing = currentSectionLabel.includes("editing");
              const isSynthesis = currentSectionLabel.includes("synthesis");
              const isCompOeq = currentSectionLabel.includes("comprehension oeq") || currentSectionLabel.includes("comprehension open");
              const isVocabCloze = currentSectionLabel.includes("vocab") && currentSectionLabel.includes("cloze");
              const isVisualText = currentSectionLabel.includes("visual") && currentSectionLabel.includes("text");
              const totalMarks = sectionQuestions.reduce((s, q) => s + (q.marksAvailable ?? 1), 0);
              const earnedMarks = sectionQuestions.reduce((s, q) => s + (q.marksAwarded ?? 0), 0);

              return (
                <div className="bg-white rounded-3xl p-5 lg:p-8 shadow-sm border border-[#e5eeff]">
                  {/* Section header */}
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="font-headline text-lg font-extrabold text-[#001e40]">{currentSection?.label}</h3>
                    <span className={`text-sm font-bold px-3 py-1 rounded-full ${
                      earnedMarks === totalMarks ? "bg-[#d1fae5] text-[#006c49]" : earnedMarks > 0 ? "bg-[#fef3c7] text-[#633f00]" : "bg-[#ffdad6] text-[#ba1a1a]"
                    }`}>{earnedMarks} / {totalMarks}</span>
                  </div>

                  {/* Visual Text passage images — passage is stored as a sentinel
                      like "[VISUAL_PAGES:paperId:0,1]" and resolved to scanned pages. */}
                  {currentSection?.passage && currentSection.passage.startsWith("[VISUAL_") && (
                    <VisualTextImages passage={currentSection.passage} fallbackImage={sectionQuestions[0]?.imageData ?? undefined} />
                  )}
                  {/* Passage text */}
                  {currentSection?.passage && !currentSection.passage.startsWith("[") && (
                    <div className="mb-6 bg-[#f8f9ff] rounded-2xl p-5 lg:p-8 border border-slate-100 max-h-[32rem] overflow-y-auto w-full relative">
                      <ReviewPenOverlay
                        paperId={id}
                        storageKey={`passage:${currentSection?.label ?? "unnamed"}`}
                        initialDataUrl={data.reviewAnnotations?.[`passage:${currentSection?.label ?? "unnamed"}`] ?? null}
                      />
                      {(() => {
                        const pLines = currentSection.passage!.split("\n");
                        // Detect line-numbered table (Comp OEQ reading passage)
                        const isLineTable = pLines.some((l: string) => l.trim().startsWith("|") && l.includes("Text"));
                        if (isLineTable && isCompOeq) {
                          const rows: string[][] = [];
                          for (const line of pLines) {
                            if ((line as string).match(/^\s*\|[\s-:|]+\|\s*$/)) continue;
                            if ((line as string).trim().startsWith("|") && (line as string).trim().endsWith("|")) {
                              rows.push((line as string).trim().replace(/\|\s*$/, "|").split("|").slice(1, -1).map((c: string) => c.trim()));
                            }
                          }
                          const dataRows = rows.length > 1 ? rows.slice(1) : rows;
                          let oeqLineCount = 0;
                          const oeqMargins = dataRows.map((cells: string[]) => {
                            const t = cells[1]?.trim() ?? "";
                            const ln = cells[0]?.trim() ?? "";
                            if (t && ln) { oeqLineCount++; return oeqLineCount % 5 === 0 ? String(oeqLineCount) : ""; }
                            return "";
                          });
                          return dataRows.map((cells: string[], ri: number) => {
                            const textContent = cells[1]?.trim() ?? "";
                            const marginNum = oeqMargins[ri];
                            const isEmpty = !textContent && !cells[0]?.trim();
                            return (
                              <div key={ri} className={`flex gap-3 ${isEmpty ? "h-4" : "min-h-[1.6rem]"}`}>
                                <p className={`flex-1 text-[11px] lg:text-[13px] text-[#0b1c30] leading-relaxed text-justify ${textContent.startsWith("    ") || textContent.startsWith("\t") ? "pl-8" : ""}`} style={{ overflowWrap: "break-word", wordBreak: "break-word" }}>{textContent.replace(/^\s+/, "")}</p>
                                {marginNum && <span className="w-5 text-right text-[10px] lg:text-xs text-[#003366] font-bold font-mono shrink-0">{marginNum}</span>}
                              </div>
                            );
                          });
                        }
                        // Standard passage (grammar cloze, editing, comp cloze)
                        return pLines.map((line: string, li: number) => {
                          if (!line.trim()) return <br key={li} />;
                          if ((line as string).match(/^\s*\|[\s-:|]+\|\s*$/)) return null;
                          if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
                            const cells = line.trim().replace(/\|\s*$/, "|").split("|").slice(1, -1).map((c: string) => c.trim());
                            return (
                              <div key={li} className="flex gap-1 my-1">
                                {cells.map((cell: string, ci: number) => (
                                  <span key={ci} className="flex-1 text-center text-xs font-medium text-[#001e40] bg-white rounded px-2 py-1">{cell}</span>
                                ))}
                              </div>
                            );
                          }
                          // Render inline: editing shows error words, cloze shows blanks
                          const parts: React.ReactNode[] = [];
                          const mkRegex = /\*\*\((\d+)\)([^*]*)\*\*/g;
                          let lastEnd = 0;
                          let mk;
                          while ((mk = mkRegex.exec(line)) !== null) {
                            if (mk.index > lastEnd) parts.push(<span key={`t${lastEnd}`}>{line.slice(lastEnd, mk.index)}</span>);
                            const num = mk[1];
                            const word = mk[2].trim();
                            if (isEditing && word) {
                              // Show erroneous word with red underline
                              parts.push(
                                <span key={`q${num}`} className="inline-flex items-center gap-0.5 mx-0.5">
                                  <span className="text-[10px] font-bold text-blue-600 bg-blue-50 px-1 rounded">({num})</span>
                                  <span className="underline decoration-red-400 decoration-2 font-bold text-red-700 text-sm">{word}</span>
                                </span>
                              );
                            } else if (isVocabCloze && word) {
                              // Vocab cloze: show the underlined word the student must replace
                              parts.push(
                                <span key={`q${num}`} className="inline-flex items-center gap-0.5 mx-0.5">
                                  <span className="text-[10px] font-bold text-blue-600 bg-blue-50 px-1 rounded">({num})</span>
                                  <span className="underline decoration-2 font-semibold text-[#001e40] px-1 text-sm">{word}</span>
                                </span>
                              );
                            } else {
                              parts.push(
                                <span key={`q${num}`} className="inline-flex items-center gap-0.5 mx-0.5">
                                  <span className="text-[10px] font-bold text-blue-600 bg-blue-50 px-1 rounded">({num})</span>
                                  <span className="border-b-2 border-slate-300 px-1 text-sm">____</span>
                                </span>
                              );
                            }
                            lastEnd = mk.index + mk[0].length;
                          }
                          if (lastEnd < line.length) parts.push(<span key="end">{line.slice(lastEnd)}</span>);
                          const indent = line.match(/^(\s{2,}|\t)/);
                          return <p key={li} className="text-sm text-[#0b1c30] leading-relaxed my-0.5 text-justify" style={indent ? { textIndent: "2em" } : undefined}>{parts.length > 0 ? parts : line}</p>;
                        });
                      })()}
                    </div>
                  )}

                  {/* Word bank (Grammar Cloze only) */}
                  {isGrammarCloze && wordBank.size > 0 && (
                    <div className="mb-6 bg-[#eff4ff] rounded-2xl p-4">
                      <p className="text-xs font-bold text-[#43474f] mb-2 uppercase tracking-wider">Word Bank</p>
                      <div className="flex flex-wrap gap-2">
                        {[...wordBank.entries()].map(([letter, word]) => (
                          <span key={letter} className="text-xs bg-white rounded-lg px-2 py-1 border border-[#d3e4fe]">
                            <span className="font-bold text-[#003366]">{letter}</span>: {word}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Question results */}
                  <div className="space-y-3">
                    {sectionQuestions.map((q, qi) => {
                      const qCorrect = q.marksAwarded !== null && q.marksAwarded >= (q.marksAvailable ?? 1);
                      const isPartialQ = !qCorrect && (q.marksAwarded ?? 0) > 0;
                      const studentAns = (q.studentAnswer ?? "");
                      const correctAns = (q.answer ?? "");
                      const studentWord = wordBank.get(studentAns.toUpperCase()) ?? "";
                      const correctWord = wordBank.get(correctAns.toUpperCase()) ?? "";
                      const displayNum = parseInt(q.questionNum);

                      // For synthesis/comp OEQ: clean the stem for display
                      const stemRaw = q.transcribedStem ?? "";
                      const cleanStemDisplay = stemRaw
                        .replace(/\[(?:Lines?:\s*)?\d+\s*(?:lines?)?\]/gi, "")
                        .replace(/\*\*([^*]+)\*\*/g, "$1")
                        .replace(/_{3,}/g, "")
                        .trim();
                      // Extract keyword from synthesis stem
                      const kwMatch = stemRaw.match(/\*\*([^*]+)\*\*/);
                      const keyword = kwMatch ? kwMatch[1].trim() : "";

                      return (
                        <div key={q.id} className={`p-4 rounded-2xl border-2 ${
                          qCorrect ? "bg-[#d1fae5]/30 border-[#006c49]/20" : isPartialQ ? "bg-[#fef3c7]/30 border-[#633f00]/20" : "bg-[#ffdad6]/30 border-[#ba1a1a]/20"
                        }`}>
                          <div className="flex items-start gap-3">
                            <div className="flex flex-col items-center gap-1 shrink-0">
                              <span className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                                qCorrect ? "bg-[#006c49] text-white" : isPartialQ ? "bg-[#633f00] text-white" : "bg-[#ba1a1a] text-white"
                              }`}>{displayNum}</span>
                              <button onClick={() => toggleFlag(q.id)} disabled={flagging === q.id}
                                title={flaggedIds.has(q.id) ? "Flagged" : "Flag this question"}
                                className={`transition-colors disabled:opacity-50 ${flaggedIds.has(q.id) ? "text-[#ba1a1a]" : "text-[#737780] hover:text-[#ba1a1a]"}`}>
                                <span className="material-symbols-outlined text-base" style={flaggedIds.has(q.id) ? { fontVariationSettings: "'FILL' 1" } : {}}>flag</span>
                              </button>
                            </div>
                            <div className="flex-1 min-w-0">
                              {/* Synthesis / Comp OEQ: show question + typed answer */}
                              {(isSynthesis || isCompOeq) ? (
                                <div className="space-y-2">
                                  {cleanStemDisplay && (
                                    <ReviewRichText text={(() => {
                                      let t = stemRaw.replace(/\[(?:Lines?:\s*)?\d+\s*(?:lines?)?\]/gi, "").trim();
                                      // Strip table rows from stem if answer is table-based (avoid showing blank table)
                                      if (studentAns.startsWith("{")) {
                                        t = t.split("\n").filter(l => !l.trim().startsWith("|")).join("\n").trim();
                                      }
                                      return t;
                                    })()} />
                                  )}
                                  {isSynthesis && keyword && (
                                    <p className="text-sm font-bold text-[#001e40]">{keyword}</p>
                                  )}
                                  <div className="bg-white rounded-lg p-3 border border-slate-200">
                                    <p className="text-xs font-bold text-[#43474f] mb-1">Your answer:</p>
                                    {studentAns.startsWith("{") ? (
                                      // JSON answer — table cells, ticks, and/or text
                                      (() => {
                                        let cells: Record<string, string> = {};
                                        try { cells = JSON.parse(studentAns); } catch { /* ignore */ }
                                        const textVal = cells._text ?? "";
                                        const ticks = Object.entries(cells).filter(([k, v]) => k.startsWith("tick") && v === "true");
                                        const hasTableCells = Object.keys(cells).some(k => k.startsWith("r"));

                                        // If only ticks + text (no table), show text and tick summary
                                        if (!hasTableCells) {
                                          return (
                                            <div className="space-y-1">
                                              {ticks.length > 0 && (
                                                <p className="text-xs text-[#43474f]">Ticked: {ticks.length} option(s)</p>
                                              )}
                                              <p className="text-sm text-[#001e40] whitespace-pre-wrap">{textVal || <span className="italic text-[#737780]">No text answer</span>}</p>
                                            </div>
                                          );
                                        }
                                        const stemLines = stemRaw.split("\n");
                                        let rowIdx = 0;
                                        return (
                                          <div className="space-y-0.5 mt-1">
                                            {stemLines.map((sl: string, sli: number) => {
                                              const tr = sl.trim();
                                              if (tr.match(/^\|[\s-:|]+\|$/)) return null;
                                              if (tr.startsWith("|") && tr.endsWith("|")) {
                                                const tableCells = tr.trim().replace(/\|\s*$/, "|").split("|").slice(1, -1).map((c: string) => c.trim());
                                                const ri = rowIdx++;
                                                return (
                                                  <div key={sli} className="flex gap-1">
                                                    {tableCells.map((tc: string, ci: number) => {
                                                      const isBlank = !tc || tc.match(/^_{2,}$/);
                                                      const cellKey = `r${ri}c${ci}`;
                                                      const val = isBlank ? (cells[cellKey] ?? "") : tc;
                                                      return (
                                                        <span key={ci} className={`flex-1 text-center text-xs px-2 py-1 rounded border ${
                                                          isBlank ? (val ? "bg-blue-50 border-blue-200 font-semibold text-blue-800" : "bg-slate-50 border-slate-200 text-[#737780] italic") : "bg-[#eff4ff] border-[#d3e4fe] text-[#001e40] font-medium"
                                                        }`}>
                                                          {val || "—"}
                                                        </span>
                                                      );
                                                    })}
                                                  </div>
                                                );
                                              }
                                              return null;
                                            })}
                                          </div>
                                        );
                                      })()
                                    ) : (
                                      <p className="text-sm text-[#001e40] whitespace-pre-wrap">{(() => {
                                        // Synthesis answers store "<before>|||<after>" — the two blanks the
                                        // student filled on either side of the keyword. Splice the actual
                                        // keyword in so the reader sees a full transformed sentence.
                                        if (isSynthesis && studentAns.includes("|||")) {
                                          const [before, after] = studentAns.split("|||");
                                          return `${before.trim()} ${keyword || "…"} ${after.trim()}`.replace(/\s+/g, " ").trim();
                                        }
                                        return studentAns || <span className="italic text-[#737780]">No answer</span>;
                                      })()}</p>
                                    )}
                                  </div>
                                  {correctAns && (
                                    <div className="text-sm text-[#006c49]">
                                      <span className="font-semibold">Correct answer:</span>
                                      <ReviewRichText text={correctAns} />
                                    </div>
                                  )}
                                  {q.marksAvailable && (
                                    <div className="flex items-center gap-2">
                                      {editingMarks === q.id && !isStudent ? (
                                        <div className="flex items-center gap-1.5 bg-slate-50 rounded-full px-2 py-1">
                                          <button
                                            onClick={() => { const v = Math.max(0, (q.marksAwarded ?? 0) - 0.5); updateMarks(q.id, v); }}
                                            disabled={savingMarks || (q.marksAwarded ?? 0) <= 0}
                                            className="w-6 h-6 rounded-full bg-[#ffdad6] text-[#ba1a1a] flex items-center justify-center font-bold text-sm disabled:opacity-30"
                                          >−</button>
                                          <span className="text-xs font-bold text-[#001e40] min-w-[3rem] text-center">
                                            {q.marksAwarded ?? 0} / {q.marksAvailable}
                                          </span>
                                          <button
                                            onClick={() => { const v = Math.min(q.marksAvailable!, (q.marksAwarded ?? 0) + 0.5); updateMarks(q.id, v); }}
                                            disabled={savingMarks || (q.marksAwarded ?? 0) >= q.marksAvailable!}
                                            className="w-6 h-6 rounded-full bg-[#d1fae5] text-[#006c49] flex items-center justify-center font-bold text-sm disabled:opacity-30"
                                          >+</button>
                                          <button onClick={() => setEditingMarks(null)} className="ml-1 text-[#43474f] hover:text-[#001e40]">
                                            <span className="material-symbols-outlined text-sm">check</span>
                                          </button>
                                        </div>
                                      ) : (
                                        <span
                                          onClick={() => { if (!isStudent) setEditingMarks(q.id); }}
                                          className={`text-xs font-bold text-[#43474f] ${!isStudent ? "cursor-pointer hover:text-[#003366]" : ""}`}
                                        >
                                          {q.marksAwarded ?? 0} / {q.marksAvailable} marks
                                          {!isStudent && <span className="material-symbols-outlined text-[10px] ml-1 align-middle opacity-40">edit</span>}
                                        </span>
                                      )}
                                    </div>
                                  )}
                                  {/* Marking notes for synthesis/comp OEQ */}
                                  {q.markingNotes && (
                                    <p className="text-xs text-[#43474f] mt-1">{q.markingNotes.split("|").pop()?.trim()}</p>
                                  )}
                                </div>
                              ) : (isVocabCloze || isVisualText) && q.transcribedOptions && q.transcribedOptions.length > 0 ? (
                                /* Vocab Cloze / Visual Text — MCQ-style with stem + options */
                                <div className="space-y-2">
                                  {q.transcribedStem && (
                                    <p className="text-sm text-[#0b1c30] leading-relaxed whitespace-pre-wrap">{q.transcribedStem.replace(/__([^_]+)__/g, "______")}</p>
                                  )}
                                  <div className="grid grid-cols-2 gap-1.5">
                                    {q.transcribedOptions.map((opt: string, oi: number) => {
                                      const optNum = String(oi + 1);
                                      const isOptCorrect = correctAns.replace(/[().]/g, "").trim() === optNum;
                                      const isSelected = studentAns === optNum;
                                      return (
                                        <div key={oi} className={`flex items-center gap-2 p-2 rounded-lg text-xs ${
                                          isOptCorrect ? "bg-[#d1fae5] border border-[#006c49]/20" : isSelected ? "bg-[#ffdad6] border border-[#ba1a1a]/20" : "bg-[#f8f9ff] border border-transparent"
                                        }`}>
                                          <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                                            isOptCorrect ? "bg-[#006c49] text-white" : isSelected ? "bg-[#ba1a1a] text-white" : "bg-white border border-[#c3c6d1]/30 text-[#001e40]"
                                          }`}>{oi + 1}</span>
                                          <span className={`font-medium ${isOptCorrect || isSelected ? "text-[#001e40]" : "text-[#43474f]"}`}>{opt}</span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              ) : (
                                /* Grammar Cloze / Editing / Comp Cloze */
                                <>
                                  {qCorrect ? (
                                    <p className="text-sm text-[#006c49] font-semibold">
                                      <span className="material-symbols-outlined text-sm align-middle mr-1" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                                      {isGrammarCloze ? `${correctAns.toUpperCase()}: ${correctWord}` : isEditing ? `"${correctAns}"` : correctAns}
                                    </p>
                                  ) : (
                                    <div className="space-y-1">
                                      <p className="text-sm text-[#ba1a1a] font-semibold">
                                        <span className="material-symbols-outlined text-sm align-middle mr-1" style={{ fontVariationSettings: "'FILL' 1" }}>cancel</span>
                                        Your answer: {studentAns ? (isGrammarCloze ? `${studentAns.toUpperCase()}: ${studentWord || "—"}` : `"${studentAns}"`) : "No answer"}
                                      </p>
                                      <p className="text-sm text-[#006c49] font-semibold">
                                        Correct answer: {isGrammarCloze ? `${correctAns.toUpperCase()}: ${correctWord}` : isEditing ? `"${correctAns}"` : correctAns}
                                      </p>
                                    </div>
                                  )}
                                  {/* Parent score edit */}
                                  {!isStudent && (
                                    <button
                                      onClick={() => {
                                        const newMarks = qCorrect ? 0 : (q.marksAvailable ?? 1);
                                        updateMarks(q.id, newMarks);
                                      }}
                                      disabled={savingMarks}
                                      className="mt-1 text-[10px] font-bold text-[#737780] hover:text-[#003366] transition-colors flex items-center gap-1 disabled:opacity-50"
                                    >
                                      <span className="material-symbols-outlined text-xs">edit</span>
                                      {qCorrect ? "Mark as wrong" : "Mark as correct"}
                                    </button>
                                  )}
                                </>
                              )}
                              {/* Marking notes/reason for wrong/partial */}
                              {q.markingNotes && !q.markingNotes.startsWith("Wrong.") && q.markingNotes !== "Correct" && q.markingNotes !== "No answer" && (
                                <p className="text-xs text-[#43474f] italic mt-1">{q.markingNotes}</p>
                              )}
                            </div>
                          </div>

                          {/* AI Explain button + expandable elaboration */}
                          <div className="mt-2 ml-11">
                            {elaborations[q.id] ? (
                              <div>
                                <button
                                  onClick={() => setExpandedElabs(prev => {
                                    const next = new Set(prev);
                                    next.has(q.id) ? next.delete(q.id) : next.add(q.id);
                                    return next;
                                  })}
                                  className="flex items-center gap-1 text-xs font-bold text-[#003366] hover:underline"
                                >
                                  <span className="material-symbols-outlined text-sm">{expandedElabs.has(q.id) ? "expand_less" : "expand_more"}</span>
                                  {expandedElabs.has(q.id) ? "Hide explanation" : "Show explanation"}
                                </button>
                                {expandedElabs.has(q.id) && (
                                  <div className="mt-2 p-3 bg-[#eff4ff] rounded-xl">
                                    <FormattedText text={elaborations[q.id]} className="text-sm text-[#43474f] leading-relaxed" />
                                  </div>
                                )}
                              </div>
                            ) : (
                              <button
                                onClick={() => { fetchElaboration(q.id); setExpandedElabs(prev => new Set(prev).add(q.id)); }}
                                disabled={elaborating === q.id}
                                className="flex items-center gap-1 text-xs font-bold text-[#003366] hover:underline disabled:opacity-50"
                              >
                                <span className="material-symbols-outlined text-sm">auto_awesome</span>
                                {elaborating === q.id ? "Generating..." : "AI Explain"}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Current question card (standard per-question view) */}
            {currentQ && !isTypedSection && (() => {
              const isSkippedQ = currentQ.studentAnswer === "__SKIPPED__";
              const isCorrect = !isSkippedQ && (currentQ.marksAwarded ?? 0) >= (currentQ.marksAvailable ?? 1);
              const isPartial = !isSkippedQ && !isCorrect && (currentQ.marksAwarded ?? 0) > 0;
              const badgeBg = isSkippedQ ? "#e5eeff" : isCorrect ? "#d1fae5" : isPartial ? "#fef3c7" : "#ffdad6";
              const badgeText = isSkippedQ ? "#43474f" : isCorrect ? "#006c49" : isPartial ? "#633f00" : "#ba1a1a";
              // Check if this question has subparts with per-part answers shown inline
              const subs = currentQ.transcribedSubparts as { label: string }[] | null;
              const realSubLabels = subs?.filter(s => !s.label.startsWith("_")) ?? [];
              // Try studentAnswer first; fallback: extract from markingNotes "Detected: ..."
              const studentAnswerText = currentQ.studentAnswer
                || currentQ.markingNotes?.match(/^Detected:\s*(.+?)(?:\s*\||$)/)?.[1]
                || null;
              const subLabels = realSubLabels.map(s => s.label.toLowerCase());
              const hasInlinePartAnswers = realSubLabels.length > 0 && (
                Object.keys(parsePartAnswers(studentAnswerText, subLabels)).length > 0 ||
                Object.keys(parsePartAnswers(currentQ.answer, subLabels)).length > 0
              );

              return (<>
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
                        editingMarks === currentQ.id && !isStudent ? (
                          <div className="flex items-center gap-1.5 bg-white rounded-full px-2 py-1 shadow-sm">
                            <button
                              onClick={() => { const v = Math.max(0, (currentQ.marksAwarded ?? 0) - 1); updateMarks(currentQ.id, v); }}
                              disabled={savingMarks || (currentQ.marksAwarded ?? 0) <= 0}
                              className="w-6 h-6 rounded-full bg-[#ffdad6] text-[#ba1a1a] flex items-center justify-center font-bold text-sm disabled:opacity-30"
                            >−</button>
                            <span className="text-xs font-bold text-[#001e40] min-w-[3rem] text-center">
                              {currentQ.marksAwarded ?? 0} / {currentQ.marksAvailable}
                            </span>
                            <button
                              onClick={() => { const v = Math.min(currentQ.marksAvailable!, (currentQ.marksAwarded ?? 0) + 1); updateMarks(currentQ.id, v); }}
                              disabled={savingMarks || (currentQ.marksAwarded ?? 0) >= currentQ.marksAvailable!}
                              className="w-6 h-6 rounded-full bg-[#d1fae5] text-[#006c49] flex items-center justify-center font-bold text-sm disabled:opacity-30"
                            >+</button>
                            <button onClick={() => setEditingMarks(null)} className="ml-1 text-[#43474f] hover:text-[#001e40]">
                              <span className="material-symbols-outlined text-sm">check</span>
                            </button>
                          </div>
                        ) : (
                          <span
                            onClick={() => { if (!isStudent) setEditingMarks(currentQ.id); }}
                            className={`px-3 py-1 bg-white rounded-full text-xs font-bold text-[#001e40] shadow-sm ${!isStudent ? "cursor-pointer hover:bg-[#e5eeff] transition-colors" : ""}`}
                          >
                            {currentQ.marksAwarded ?? 0} / {currentQ.marksAvailable} marks
                            {!isStudent && <span className="material-symbols-outlined text-[10px] ml-1 align-middle opacity-40">edit</span>}
                          </span>
                        )
                      )}
                      {isSkippedQ && (
                        <span className="flex items-center gap-1 text-xs font-bold text-[#43474f] bg-[#eff4ff] px-2 py-0.5 rounded-full">
                          <span className="material-symbols-outlined text-base">skip_next</span>
                          Skipped
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
                    {isQuiz && (currentQ.transcribedStem || (currentQ.transcribedSubparts as { label: string }[] | null)?.some(s => !s.label.startsWith("_"))) ? (
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
                              {currentQ.transcribedStem && (
                                <h3 className="font-headline text-lg lg:text-xl font-semibold text-[#001e40] leading-relaxed whitespace-pre-wrap">
                                  {renderUnderline(currentQ.transcribedStem)}
                                </h3>
                              )}
                              {/* Show question image only when stem is missing AND there's no clean
                                  extract data (subparts or diagram) — avoids showing raw scan alongside
                                  cleanly extracted content */}
                              {!currentQ.transcribedStem && currentQ.imageData && !currentQ.diagramImageData && !(realSubs && realSubs.length > 0) && (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={currentQ.imageData} alt={`Question ${currentQ.questionNum}`} className="w-full rounded-xl border border-[#e5eeff]" />
                              )}
                              {/* Static reference diagram — show even when the
                                  question also has a drawable canvas background.
                                  Quiz page renders both too; review was hiding
                                  the static diagram whenever drawable was present
                                  which lost the diagram for Q7/Q8 in tests. */}
                              {currentQ.diagramImageData && (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={toSrc(currentQ.diagramImageData)} alt="Diagram" className="w-full rounded-xl border border-[#e5eeff]" />
                              )}
                              {drawableDiagram && (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={toSrc(drawableDiagram)} alt="Question diagram" className="w-full rounded-xl border border-[#e5eeff]" />
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
                              {/* Subparts with per-part answers */}
                              {realSubs && realSubs.length > 0 && (() => {
                                const spLabels = realSubs.map(s => s.label.toLowerCase());
                                const studentParts = parsePartAnswers(studentAnswerText, spLabels);
                                const answerParts = parsePartAnswers(currentQ.answer, spLabels);
                                const hasPartAnswers = Object.keys(studentParts).length > 0 || Object.keys(answerParts).length > 0;
                                // Parse marking notes for per-part correctness.
                                // The AI's notes are typically structured like
                                //   "Part (a): ... Awarded 2 marks. Part (b): ... 0 marks."
                                // Split at "Part (X):" / "(X):" boundaries, then per section
                                // check for "Awarded N mark" / "N marks" / explicit correct-wrong words.
                                const notes = currentQ.markingNotes ?? "";
                                const partCorrectMap: Record<string, boolean> = {};
                                const sectionRe = /(?:^|\s|\|)\(?([a-z])\)\s*:?/gi;
                                const sectionMatches = [...notes.matchAll(sectionRe)].filter(m => spLabels.includes(m[1].toLowerCase()));
                                for (let i = 0; i < sectionMatches.length; i++) {
                                  const m = sectionMatches[i];
                                  const label = m[1].toLowerCase();
                                  const start = m.index! + m[0].length;
                                  const end = i + 1 < sectionMatches.length ? sectionMatches[i + 1].index! : notes.length;
                                  const section = notes.slice(start, end);
                                  // Explicit marks number — "Awarded 2 marks" / "2 marks awarded" / "0 marks"
                                  const marksMatch = section.match(/(\d+(?:\.\d+)?)\s*marks?\b/i);
                                  if (marksMatch) {
                                    partCorrectMap[label] = parseFloat(marksMatch[1]) > 0;
                                    continue;
                                  }
                                  // Fall back to keyword detection
                                  if (/\b(no answer|blank|not provided|no written|did not|missing)\b/i.test(section)) {
                                    partCorrectMap[label] = false;
                                    continue;
                                  }
                                  if (/\b(incorrect|wrong)\b/i.test(section)) {
                                    partCorrectMap[label] = false;
                                    continue;
                                  }
                                  if (/\b(correct|matches|accepted|full marks)\b/i.test(section)) {
                                    partCorrectMap[label] = true;
                                    continue;
                                  }
                                }
                                return (
                                  <div className="space-y-4 mt-2">
                                    {realSubs.map((sp) => {
                                      const imgSrc = sp.refImageBase64 ? toSrc(sp.refImageBase64) : sp.diagramBase64 ? toSrc(sp.diagramBase64) : null;
                                      const partStudent = studentParts[sp.label.toLowerCase()];
                                      const partAnswer = answerParts[sp.label.toLowerCase()];
                                      const partIsCorrect = sp.label.toLowerCase() in partCorrectMap
                                        ? partCorrectMap[sp.label.toLowerCase()]
                                        : (partAnswer && partStudent ? partStudent.toLowerCase().replace(/\s/g, "") === partAnswer.toLowerCase().replace(/\s/g, "") : isCorrect);
                                      return (
                                        <div key={sp.label} className="space-y-2">
                                          <p className="text-sm text-[#0b1c30]">
                                            <span className="font-bold text-[#001e40]">({sp.label})</span> {sp.text}
                                          </p>
                                          {imgSrc && (
                                            // eslint-disable-next-line @next/next/no-img-element
                                            <img src={imgSrc} alt={`(${sp.label}) diagram`} className="w-full rounded-xl border border-[#e5eeff]" />
                                          )}
                                          {/* Per-subpart submission image (falls back to combined) */}
                                          {isQuiz && currentQOeqIndex >= 0 && (() => {
                                            const spCanvasId = `${currentQ.id}_${sp.label}`;
                                            const spDefault = sp.diagramBase64 ? 340 : 260;
                                            const spVisible = Math.min(canvasHeights[spCanvasId] ?? spDefault, 600);
                                            const overlayKey = `question:${currentQ.id}:${sp.label}`;
                                            return (
                                              <div className="w-full rounded-2xl border border-[#e5eeff] overflow-hidden bg-white relative">
                                                <SubmissionImage
                                                  src={`/api/exam/${id}/submission?page=${currentQSubmissionPage}&subpart=${sp.label.toLowerCase()}`}
                                                  alt={`Written answer for (${sp.label})`}
                                                  className="w-full h-auto block"
                                                  aspectRatio={`800 / ${spVisible * 2}`}
                                                  onError={(e) => {
                                                    const img = e.target as HTMLImageElement;
                                                    if (sp === realSubs[0] && !img.dataset.fallback) {
                                                      img.dataset.fallback = "1";
                                                      img.src = `/api/exam/${id}/submission?page=${currentQSubmissionPage}`;
                                                    } else if (img.dataset.fallback) {
                                                      img.style.display = "none";
                                                    } else {
                                                      img.style.display = "none";
                                                    }
                                                  }}
                                                />
                                                <ReviewPenOverlay
                                                  paperId={id}
                                                  storageKey={overlayKey}
                                                  initialDataUrl={data.reviewAnnotations?.[overlayKey] ?? null}
                                                />
                                              </div>
                                            );
                                          })()}
                                          {/* Detected answer: per-part if parsed, or raw fallback for single-subpart questions */}
                                          {(() => {
                                            const detected = partStudent || (!hasPartAnswers && realSubs.length === 1 && studentAnswerText) || null;
                                            if (!detected) return null;
                                            // Strip the "Working:" label the AI prepends per the detect prompt's
                                            // "Working: ... Final answer: X" format. The label is scaffolding,
                                            // not part of the student's answer.
                                            const cleaned = detected.replace(/^\s*working\s*:?\s*/i, "").trim() || detected;
                                            return (
                                              <div className={`text-sm leading-relaxed rounded-xl p-3 ${
                                                partIsCorrect ? "bg-[#6cf8bb]/20 text-[#006c49]" : "bg-[#ffdad6] text-[#93000a]"
                                              }`}>
                                                <span className="text-[9px] font-bold uppercase tracking-wider opacity-60 block mb-0.5">Detected Answer</span>
                                                {cleaned}
                                              </div>
                                            );
                                          })()}
                                          {/* Correct answer: per-part if parsed, or raw fallback for single-subpart questions */}
                                          {(() => {
                                            const correct = partAnswer || (!hasPartAnswers && realSubs.length === 1 && currentQ.answer) || null;
                                            if (!correct) return null;
                                            return (
                                              <div className="text-sm text-[#0b1c30] leading-relaxed rounded-xl bg-white p-3 border border-[#e5eeff]">
                                                <span className="text-[9px] font-bold uppercase tracking-wider text-[#43474f] opacity-60 block mb-0.5">Correct Answer</span>
                                                <FormattedText text={correct.replace(/\s*\|\s*/g, "\n")} className="whitespace-pre-line" />
                                              </div>
                                            );
                                          })()}
                                        </div>
                                      );
                                    })}
                                    {/* Fallback: show full raw answer when per-part parsing found nothing */}
                                    {!hasPartAnswers && currentQ.answer && (
                                      <div className="text-sm text-[#0b1c30] leading-relaxed rounded-xl bg-white p-3 border border-[#e5eeff]">
                                        <span className="text-[9px] font-bold uppercase tracking-wider text-[#43474f] opacity-60 block mb-0.5">Correct Answer</span>
                                        <FormattedText text={currentQ.answer.replace(/\s*\|\s*/g, "\n")} className="whitespace-pre-line" />
                                      </div>
                                    )}
                                    {/* Answer diagram (if any) — per-part text answers are already shown above */}
                                    {currentQ.answerImageData && (
                                      <div className="mt-3">
                                        {/* eslint-disable-next-line @next/next/no-img-element */}
                                        <img src={currentQ.answerImageData} alt="Answer diagram" className="max-w-full rounded-xl border border-[#e5eeff]" />
                                      </div>
                                    )}
                                    {/* Marking notes for subpart questions */}
                                    {currentQ.markingNotes && (
                                      <div className="mt-2">
                                        <p className="text-[10px] font-extrabold uppercase tracking-widest text-[#43474f] mb-2">Marking Notes</p>
                                        <p className="text-sm text-[#43474f] leading-relaxed">
                                          {renderMarkingNotes(currentQ.markingNotes)}
                                        </p>
                                      </div>
                                    )}
                                  </div>
                                );
                              })()}
                            </>
                          );
                        })()}
                      </div>
                    ) : currentQ.imageData ? (
                      <div className="mb-5 rounded-2xl overflow-hidden border border-[#e5eeff]">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={currentQ.imageData} alt={`Question ${currentQ.questionNum}`} className="w-full h-auto" />
                      </div>
                    ) : null}

                    {/* Quiz OEQ (non-subpart): stacked layout — written answer, detected, correct */}
                    {isQuiz && currentQOeqIndex >= 0 && !currentQ.transcribedOptions && !currentQ.transcribedOptionImages && !hasInlinePartAnswers && realSubLabels.length === 0 && (
                      <div className="space-y-4 mb-4">
                        {/* Written answer image */}
                        {(() => {
                          const hasDrawable = !!(currentQ.transcribedSubparts as { label: string }[] | null)?.find(s => s.label === "_drawable");
                          const defaultH = hasDrawable ? 360 : 300;
                          const visibleH = Math.min(canvasHeights[currentQ.id] ?? defaultH, 600);
                          return (
                            <div>
                              <p className="text-[10px] font-extrabold uppercase tracking-widest text-[#43474f] mb-2">Written Answer</p>
                              <div className="rounded-2xl overflow-hidden border border-[#e5eeff] bg-white">
                                <SubmissionImage
                                  src={`/api/exam/${id}/submission?page=${currentQSubmissionPage}`}
                                  alt={`Written answer for Q${currentQ.questionNum}`}
                                  className="w-full h-auto block"
                                  aspectRatio={`400 / ${visibleH}`}
                                />
                              </div>
                            </div>
                          );
                        })()}
                        {/* Detected answer */}
                        {studentAnswerText && (
                          <div>
                            <p className="text-[10px] font-extrabold uppercase tracking-widest text-[#43474f] mb-2">Detected Answer</p>
                            <div className={`text-sm leading-relaxed rounded-2xl p-4 whitespace-pre-wrap ${
                              isCorrect ? "bg-[#6cf8bb]/20 text-[#006c49]" : "bg-[#ffdad6] text-[#93000a]"
                            }`}>
                              {studentAnswerText.replace(/^\s*working\s*:?\s*/i, "").trim() || studentAnswerText}
                            </div>
                          </div>
                        )}
                        {/* Correct answer */}
                        {(currentQ.answer || currentQ.answerImageData) && (
                          <div>
                            <p className="text-[10px] font-extrabold uppercase tracking-widest text-[#43474f] mb-2">Correct Answer</p>
                            {currentQ.answer && (
                              <div className="text-sm text-[#0b1c30] leading-relaxed rounded-2xl bg-white p-4 border border-[#e5eeff]">
                                {renderWithNewlines(currentQ.answer)}
                              </div>
                            )}
                            {currentQ.answerImageData && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={currentQ.answerImageData} alt="Answer diagram" className="mt-2 max-w-full rounded-xl border border-[#e5eeff]" />
                            )}
                          </div>
                        )}
                        {/* Marking notes */}
                        {currentQ.markingNotes && (
                          <div>
                            <p className="text-[10px] font-extrabold uppercase tracking-widest text-[#43474f] mb-2">Marking Notes</p>
                            <div className="text-sm text-[#43474f] leading-relaxed whitespace-pre-wrap">
                              {renderMarkingNotes(currentQ.markingNotes)}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Exam paper: Submission image + solution side-by-side */}
                    {!isQuiz && (
                    <div className="md:flex gap-5">
                      {!currentQ.transcribedOptions && !currentQ.transcribedOptionImages && (
                        <div className="md:w-1/2 md:shrink-0 mb-4 md:mb-0 rounded-2xl overflow-hidden border border-[#e5eeff] relative">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`/api/exam/${id}/submission?page=${effectiveSubmissionPage}`}
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
                        {studentAnswerText && !currentQ.transcribedOptions && (
                          <div>
                            <p className="text-[10px] font-extrabold uppercase tracking-widest text-[#43474f] mb-2">Detected Answer</p>
                            <div className={`text-sm leading-relaxed rounded-2xl p-4 ${
                              isCorrect ? "bg-[#6cf8bb]/20 text-[#006c49]" : "bg-[#ffdad6] text-[#93000a]"
                            }`}>
                              {studentAnswerText}
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
                            <div className="text-sm text-[#43474f] leading-relaxed whitespace-pre-wrap">
                              {renderMarkingNotes(currentQ.markingNotes)}
                            </div>
                          </div>
                        )}

                      </div>
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

              {/* AI Elaboration — separate section below question card */}
              {currentQ.marksAwarded !== null && (
                <div className="mt-4">
                  {elaborations[currentQ.id] ? (
                    <div className="bg-[#eff4ff]/40 rounded-3xl p-5 lg:p-8 border border-[#e5eeff]">
                      <p className="text-[10px] font-extrabold uppercase tracking-widest text-[#43474f] mb-2">AI Explanation</p>
                      <FormattedText text={elaborations[currentQ.id]} className="text-base text-[#43474f] leading-relaxed whitespace-pre-line" />
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
                          Generating in background...
                        </span>
                      ) : "AI Elaboration"}
                    </button>
                  )}
                </div>
              )}
              </>);
            })()}
          </div>
        )}
      </div>

      {/* Sticker picker modal */}
      {showStickerPicker && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-[200]" onClick={() => setShowStickerPicker(false)}>
          <div className="bg-white rounded-3xl p-8 shadow-2xl grid grid-cols-2 gap-6" onClick={e => e.stopPropagation()}>
            <p className="col-span-2 text-center font-headline font-bold text-[#001e40] text-lg">Pick a sticker!</p>
            {["unicorn_t.PNG", "trex_t.PNG", "pizza_t.PNG", "wizard_t.PNG", "star_t.PNG", "rocket_t.PNG", "cat_t.PNG"].map(s => (
              <button key={s} onClick={() => saveSticker(s)} className="hover:scale-110 transition-transform p-4 rounded-2xl hover:bg-[#eff4ff]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/stickers/thumbs/${s}`} alt={s.replace("_t.PNG", "")} className="w-24 h-24 object-contain" />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Renders rich text with tables, bold, tick boxes for review */
function ReviewRichText({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="space-y-0.5">
      {lines.map((line, li) => {
        const trimmed = line.trim();
        if (!trimmed) return <br key={li} />;
        if (trimmed.match(/^\|[\s-:|]+\|$/)) return null;
        if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
          const cells = trimmed.trim().replace(/\|\s*$/, "|").split("|").slice(1, -1).map(c => c.trim());
          return (
            <div key={li} className="flex gap-1 my-0.5">
              {cells.map((cell, ci) => (
                <span key={ci} className="flex-1 text-center text-xs font-medium text-[#001e40] bg-[#eff4ff] rounded px-2 py-1 border border-[#d3e4fe]">
                  {cell || "—"}
                </span>
              ))}
            </div>
          );
        }
        if (trimmed.match(/^\[[ x✓✗]\]\s/i)) {
          const checked = trimmed.match(/^\[[x✓]\]/i);
          const content = trimmed.replace(/^\[[ x✓✗]\]\s*/i, "");
          return (
            <div key={li} className="flex items-center gap-2 text-sm text-[#001e40] my-0.5">
              <span>{checked ? "☑" : "☐"}</span>
              <span>{renderBoldInline(content)}</span>
            </div>
          );
        }
        if (trimmed.match(/^_{3,}$/)) return <div key={li} className="border-b border-slate-300 my-1 w-48" />;
        return <p key={li} className="text-sm text-[#001e40] leading-relaxed">{renderBoldInline(trimmed)}</p>;
      })}
    </div>
  );
}

function renderBoldInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /\*\*([^*]+)\*\*/g;
  let lastIdx = 0;
  let m;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push(text.slice(lastIdx, m.index));
    parts.push(<strong key={m.index} className="font-bold">{m[1]}</strong>);
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts.length > 0 ? <>{parts}</> : text;
}
