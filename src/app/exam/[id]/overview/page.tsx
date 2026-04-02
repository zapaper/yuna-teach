"use client";

import { Suspense, useEffect, useRef, useState, use } from "react";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import { ExamPaperDetail, ExamCloneSummary, User } from "@/types";
import { jsPDF } from "jspdf";

export default function ExamOverviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <Suspense>
      <ExamOverviewContent id={id} />
    </Suspense>
  );
}

// ─── Marking detail question ──────────────────────────────────────────────────

interface MarkingQuestion {
  id: string;
  questionNum: string;
  pageIndex: number;
  yStartPct: number | null;
  yEndPct: number | null;
  answer: string | null;
  marksAwarded: number | null;
  marksAvailable: number | null;
  markingNotes: string | null;
  elaboration: string | null;
  flagged: boolean;
  imageData?: string;
}

interface BookletScore {
  label: string;
  awarded: number;
  available: number;
}

interface MarkingDetail {
  markingStatus: string | null;
  score: number | null;
  feedbackSummary: string | null;
  questions: MarkingQuestion[];
  bookletScores?: BookletScore[];
}

// ─── Main content ─────────────────────────────────────────────────────────────

function ExamOverviewContent({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";
  const openCloneParam = searchParams.get("openClone");

  const [paper, setPaper] = useState<ExamPaperDetail | null>(null);
  const [students, setStudents] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [assigning, setAssigning] = useState(false);
  const [instantFeedback, setInstantFeedback] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  // Polling for marking status
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Marking detail overlay
  const [detailCloneId, setDetailCloneId] = useState<string | null>(null);
  const [markingDetail, setMarkingDetail] = useState<MarkingDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Per-question state within overlay
  const [remarkingId, setRemarkingId] = useState<string | null>(null);
  const [manualId, setManualId] = useState<string | null>(null);
  const [manualValue, setManualValue] = useState("");
  const [reviewShowAll, setReviewShowAll] = useState(false);
  const [reviewIdx, setReviewIdx] = useState(0);

  // AI elaboration + flag state
  const [elaborations, setElaborations] = useState<Record<string, string>>({});
  const [elaborating, setElaborating] = useState<string | null>(null);
  const [flaggedIds, setFlaggedIds] = useState<Set<string>>(new Set());
  const [flagging, setFlagging] = useState<string | null>(null);

  // Feedback editing
  const [editingFeedback, setEditingFeedback] = useState(false);
  const [feedbackDraft, setFeedbackDraft] = useState("");
  const [savingFeedback, setSavingFeedback] = useState(false);
  const [generatingFeedback, setGeneratingFeedback] = useState(false);
  const [finalizing, setFinalizing] = useState(false);

  // Lightbox for question image pop-up
  const [lightboxQ, setLightboxQ] = useState<MarkingQuestion | null>(null);
  const [submissionPageCount, setSubmissionPageCount] = useState(0);

  // Download PDF state (tracks which clone is downloading)
  const [downloadingCloneId, setDownloadingCloneId] = useState<string | null>(null);

  // Extraction
  const [extracting, setExtracting] = useState(false);

  // Skip pages editor (admin)
  const [skipPagesInput, setSkipPagesInput] = useState("");
  const [savingSkipPages, setSavingSkipPages] = useState(false);

  // Passage pages editor (admin) — comprehension passage pages duplicated before open-ended section
  const [passagePagesInput, setPassagePagesInput] = useState("");
  const [savingPassagePages, setSavingPassagePages] = useState(false);

  // Math question transcription preview (admin)
  type TranscribedQuestion = {
    id: string;
    type: "mcq" | "open";
    questionNum: string;
    answer: string;
    syllabusTopic: string | null;
    marksAvailable: number | null;
    stem: string | null;
    options: [string, string, string, string] | null;
    subparts: { label: string; text: string }[] | null;
    diagramBounds: { top: number; left: number; bottom: number; right: number } | null;
    diagramBase64: string | null;
    error: string | null;
  };
  const [mcqTranscribing, setMcqTranscribing] = useState(false);
  const [mcqResults, setMcqResults] = useState<TranscribedQuestion[] | null>(null);
  const [mcqError, setMcqError] = useState<string | null>(null);
  const [mcqExtracted, setMcqExtracted] = useState(false);

  async function generateMcqPreview() {
    setMcqTranscribing(true);
    setMcqResults(null);
    setMcqError(null);
    try {
      const res = await fetch(`/api/exam/${id}/transcribe-mcq`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed");
      setMcqResults(data.questions);
      // Auto-save to DB so Edit & Save page can load it
      const saveRes = await fetch(`/api/exam/${id}/transcribe-mcq`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questions: (data.questions as TranscribedQuestion[]).map(q => ({
            id: q.id,
            stem: q.stem,
            options: q.options ?? null,
            optionImages: null,
            subparts: q.subparts ?? null,
            diagramBounds: q.diagramBounds ?? null,
            diagramImageData: q.diagramBase64 ?? null,
          })),
        }),
      });
      if (saveRes.ok) setMcqExtracted(true);
    } catch (e) {
      setMcqError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setMcqTranscribing(false);
    }
  }

  // Portal mount guard (portals require document to exist)
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    async function fetchAll() {
      try {
        const [paperRes, linkRes, usersRes, transcribeRes] = await Promise.all([
          fetch(`/api/exam/${id}?summary=true`),
          fetch(`/api/link?userId=${userId}`),
          fetch("/api/users"),
          fetch(`/api/exam/${id}/transcribe-mcq`),
        ]);
        if (!paperRes.ok) throw new Error("Not found");
        const [paperData, linkData, usersData] = await Promise.all([
          paperRes.json(),
          linkRes.json(),
          usersRes.json(),
        ]);
        const currentUser = usersData.users?.find((u: User) => u.id === userId);
        setIsAdmin(currentUser?.name?.toLowerCase() === "admin");
        setPaper(paperData);
        if (transcribeRes.ok) {
          const td = await transcribeRes.json();
          if (td.hasSaved) setMcqExtracted(true);
        }
        // Only show linked students (with level info from link API)
        setStudents(
          (linkData.linkedStudents ?? []).map((s: { id: string; name: string; level?: number | null }) => ({
            id: s.id,
            name: s.name,
            role: "STUDENT" as const,
            level: s.level ?? null,
            email: null,
            createdAt: "",
            linkedStudents: [],
            linkedParents: [],
          }))
        );
        // If any clone or legacy assignment is being marked, start polling
        const anyMarking = (paperData.clones ?? []).some(
          (c: ExamCloneSummary) => c.markingStatus === "in_progress"
        ) || paperData.markingStatus === "in_progress";
        if (anyMarking) startPolling();
      } catch {
        // handled by null check below
      } finally {
        setLoading(false);
      }
    }
    fetchAll();
    return () => stopPolling();
  }, [id, userId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-open clone detail when navigated from pending review
  useEffect(() => {
    if (openCloneParam && paper && !detailCloneId) {
      openMarkingDetail(openCloneParam);
    }
  }, [openCloneParam, paper]); // eslint-disable-line react-hooks/exhaustive-deps

  function startPolling() {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/exam/${id}?summary=true`);
        if (!res.ok) return;
        const data = await res.json();
        setPaper(data);
        const existingSkip = (data.metadata?.skipPages ?? []) as number[];
        setSkipPagesInput(existingSkip.join(", "));
        const existingPassage = (data.metadata?.passagePages ?? []) as number[];
        setPassagePagesInput(existingPassage.join(", "));
        const anyMarking = (data.clones ?? []).some(
          (c: ExamCloneSummary) => c.markingStatus === "in_progress"
        ) || data.markingStatus === "in_progress";
        if (!anyMarking) stopPolling();
      } catch {
        // ignore transient errors
      }
    }, 4000);
  }

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  async function triggerMarking(cloneId: string) {
    try {
      const markRes = await fetch(`/api/exam/${cloneId}/mark`, { method: "POST" });
      console.log(`[triggerMarking] POST /api/exam/${cloneId}/mark → ${markRes.status}`, await markRes.clone().text());
      // Immediately refresh paper data so UI shows "Marking..." right away
      const res = await fetch(`/api/exam/${id}?summary=true`);
      if (res.ok) setPaper(await res.json());
      startPolling();
    } catch (err) {
      console.error("[triggerMarking] failed:", err);
    }
  }

  async function openMarkingDetail(cloneId: string) {
    setDetailCloneId(cloneId);
    setDetailLoading(true);
    setReviewShowAll(false);
    setReviewIdx(0);
    try {
      const [markRes, subRes] = await Promise.all([
        fetch(`/api/exam/${cloneId}/mark`),
        fetch(`/api/exam/${cloneId}/submission`),
      ]);
      if (markRes.ok) {
        const md = await markRes.json();
        // Attach imageData from master paper questions
        if (paper) {
          const imgMap: Record<string, string> = {};
          for (const q of paper.questions ?? []) {
            if (q.questionNum && q.imageData) imgMap[q.questionNum] = q.imageData;
          }
          for (const q of md.questions ?? []) {
            if (imgMap[q.questionNum]) q.imageData = imgMap[q.questionNum];
          }
        }
        setMarkingDetail(md);
        // Pre-populate cached elaborations and flagged state
        const cached: Record<string, string> = {};
        const flagged = new Set<string>();
        for (const q of md.questions ?? []) {
          if (q.elaboration) cached[q.id] = q.elaboration;
          if (q.flagged) flagged.add(q.id);
        }
        if (Object.keys(cached).length > 0) setElaborations(prev => ({ ...prev, ...cached }));
        if (flagged.size > 0) setFlaggedIds(prev => { const next = new Set(prev); flagged.forEach(id => next.add(id)); return next; });
      }
      if (subRes.ok) {
        const sub = await subRes.json();
        setSubmissionPageCount(sub.pageCount ?? 0);
      }
    } finally {
      setDetailLoading(false);
    }
  }

  async function remarkQuestion(questionId: string) {
    if (!detailCloneId) return;
    setRemarkingId(questionId);
    try {
      await fetch(`/api/exam/${detailCloneId}/mark?questionId=${questionId}`, { method: "POST" });
      // Poll until updated
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        const res = await fetch(`/api/exam/${detailCloneId}/mark`);
        if (res.ok) {
          const data: MarkingDetail = await res.json();
          const q = data.questions.find((q) => q.id === questionId);
          if (q?.markingNotes !== markingDetail?.questions.find((x) => x.id === questionId)?.markingNotes || attempts > 10) {
            setMarkingDetail(data);
            // Refresh summary score
            fetch(`/api/exam/${id}?summary=true`).then((r) => r.json()).then(setPaper).catch(() => {});
            clearInterval(poll);
            setRemarkingId(null);
          }
        }
      }, 3000);
    } catch {
      setRemarkingId(null);
    }
  }

  async function saveManualMark(questionId: string) {
    if (!detailCloneId) return;
    const marks = parseFloat(manualValue);
    if (isNaN(marks)) return;
    await fetch(`/api/exam/questions/${questionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ marksAwarded: marks, markingNotes: "Manual mark" }),
    });
    setManualId(null);
    setManualValue("");
    // Refresh both detail and summary
    const [detailRes, summaryRes] = await Promise.all([
      fetch(`/api/exam/${detailCloneId}/mark`),
      fetch(`/api/exam/${id}?summary=true`),
    ]);
    if (detailRes.ok) setMarkingDetail(await detailRes.json());
    if (summaryRes.ok) setPaper(await summaryRes.json());
  }

  async function saveFeedback() {
    if (!detailCloneId) return;
    setSavingFeedback(true);
    try {
      await fetch(`/api/exam/${detailCloneId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedbackSummary: feedbackDraft }),
      });
      setMarkingDetail((prev) =>
        prev ? { ...prev, feedbackSummary: feedbackDraft } : prev
      );
      setEditingFeedback(false);
    } finally {
      setSavingFeedback(false);
    }
  }

  async function handleGenerateFeedback() {
    if (!detailCloneId) return;
    setGeneratingFeedback(true);
    try {
      const res = await fetch(`/api/exam/${detailCloneId}/feedback`, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setMarkingDetail((prev) =>
          prev ? { ...prev, feedbackSummary: data.feedbackSummary } : prev
        );
      }
    } finally {
      setGeneratingFeedback(false);
    }
  }

  async function finalizeAndSend() {
    if (!detailCloneId || !markingDetail) return;
    setFinalizing(true);
    try {
      const totalScore = markingDetail.questions.reduce(
        (sum, q) => sum + (q.marksAwarded ?? 0), 0
      );
      await fetch(`/api/exam/${detailCloneId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ score: totalScore, markingStatus: "released" }),
      });
      // Refresh summary
      const res = await fetch(`/api/exam/${id}?summary=true`);
      if (res.ok) setPaper(await res.json());
      setMarkingDetail(null);
      setDetailCloneId(null);
    } finally {
      setFinalizing(false);
    }
  }

  async function fetchElaboration(questionId: string) {
    if (elaborations[questionId] || !detailCloneId) return;
    setElaborating(questionId);
    try {
      const res = await fetch(`/api/exam/${detailCloneId}/elaborate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId }),
      });
      if (res.ok) {
        const { elaboration } = await res.json();
        setElaborations(prev => ({ ...prev, [questionId]: elaboration }));
      }
    } catch {
      // ignore
    } finally {
      setElaborating(null);
    }
  }

  async function toggleFlag(questionId: string) {
    if (!detailCloneId) return;
    setFlagging(questionId);
    try {
      const res = await fetch(`/api/exam/${detailCloneId}/flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId, userId }),
      });
      if (res.ok) {
        const { flagged } = await res.json();
        setFlaggedIds(prev => {
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

  async function handleAssign(studentId: string) {
    if (!paper) return;
    setAssigning(true);
    try {
      await fetch(`/api/exam/${paper.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignedToId: studentId, instantFeedback }),
      });
      // Refresh paper data to get updated clones array
      const res = await fetch(`/api/exam/${id}?summary=true`);
      if (res.ok) setPaper(await res.json());
    } finally {
      setAssigning(false);
    }
  }

  async function handleUnassign(cloneId: string) {
    if (!paper) return;
    setAssigning(true);
    try {
      await fetch(`/api/exam/${cloneId}`, { method: "DELETE" });
      // Refresh paper data
      const res = await fetch(`/api/exam/${id}?summary=true`);
      if (res.ok) setPaper(await res.json());
    } finally {
      setAssigning(false);
    }
  }

  // Unassign a legacy (pre-clone) assignment by clearing master's assignedToId
  async function handleLegacyUnassign() {
    if (!paper) return;
    setAssigning(true);
    try {
      await fetch(`/api/exam/${paper.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignedToId: null }),
      });
      const res = await fetch(`/api/exam/${id}?summary=true`);
      if (res.ok) setPaper(await res.json());
    } finally {
      setAssigning(false);
    }
  }

  async function downloadSubmissionPdf(cloneId: string, studentName: string) {
    if (!paper || downloadingCloneId) return;
    setDownloadingCloneId(cloneId);
    try {
      const metaRes = await fetch(`/api/exam/${cloneId}/submission`);
      const meta = await metaRes.json();
      const count = meta.pageCount ?? 0;
      if (count === 0) return;

      // Fetch each page and convert to data URL via canvas
      const pages: { dataUrl: string; w: number; h: number }[] = [];
      for (let i = 0; i < count; i++) {
        const res = await fetch(`/api/exam/${cloneId}/submission?page=${i}`);
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

      pdf.save(`${paper.title} - ${studentName}.pdf`);
    } catch (err) {
      console.error("Download PDF failed:", err);
    } finally {
      setDownloadingCloneId(null);
    }
  }

  // Build submissionIndexMap from metadata (for lightbox page lookup)
  function getSubmissionPage(originalPageIdx: number): number {
    if (!paper) return originalPageIdx;
    const answerPageSet = new Set(
      (paper.metadata?.answerPages ?? []).map((p) => p - 1)
    );
    let idx = 0;
    for (let i = 0; i < paper.pageCount; i++) {
      if (!answerPageSet.has(i)) {
        if (i === originalPageIdx) return idx;
        idx++;
      }
    }
    return originalPageIdx;
  }

  function formatTime(s: number): string {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0 ? `${h}h ${m}m ${sec}s` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  }

  const backPath = userId ? `/home/${userId}?view=progress` : "/";

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
        <p className="text-slate-500">Exam paper not found</p>
        <button onClick={() => router.push(backPath)} className="mt-4 text-primary-500 underline">
          Go Home
        </button>
      </div>
    );
  }

  const questionsDetected = paper.questions.length;
  const answersDetected = paper.questions.filter(
    (q) => q.answer && q.answer.trim() !== "" && q.answer !== "?"
  ).length;
  const missingAnswers = questionsDetected - answersDetected;
  const hasMissingAnswers = missingAnswers > 0;

  // Marks validation: sum of per-question marksAvailable vs paper totalMarks
  const sumMarksAvailable = paper.questions.reduce(
    (sum, q) => sum + (q.marksAvailable ?? 0), 0
  );
  const expectedTotal = paper.totalMarks ? parseFloat(paper.totalMarks) : null;
  const hasMarksMismatch = expectedTotal !== null && sumMarksAvailable > 0 && sumMarksAvailable !== expectedTotal;
  const hasMissingMarks = paper.questions.some((q) => q.marksAvailable == null || q.marksAvailable === 0);

  const clones: ExamCloneSummary[] = paper.clones ?? [];
  const detailClone = clones.find((c) => c.id === detailCloneId);
  const detailStudentName = detailClone?.assignedToName
    ?? (detailCloneId === paper.id ? paper.assignedToName : null)
    ?? "Student";

  const pageContent = (
    <div className="p-6 pb-24 max-w-2xl mx-auto">
      {/* Back */}
      <button
        onClick={() => router.replace(backPath)}
        className="flex items-center gap-1 text-slate-500 mb-6 hover:text-slate-700"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m15 18-6-6 6-6" />
        </svg>
        Home
      </button>

      {isAdmin ? (
        <input
          type="text"
          value={paper.title}
          onChange={(e) => setPaper({ ...paper, title: e.target.value })}
          onBlur={async () => {
            await fetch(`/api/exam/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title: paper.title }),
            });
          }}
          className="text-2xl font-bold text-slate-800 mb-1 w-full bg-transparent border-b-2 border-transparent hover:border-slate-200 focus:border-primary-400 focus:outline-none transition-colors"
        />
      ) : (
        <h1 className="text-2xl font-bold text-slate-800 mb-1">{paper.title}</h1>
      )}
      <p className="text-sm text-slate-400 mb-6">
        {paper.school ? <span>{paper.school} · </span> : null}
        <span>Added {new Date(paper.createdAt).toLocaleDateString()}</span>
      </p>

      {/* Paper Summary */}
      <Section title="Paper Summary">
        <InfoRow label="School" value={paper.school} />
        <InfoRow label="Level" value={paper.level} />
        <InfoRow label="Subject" value={paper.subject} />
        <InfoRow label="Year / Semester"
          value={[paper.year, paper.semester].filter(Boolean).join(" / ") || null} />
        <InfoRow label="Total Questions" value={String(questionsDetected)} />
        <div className="flex items-center justify-between py-2 border-t border-slate-100">
          <span className="text-sm text-slate-600">Total Marks</span>
          {isAdmin ? (
            <input
              type="number"
              min="0"
              value={paper.totalMarks ?? ""}
              onChange={(e) => setPaper({ ...paper, totalMarks: e.target.value || null })}
              onBlur={async (e) => {
                await fetch(`/api/exam/${id}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ totalMarks: e.target.value || null }),
                });
              }}
              placeholder="—"
              className="w-20 text-sm font-semibold text-slate-800 text-right bg-transparent border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:border-primary-400"
            />
          ) : (
            <span className="text-sm font-semibold text-slate-800">{paper.totalMarks ?? "—"}</span>
          )}
        </div>
        <div className="flex items-center justify-between py-2 border-t border-slate-100">
          <span className="text-sm text-slate-600">Exam Type</span>
          {isAdmin ? (
            <select
              value={paper.examType || ""}
              onChange={async (e) => {
                const val = e.target.value || null;
                setPaper({ ...paper, examType: val });
                await fetch(`/api/exam/${id}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ examType: val }),
                });
              }}
              className="text-sm font-semibold text-slate-800 bg-transparent border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:border-primary-400"
            >
              <option value="">Not set</option>
              <option value="Preliminary">Preliminary</option>
              <option value="WA1">WA1</option>
              <option value="WA2">WA2</option>
              <option value="WA3">WA3</option>
              <option value="End of Year">End of Year</option>
            </select>
          ) : (
            <span className="text-sm font-semibold text-slate-800">{paper.examType || "Not set"}</span>
          )}
        </div>
      </Section>

      {/* Detection Status */}
      <Section title="Detection Status">
        <div className="flex items-center justify-between py-2">
          <span className="text-sm text-slate-600">Questions detected</span>
          <span className="font-semibold text-slate-800">{questionsDetected}</span>
        </div>
        <div className="flex items-center justify-between py-2 border-t border-slate-100">
          <span className="text-sm text-slate-600">Answers detected</span>
          <span className={`font-semibold ${hasMissingAnswers ? "text-red-500" : "text-green-600"}`}>
            {answersDetected} / {questionsDetected}
            {hasMissingAnswers ? (
              <span className="ml-2 text-xs font-normal text-red-400">({missingAnswers} missing)</span>
            ) : null}
          </span>
        </div>
        {hasMissingAnswers ? (
          <div className="mt-2 flex items-start gap-2 rounded-xl bg-red-50 border border-red-200 px-3 py-2">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className="text-red-500 mt-0.5 shrink-0">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <p className="text-xs text-red-600">
              Some answers could not be detected. Use Edit to fill them in.
            </p>
          </div>
        ) : null}
        {/* Marks validation */}
        <div className="flex items-center justify-between py-2 border-t border-slate-100">
          <span className="text-sm text-slate-600">Marks total</span>
          <span className={`font-semibold ${hasMarksMismatch ? "text-amber-600" : hasMissingMarks ? "text-slate-400" : "text-green-600"}`}>
            {sumMarksAvailable}{expectedTotal !== null ? ` / ${expectedTotal}` : ""}
          </span>
        </div>
        {hasMarksMismatch ? (
          <div className="mt-1 flex items-start gap-2 rounded-xl bg-amber-50 border border-amber-200 px-3 py-2">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className="text-amber-500 mt-0.5 shrink-0">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <p className="text-xs text-amber-700">
              Sum of question marks ({sumMarksAvailable}) does not match paper total ({expectedTotal}). Check marks in Edit.
            </p>
          </div>
        ) : null}
        {hasMissingMarks && !hasMarksMismatch ? (
          <div className="mt-1 flex items-start gap-2 rounded-xl bg-slate-50 border border-slate-200 px-3 py-2">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className="text-slate-400 mt-0.5 shrink-0">
              <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <p className="text-xs text-slate-500">
              Some questions have no marks assigned. Set marks in Edit for accurate scoring.
            </p>
          </div>
        ) : null}
        {isAdmin ? (
          <>
            <button onClick={() => router.push(`/exam/${id}/edit?userId=${userId}`)}
              className="mt-3 w-full py-2.5 px-4 rounded-xl border-2 border-primary-200 text-primary-600 font-medium text-sm hover:bg-primary-50 transition-colors">
              Edit Questions &amp; Answers
            </button>
            <button
              onClick={async () => {
                setExtracting(true);
                try {
                  const res = await fetch(`/api/exam/${id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ retryExtraction: true }),
                  });
                  if (res.ok) {
                    router.push(`/home/${userId}?t=${Date.now()}`);
                  } else {
                    const err = await res.json().catch(() => ({}));
                    console.error("Extraction request failed:", err);
                    alert("Failed to start extraction. Please try again.");
                    setExtracting(false);
                  }
                } catch (err) {
                  console.error("Extraction failed:", err);
                  alert("Failed to start extraction. Please try again.");
                  setExtracting(false);
                }
              }}
              disabled={extracting}
              className="mt-2 w-full py-2.5 px-4 rounded-xl border-2 border-amber-200 text-amber-600 font-medium text-sm hover:bg-amber-50 transition-colors disabled:opacity-50"
            >
              {extracting ? "Extracting..." : "Extract all Questions & Answers"}
            </button>
          </>
        ) : null}
        {/* Admin-only: Skip pages config — English only */}
        {isAdmin && paper.subject?.toLowerCase().includes("english") && (
          <div className="mt-3 pt-3 border-t border-slate-100">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Student View — Hidden Pages</p>
            <p className="text-xs text-slate-400 mb-2">Enter page numbers to hide from student (e.g. writing or listening pages). Comma-separated, 1-based.</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={skipPagesInput}
                onChange={(e) => setSkipPagesInput(e.target.value)}
                placeholder="e.g. 1, 2, 3"
                className="flex-1 text-xs rounded-lg border border-slate-200 px-2 py-1.5 focus:outline-none focus:border-primary-400"
              />
              <button
                onClick={async () => {
                  setSavingSkipPages(true);
                  try {
                    const pages = skipPagesInput.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0);
                    await fetch(`/api/exam/${id}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ skipPages: pages }),
                    });
                    setSkipPagesInput(pages.join(", "));
                  } finally {
                    setSavingSkipPages(false);
                  }
                }}
                disabled={savingSkipPages}
                className="text-xs px-3 py-1.5 rounded-lg bg-primary-500 text-white font-medium hover:bg-primary-600 disabled:opacity-50 transition-colors shrink-0"
              >
                {savingSkipPages ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        )}
        {/* Admin-only: Passage pages config — English only */}
        {isAdmin && paper.subject?.toLowerCase().includes("english") && (
          <div className="mt-3 pt-3 border-t border-slate-100">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Comprehension Passage Pages</p>
            <p className="text-xs text-slate-400 mb-2">Pages from Booklet A showing the comprehension passage — duplicated just before Open-ended Comprehension questions. Auto-detected for English exams; override here if needed. Comma-separated, 1-based.</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={passagePagesInput}
                onChange={(e) => setPassagePagesInput(e.target.value)}
                placeholder="e.g. 8, 9"
                className="flex-1 text-xs rounded-lg border border-slate-200 px-2 py-1.5 focus:outline-none focus:border-primary-400"
              />
              <button
                onClick={async () => {
                  setSavingPassagePages(true);
                  try {
                    const pages = passagePagesInput.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0);
                    await fetch(`/api/exam/${id}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ passagePages: pages }),
                    });
                    setPassagePagesInput(pages.join(", "));
                  } finally {
                    setSavingPassagePages(false);
                  }
                }}
                disabled={savingPassagePages}
                className="text-xs px-3 py-1.5 rounded-lg bg-primary-500 text-white font-medium hover:bg-primary-600 disabled:opacity-50 transition-colors shrink-0"
              >
                {savingPassagePages ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        )}
        {/* Admin-only: AI detection debug info */}
        {isAdmin && paper.metadata ? (
          <div className="mt-3 pt-3 border-t border-slate-100">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">AI Detection Details</p>
            <div className="space-y-1.5 text-xs text-slate-600">
              <div className="flex justify-between">
                <span>Answer pages</span>
                <span className={`font-mono font-medium ${paper.metadata.answerPages.length === 0 ? "text-red-500" : "text-green-600"}`}>
                  {paper.metadata.answerPages.length > 0 ? paper.metadata.answerPages.join(", ") : "None detected"}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Cover pages</span>
                <span className="font-mono font-medium text-slate-500">
                  {paper.metadata.coverPages.length > 0 ? paper.metadata.coverPages.join(", ") : "None"}
                </span>
              </div>
              {paper.subject?.toLowerCase().includes("english") && (
                <>
                  <div className="flex justify-between">
                    <span>Hidden from student (skipPages)</span>
                    <span className={`font-mono font-medium ${(paper.metadata.skipPages ?? []).length === 0 ? "text-slate-400" : "text-amber-600"}`}>
                      {(paper.metadata.skipPages ?? []).length > 0 ? paper.metadata.skipPages!.join(", ") : "None"}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Passage pages (duplicated)</span>
                    <span className={`font-mono font-medium ${(paper.metadata.passagePages ?? []).length === 0 ? "text-slate-400" : "text-blue-600"}`}>
                      {(paper.metadata.passagePages ?? []).length > 0 ? paper.metadata.passagePages!.join(", ") : "None detected"}
                    </span>
                  </div>
                </>
              )}
              <div className="flex justify-between">
                <span>Total pages</span>
                <span className="font-mono font-medium text-slate-500">{paper.pageCount}</span>
              </div>
              {paper.metadata.papers.length > 0 ? (
                <div className="mt-2">
                  <p className="text-xs font-medium text-slate-500 mb-1">Booklets:</p>
                  {paper.metadata.papers.map((b, i) => (
                    <div key={i} className="flex justify-between bg-slate-50 rounded-lg px-2 py-1 mb-1">
                      <span>{b.label}{b.questionPrefix ? ` (prefix: ${b.questionPrefix})` : ""}</span>
                      <span className="font-mono text-slate-500">
                        {b.expectedQuestions}Q, start pg {b.questionsStartPage}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="flex justify-between">
                <span>Answers detected</span>
                <span className="font-mono font-medium text-slate-500">
                  {paper.metadata.answersDetected.length} [{paper.metadata.answersDetected.slice(0, 15).join(", ")}{paper.metadata.answersDetected.length > 15 ? "..." : ""}]
                </span>
              </div>
              {paper.metadata.validationIssues && paper.metadata.validationIssues.length > 0 ? (
                <div className="mt-2">
                  <p className="text-xs font-medium text-red-500 mb-1">Validation Issues:</p>
                  {paper.metadata.validationIssues.map((issue, i) => (
                    <p key={i} className="text-xs text-red-400 pl-2">• {issue}</p>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </Section>

      {/* Admin: Math / Science question transcription preview */}
      {isAdmin && (paper.subject?.toLowerCase().includes("math") || paper.subject?.toLowerCase().includes("science")) && (
        <Section title="Quiz Question Preview (Admin)">
          <p className="text-xs text-slate-500 mb-3">
            Transcribes all question images (MCQ + open-ended) into clean text using AI.
          </p>
          <div className="flex gap-2 mb-1">
            {mcqExtracted ? (
              <div className="flex-1 flex items-center gap-2 py-2 px-3 rounded-xl bg-green-50 border border-green-200">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-green-500 shrink-0"><polyline points="20 6 9 17 4 12"/></svg>
                <span className="text-sm font-medium text-green-700">Extracted</span>
                <button
                  onClick={generateMcqPreview}
                  disabled={mcqTranscribing}
                  className="ml-auto text-xs text-slate-400 hover:text-slate-600 disabled:opacity-50"
                >
                  {mcqTranscribing ? "Re-extracting…" : "Re-extract"}
                </button>
              </div>
            ) : (
              <button
                onClick={generateMcqPreview}
                disabled={mcqTranscribing}
                className="flex-1 py-2 rounded-xl text-sm font-medium bg-violet-500 text-white disabled:opacity-50"
              >
                {mcqTranscribing ? "Transcribing questions…" : "Extract Clean Questions"}
              </button>
            )}
            <button
              onClick={() => router.push(`/exam/${id}/transcribe-edit?userId=${userId}`)}
              className="px-3 py-2 rounded-xl text-sm font-medium bg-violet-100 text-violet-700 hover:bg-violet-200"
            >
              Edit &amp; Save
            </button>
          </div>
          {mcqError && (
            <p className="mt-3 text-xs text-red-500">{mcqError}</p>
          )}
          {mcqResults && (
            <div className="mt-4 space-y-4">
              <p className="text-xs text-slate-500">
                {mcqResults.filter(q => q.type === "mcq").length} MCQ &nbsp;·&nbsp;
                {mcqResults.filter(q => q.type === "open").length} open-ended
              </p>
              {mcqResults.map((q) => (
                <div key={q.questionNum} className={`rounded-xl border p-3 ${q.type === "mcq" ? "bg-slate-50 border-slate-200" : "bg-amber-50 border-amber-200"}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-slate-700">Q{q.questionNum}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${q.type === "mcq" ? "bg-slate-200 text-slate-600" : "bg-amber-200 text-amber-700"}`}>
                        {q.type === "mcq" ? "MCQ" : "Open"}
                      </span>
                    </div>
                    <div className="flex gap-2 flex-wrap justify-end">
                      {q.syllabusTopic && (
                        <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">{q.syllabusTopic}</span>
                      )}
                      {q.marksAvailable && (
                        <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">{q.marksAvailable}m</span>
                      )}
                      {q.type === "mcq" && (
                        <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">Ans: ({q.answer})</span>
                      )}
                    </div>
                  </div>
                  {q.error ? (
                    <p className="text-xs text-red-500">Error: {q.error}</p>
                  ) : q.type === "mcq" ? (
                    <>
                      <p className="text-sm text-slate-800 mb-3 leading-relaxed">{q.stem}</p>
                      {q.diagramBase64 && (
                        <img
                          src={`data:image/jpeg;base64,${q.diagramBase64}`}
                          alt="diagram"
                          className="max-w-full rounded-lg border border-slate-200 mb-3"
                        />
                      )}
                      <div className="space-y-1.5">
                        {q.options?.map((opt, i) => (
                          <div
                            key={i}
                            className={`flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${
                              String(i + 1) === q.answer
                                ? "bg-green-100 text-green-800 font-medium"
                                : "bg-white text-slate-700 border border-slate-200"
                            }`}
                          >
                            <span className="font-mono text-xs mt-0.5 opacity-60">({i + 1})</span>
                            <span>{opt}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="text-sm text-slate-800 leading-relaxed mb-2">{q.stem}</p>
                      {q.diagramBase64 && (
                        <img
                          src={`data:image/jpeg;base64,${q.diagramBase64}`}
                          alt="diagram"
                          className="max-w-full rounded-lg border border-amber-200 mb-3"
                        />
                      )}
                      {q.subparts && q.subparts.length > 0 && (
                        <div className="space-y-2 mt-2">
                          {q.subparts.map((sp) => (
                            <div key={sp.label} className="flex gap-2 bg-white rounded-lg px-3 py-2 border border-amber-100">
                              <span className="font-mono text-xs text-amber-600 mt-0.5 shrink-0">({sp.label})</span>
                              <span className="text-sm text-slate-700">{sp.text}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="mt-2 pt-2 border-t border-amber-100">
                        <span className="text-xs text-slate-500">Answer: </span>
                        <span className="text-xs font-mono text-slate-700">{q.answer || "—"}</span>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </Section>
      )}

      {/* Assignment */}
      <Section title="Assignment">
        {/* Feedback mode toggle */}
        <div className="flex items-center justify-between mb-3 pb-3 border-b border-slate-100">
          <div>
            <p className="text-xs font-semibold text-slate-700">
              {instantFeedback ? "Student gets instant feedback" : "Parent reviews grading first"}
            </p>
            <p className="text-xs text-slate-400 mt-0.5">
              {instantFeedback
                ? "Student sees score and feedback immediately after marking completes"
                : "You review and approve the marking before student sees results"}
            </p>
          </div>
          <button
            onClick={() => setInstantFeedback(v => !v)}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${instantFeedback ? "bg-primary-500" : "bg-slate-300"}`}
            role="switch"
            aria-checked={instantFeedback}
          >
            <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ${instantFeedback ? "translate-x-5" : "translate-x-0"}`} />
          </button>
        </div>

        {students.length === 0 ? (
          <p className="text-xs text-slate-400 py-2">No student profiles found.</p>
        ) : (
          <div className="divide-y divide-slate-50">
            {students.map((student) => {
              const clone = clones.find((c) => c.assignedToId === student.id);
              // Legacy: assigned directly on master (pre-clone migration)
              const isLegacy = !clone && paper.assignedToId === student.id;
              const isAssigned = !!clone || isLegacy;

              // Use clone data or master paper data for legacy assignments
              const examId = clone?.id ?? (isLegacy ? paper.id : null);
              const completedAt = clone?.completedAt ?? (isLegacy ? paper.completedAt : null);
              const score = clone?.score ?? (isLegacy ? paper.score : null);
              const mStatus = clone?.markingStatus ?? (isLegacy ? paper.markingStatus : null);
              const timeSpent = clone?.timeSpentSeconds ?? (isLegacy ? paper.timeSpentSeconds : 0);

              const isSubmitted = !!completedAt;
              const isMarking = mStatus === "in_progress";
              const isMarked = mStatus === "complete" || mStatus === "released";
              const isFailed = mStatus === "failed";

              return (
                <div key={student.id} className="flex items-center gap-2 py-2.5">
                  {/* Student info */}
                  <div className="flex-1 min-w-0">
                    <div>
                      <span className="font-semibold text-sm text-slate-800">{student.name}</span>
                      {student.level ? <span className="text-xs text-slate-400 ml-1.5">P{student.level}</span> : null}
                      {isSubmitted ? (
                        <span className="ml-2 text-xs text-green-600 font-medium">
                          Submitted {new Date(completedAt!).toLocaleDateString("en-SG", { day: "numeric", month: "short" })}
                        </span>
                      ) : isAssigned ? (
                        <span className="ml-2 text-xs text-amber-600 font-medium">In progress</span>
                      ) : null}
                    </div>
                    {isSubmitted && examId ? (
                      <div className="flex items-center gap-2 mt-0.5">
                        <button onClick={() => downloadSubmissionPdf(examId, student.name)}
                          disabled={downloadingCloneId === examId}
                          className="text-xs text-slate-400 hover:text-primary-600 transition-colors">
                          {downloadingCloneId === examId ? <span>Downloading…</span> : <span>Download PDF</span>}
                        </button>
                        {timeSpent > 0 ? (
                          <span className="text-xs text-slate-400">
                            · {formatTime(timeSpent)}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  {/* Marking button — only for assigned + submitted */}
                  {isSubmitted && examId ? (
                    <div className="flex items-center gap-1.5">
                      {isMarking ? (
                        <div className="flex items-center gap-1.5">
                          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-50 border border-blue-200 text-xs text-blue-600">
                            <span className="animate-spin rounded-full h-3 w-3 border-2 border-blue-200 border-t-blue-500 inline-block" />
                            <span>Marking…</span>
                          </div>
                          <button
                            onClick={async () => {
                              await fetch(`/api/exam/${examId}/mark`, { method: "DELETE" });
                              const res = await fetch(`/api/exam/${id}?summary=true`);
                              if (res.ok) setPaper(await res.json());
                            }}
                            className="text-xs text-slate-400 hover:text-red-500 transition-colors px-1"
                            title="Cancel marking"
                          >
                            <span>✕</span>
                          </button>
                        </div>
                      ) : isFailed ? (
                        <button onClick={() => triggerMarking(examId)}
                          className="px-2.5 py-1 rounded-lg bg-red-50 border border-red-200 text-xs text-red-600 hover:bg-red-100 transition-colors">
                          Retry mark
                        </button>
                      ) : isMarked ? (
                        <button onClick={() => openMarkingDetail(examId)} disabled={detailLoading && detailCloneId === examId}
                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-green-50 border border-green-300 text-green-700 hover:bg-green-100 transition-colors disabled:opacity-50">
                          {detailLoading && detailCloneId === examId ? (
                            <span className="inline-flex items-center gap-1">
                              <span className="animate-spin rounded-full h-3 w-3 border-2 border-green-200 border-t-green-500 inline-block" />
                              <span>Loading…</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1">
                              <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24"
                                fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M20 6 9 17l-5-5" />
                              </svg>
                              <span>{score ?? 0}{paper.totalMarks ? `/${paper.totalMarks}` : ""}</span>
                            </span>
                          )}
                        </button>
                      ) : (
                        <button onClick={() => triggerMarking(examId)}
                          className="px-2.5 py-1 rounded-lg bg-primary-50 border-2 border-primary-300 text-xs font-semibold text-primary-700 hover:bg-primary-100 transition-colors">
                          Mark paper
                        </button>
                      )}
                    </div>
                  ) : null}

                  {/* Assign / Unassign */}
                  {isAssigned ? (
                    <div className="flex items-center gap-1">
                      <span className="text-xs font-semibold text-blue-600 bg-blue-50 border border-blue-200 rounded-lg px-2.5 py-1 whitespace-nowrap">
                        Assigned
                      </span>
                      <button onClick={() => isLegacy ? handleLegacyUnassign() : handleUnassign(clone!.id)} disabled={assigning}
                        className="text-xs text-slate-300 hover:text-red-500 transition-colors p-0.5 disabled:opacity-50"
                        title="Unassign">
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => handleAssign(student.id)} disabled={assigning}
                      className="text-xs font-medium text-slate-600 border border-slate-200 rounded-lg px-2.5 py-1 hover:bg-slate-50 disabled:opacity-50 transition-colors whitespace-nowrap">
                      Assign
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Section>

    </div>
  );

  // ── Portals — rendered into document.body to avoid React reconciliation issues ──
  const markingDetailPortal = mounted && markingDetail ? createPortal(
    <div className="fixed inset-0 z-50 bg-white flex flex-col">
      {/* Header */}
      <div className="sticky top-0 bg-white border-b border-slate-100 px-4 py-3 flex items-center gap-3">
        <button onClick={() => { setMarkingDetail(null); setDetailCloneId(null); }}
          className="p-1.5 -ml-1 rounded-lg text-slate-500 hover:text-slate-700 hover:bg-slate-100">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <div className="flex-1">
          <p className="text-sm font-semibold text-slate-800">{paper.title}</p>
          <p className="text-xs text-slate-400">Marking Results · {detailStudentName}</p>
        </div>
        <div className="text-right">
          <p className="text-xl font-bold text-primary-600">
            <span>{markingDetail.score ?? 0}</span>
            {paper.totalMarks ? <span className="text-sm font-normal text-slate-400"> / {paper.totalMarks}</span> : null}
          </p>
        </div>
      </div>

      {/* Per-booklet/paper scores */}
      {markingDetail.bookletScores && markingDetail.bookletScores.length > 0 && (
        <div className="px-4 py-2 bg-slate-50 border-b border-slate-100 flex flex-wrap gap-3">
          {markingDetail.bookletScores.map((b) => (
            <div key={b.label} className="flex items-center gap-1.5 text-xs">
              <span className="text-slate-500">{b.label}:</span>
              <span className="font-semibold text-slate-700">{b.awarded}/{b.available}</span>
            </div>
          ))}
        </div>
      )}

      {/* Unmarked warning banner */}
      {(() => {
        const detailUnmarkedQs = markingDetail.questions.filter((q) => q.marksAwarded === null);
        return detailUnmarkedQs.length > 0 ? (
          <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className="text-amber-500 shrink-0">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span className="text-xs text-amber-700 font-medium">
              Q{detailUnmarkedQs.map((q) => q.questionNum).join(", Q")} could not be marked. Use Re-mark to retry.
            </span>
          </div>
        ) : null;
      })()}

      {/* Per-question card view */}
      {(() => {
        const incorrectQs = markingDetail.questions.filter(
          (q) => q.marksAwarded === null || (q.marksAvailable !== null && q.marksAwarded < q.marksAvailable)
        );
        const displayQs = reviewShowAll ? markingDetail.questions : incorrectQs;
        const currentQ = displayQs[reviewIdx] ?? null;

        function renderAnswer(text: string) {
          return text.split("|").map((part, i, arr) => (
            <span key={i}>{part.trim()}{i < arr.length - 1 ? <br /> : null}</span>
          ));
        }

        return (
          <div className="flex-1 overflow-y-auto px-4 py-3">
            {/* Feedback summary — inside scrollable area */}
            {markingDetail.feedbackSummary ? (
              <div className="py-3 mb-3 bg-gradient-to-r from-primary-50 to-blue-50 rounded-xl px-4 border border-slate-100">
                {editingFeedback ? (
                  <div className="space-y-2">
                    <textarea
                      value={feedbackDraft}
                      onChange={(e) => setFeedbackDraft(e.target.value)}
                      rows={5}
                      className="w-full px-3 py-2 text-sm rounded-xl border border-slate-300 focus:outline-none focus:border-primary-400 resize-y"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        onClick={saveFeedback}
                        disabled={savingFeedback}
                        className="px-3 py-1.5 rounded-lg bg-primary-500 text-white text-xs font-medium hover:bg-primary-600 disabled:opacity-50"
                      >
                        {savingFeedback ? <span>Saving...</span> : <span>Save</span>}
                      </button>
                      <button
                        onClick={() => setEditingFeedback(false)}
                        className="px-3 py-1.5 rounded-lg border border-slate-200 text-slate-500 text-xs font-medium hover:bg-slate-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-line">
                      {markingDetail.feedbackSummary}
                    </p>
                    <div className="flex items-center gap-3 mt-2">
                      <button
                        onClick={() => {
                          setFeedbackDraft(markingDetail.feedbackSummary ?? "");
                          setEditingFeedback(true);
                        }}
                        className="text-xs text-primary-500 hover:text-primary-700 font-medium"
                      >
                        Edit
                      </button>
                      <button
                        onClick={handleGenerateFeedback}
                        disabled={generatingFeedback}
                        className="text-xs text-slate-400 hover:text-primary-500 font-medium disabled:opacity-50"
                      >
                        {generatingFeedback ? "Regenerating..." : "Regenerate"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="mb-3">
                <button
                  onClick={handleGenerateFeedback}
                  disabled={generatingFeedback}
                  className="w-full py-2.5 rounded-xl border-2 border-dashed border-primary-200 text-primary-600 text-sm font-medium hover:bg-primary-50 transition-colors disabled:opacity-50"
                >
                  {generatingFeedback ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="animate-spin rounded-full h-3.5 w-3.5 border-2 border-primary-200 border-t-primary-500 inline-block" />
                      Generating summary...
                    </span>
                  ) : (
                    "Generate Summary"
                  )}
                </button>
              </div>
            )}

            {/* Toggle */}
            <div className="flex justify-end mb-3">
              <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden text-xs font-medium">
                <button
                  onClick={() => { setReviewShowAll(false); setReviewIdx(0); }}
                  className={`px-3 py-1.5 transition-colors ${!reviewShowAll ? "bg-primary-500 text-white" : "text-slate-500 hover:bg-slate-50"}`}
                >
                  Incorrect ({incorrectQs.length})
                </button>
                <button
                  onClick={() => { setReviewShowAll(true); setReviewIdx(0); }}
                  className={`px-3 py-1.5 transition-colors ${reviewShowAll ? "bg-primary-500 text-white" : "text-slate-500 hover:bg-slate-50"}`}
                >
                  All ({markingDetail.questions.length})
                </button>
              </div>
            </div>

            {displayQs.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-3xl mb-3">&#127881;</p>
                <p className="text-slate-600 font-medium">All correct!</p>
              </div>
            ) : (
              <div>
                {/* Navigation */}
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                    {reviewShowAll ? "All Questions" : "Questions to Review"}
                  </h2>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setReviewIdx((i) => Math.max(0, i - 1))}
                      disabled={reviewIdx === 0}
                      className="p-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
                        fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m15 18-6-6 6-6" />
                      </svg>
                    </button>
                    <span className="text-xs font-medium text-slate-500 min-w-[3rem] text-center">
                      {reviewIdx + 1} / {displayQs.length}
                    </span>
                    <button
                      onClick={() => setReviewIdx((i) => Math.min(displayQs.length - 1, i + 1))}
                      disabled={reviewIdx === displayQs.length - 1}
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
                      {currentQ.marksAwarded === null ? (
                        <span className="text-xs font-semibold text-amber-500 bg-amber-50 px-2 py-0.5 rounded-full">
                          Not marked
                        </span>
                      ) : (
                        <span className={`text-sm font-bold ${
                          currentQ.marksAwarded >= (currentQ.marksAvailable ?? 0) ? "text-green-600" :
                          currentQ.marksAwarded === 0 ? "text-red-500" : "text-amber-600"
                        }`}>
                          {currentQ.marksAwarded} / {currentQ.marksAvailable ?? 0}
                        </span>
                      )}
                    </div>

                    {/* Extracted question image */}
                    {currentQ.imageData ? (
                      <div className="border-b border-slate-100 bg-slate-50 px-2 py-2">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={currentQ.imageData}
                          alt={`Question ${currentQ.questionNum}`}
                          className="w-full h-auto rounded-lg"
                        />
                      </div>
                    ) : null}

                    {/* Side-by-side on wide screens */}
                    <div className="md:flex">
                      {/* Submission image */}
                      <div className="border-b border-slate-100 md:border-b-0 md:border-r md:w-1/2 md:shrink-0">
                        <button onClick={() => setLightboxQ(currentQ)} className="w-full block">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`/api/exam/${detailCloneId}/submission?page=${getSubmissionPage(currentQ.pageIndex)}`}
                            alt={`Q${currentQ.questionNum}`}
                            className="w-full h-auto"
                          />
                        </button>
                      </div>

                      {/* Solutions panel */}
                      <div className="px-4 py-3 space-y-3 md:flex-1 md:overflow-y-auto md:max-h-[60vh]">
                        {/* Correct answer */}
                        {currentQ.answer ? (
                          <div>
                            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                              Correct Answer
                            </p>
                            <div className="text-sm text-slate-800 leading-relaxed max-h-48 overflow-y-auto rounded-lg bg-slate-50 p-3 border border-slate-100">
                              {renderAnswer(currentQ.answer)}
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
                              {renderAnswer(currentQ.markingNotes)}
                            </p>
                          </div>
                        ) : null}

                        {/* AI Elaboration — available for all questions */}
                        {currentQ.marksAwarded !== null && (
                          <div>
                            {elaborations[currentQ.id] ? (
                              <div>
                                <p className="text-xs font-semibold text-teal-500 uppercase tracking-wide mb-1">
                                  AI Elaboration
                                </p>
                                <div className="text-sm text-teal-800 leading-relaxed whitespace-pre-line rounded-lg bg-teal-50 border border-teal-200 p-3 max-h-40 overflow-y-auto">
                                  {elaborations[currentQ.id]}
                                </div>
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

                        {/* Actions */}
                        <div className="pt-2 border-t border-slate-100">
                          {manualId === currentQ.id ? (
                            <div className="flex items-center gap-1.5">
                              <input type="number" value={manualValue} onChange={(e) => setManualValue(e.target.value)}
                                placeholder="Marks" min="0" step="0.5"
                                className="w-16 px-2 py-1.5 text-xs rounded-lg border border-slate-300 focus:outline-none focus:border-primary-400" />
                              <button onClick={() => saveManualMark(currentQ.id)}
                                className="text-xs px-3 py-1.5 rounded-lg bg-primary-500 text-white font-medium hover:bg-primary-600">
                                Save
                              </button>
                              <button onClick={() => setManualId(null)}
                                className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50">
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              {remarkingId === currentQ.id ? (
                                <div className="flex items-center gap-1 text-xs text-blue-500">
                                  <span className="animate-spin rounded-full h-3 w-3 border-2 border-blue-200 border-t-blue-500 inline-block" />
                                  <span>Re-marking...</span>
                                </div>
                              ) : (
                                <button onClick={() => remarkQuestion(currentQ.id)}
                                  className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 transition-colors">
                                  Re-mark
                                </button>
                              )}
                              <button onClick={() => { setManualId(currentQ.id); setManualValue(String(currentQ.marksAwarded ?? "")); }}
                                className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 transition-colors">
                                Manual
                              </button>
                            </div>
                          )}
                        </div>
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
        );
      })()}

      {/* Footer */}
      <div className="border-t border-slate-100 px-4 py-3 space-y-2">
        {markingDetail.markingStatus === "complete" ? (
          <button
            onClick={finalizeAndSend}
            disabled={finalizing || markingDetail.questions.some(q => q.marksAwarded === null)}
            className="w-full py-2.5 rounded-xl bg-green-500 text-white text-sm font-semibold hover:bg-green-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {finalizing ? "Sending\u2026" : "Finalize & send to student"}
          </button>
        ) : markingDetail.markingStatus === "released" ? (
          <div className="w-full py-2.5 rounded-xl bg-green-50 border border-green-200 text-green-700 text-sm font-medium text-center">
            Results sent to student
          </div>
        ) : null}
        {isAdmin && (
          <button onClick={() => { if (detailCloneId) triggerMarking(detailCloneId); setMarkingDetail(null); setDetailCloneId(null); }}
            className="w-full py-2.5 rounded-xl border-2 border-slate-200 text-slate-500 text-sm font-medium hover:bg-slate-50 transition-colors">
            Re-mark all questions
          </button>
        )}
      </div>
    </div>,
    document.body
  ) : null;

  const lightboxPortal = mounted && lightboxQ ? createPortal(
    <div className="fixed inset-0 z-[60] bg-black/90 flex flex-col"
      onClick={() => setLightboxQ(null)}>
      <div className="flex items-center justify-between px-4 py-3 bg-black/60 shrink-0">
        <span className="text-white text-sm font-medium">Q{lightboxQ.questionNum}</span>
        <button className="text-slate-300 hover:text-white p-1">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="flex-1 overflow-auto flex items-start justify-center p-4"
        onClick={(e) => e.stopPropagation()}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/exam/${detailCloneId}/submission?page=${getSubmissionPage(lightboxQ.pageIndex)}`}
          alt={`Q${lightboxQ.questionNum}`}
          className="max-w-full h-auto rounded-xl shadow-2xl"
        />
      </div>
      {submissionPageCount > 1 ? (
        <div className="flex items-center justify-center gap-4 py-2 bg-black/60 shrink-0 text-xs text-slate-400">
          <span>Page {getSubmissionPage(lightboxQ.pageIndex) + 1} of {submissionPageCount}</span>
        </div>
      ) : null}
    </div>,
    document.body
  ) : null;

  return (
    <>
      {pageContent}
      {markingDetailPortal}
      {lightboxPortal}
    </>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6 rounded-2xl border border-slate-100 bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 bg-slate-50 border-b border-slate-100">
        <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">{title}</h2>
      </div>
      <div className="px-4 py-1">{children}</div>
    </div>
  );
}

function InfoRow({ label, value, highlight }: {
  label: string;
  value: string | null | undefined;
  highlight?: "green" | "amber";
}) {
  const valueClass =
    highlight === "green" ? "text-green-600 font-semibold" :
    highlight === "amber" ? "text-amber-600 font-semibold" :
    "text-slate-800 font-semibold";
  return (
    <div className="flex items-center justify-between py-2 border-b border-slate-50 last:border-0">
      <span className="text-sm text-slate-500">{label}</span>
      <span className={`text-sm ${valueClass}`}>{value ?? "—"}</span>
    </div>
  );
}
