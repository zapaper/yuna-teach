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
}

interface MarkingDetail {
  markingStatus: string | null;
  score: number | null;
  feedbackSummary: string | null;
  questions: MarkingQuestion[];
}

// ─── Main content ─────────────────────────────────────────────────────────────

function ExamOverviewContent({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";

  const [paper, setPaper] = useState<ExamPaperDetail | null>(null);
  const [students, setStudents] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [assigning, setAssigning] = useState(false);

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

  // Feedback editing
  const [editingFeedback, setEditingFeedback] = useState(false);
  const [feedbackDraft, setFeedbackDraft] = useState("");
  const [savingFeedback, setSavingFeedback] = useState(false);
  const [finalizing, setFinalizing] = useState(false);

  // Lightbox for question image pop-up
  const [lightboxQ, setLightboxQ] = useState<MarkingQuestion | null>(null);
  const [submissionPageCount, setSubmissionPageCount] = useState(0);

  // Download PDF state (tracks which clone is downloading)
  const [downloadingCloneId, setDownloadingCloneId] = useState<string | null>(null);

  // Portal mount guard (portals require document to exist)
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    async function fetchAll() {
      try {
        const [paperRes, linkRes] = await Promise.all([
          fetch(`/api/exam/${id}?summary=true`),
          fetch(`/api/link?userId=${userId}`),
        ]);
        if (!paperRes.ok) throw new Error("Not found");
        const [paperData, linkData] = await Promise.all([
          paperRes.json(),
          linkRes.json(),
        ]);
        setPaper(paperData);
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

  function startPolling() {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/exam/${id}?summary=true`);
        if (!res.ok) return;
        const data = await res.json();
        setPaper(data);
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
      await fetch(`/api/exam/${cloneId}/mark`, { method: "POST" });
      startPolling();
    } catch {
      // ignore
    }
  }

  async function openMarkingDetail(cloneId: string) {
    setDetailCloneId(cloneId);
    setDetailLoading(true);
    try {
      const [markRes, subRes] = await Promise.all([
        fetch(`/api/exam/${cloneId}/mark`),
        fetch(`/api/exam/${cloneId}/submission`),
      ]);
      if (markRes.ok) setMarkingDetail(await markRes.json());
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

  async function handleAssign(studentId: string) {
    if (!paper) return;
    setAssigning(true);
    try {
      await fetch(`/api/exam/${paper.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignedToId: studentId }),
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

  const backPath = userId ? `/home/${userId}` : "/";

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

  const clones: ExamCloneSummary[] = paper.clones ?? [];
  const detailClone = clones.find((c) => c.id === detailCloneId);
  const detailStudentName = detailClone?.assignedToName
    ?? (detailCloneId === paper.id ? paper.assignedToName : null)
    ?? "Student";

  const pageContent = (
    <div className="p-6 pb-24 max-w-2xl mx-auto">
      {/* Back */}
      <button
        onClick={() => router.push(backPath)}
        className="flex items-center gap-1 text-slate-500 mb-6 hover:text-slate-700"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m15 18-6-6 6-6" />
        </svg>
        Home
      </button>

      <h1 className="text-2xl font-bold text-slate-800 mb-1">{paper.title}</h1>
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
        <InfoRow label="Total Marks" value={paper.totalMarks} />
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
        <button onClick={() => router.push(`/exam/${id}/edit?userId=${userId}`)}
          className="mt-3 w-full py-2.5 px-4 rounded-xl border-2 border-primary-200 text-primary-600 font-medium text-sm hover:bg-primary-50 transition-colors">
          Edit Questions &amp; Answers
        </button>
      </Section>

      {/* Assignment */}
      <Section title="Assignment">
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

      {/* Unmarked warning banner */}
      {(() => {
        const detailUnmarked = markingDetail.questions.filter((q) => q.marksAwarded === null).length;
        return detailUnmarked > 0 ? (
          <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 flex items-center gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className="text-amber-500 shrink-0">
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span className="text-xs text-amber-700 font-medium">
              {detailUnmarked} question{detailUnmarked > 1 ? "s" : ""} could not be marked. Use Re-mark to retry.
            </span>
          </div>
        ) : null;
      })()}

      {/* Feedback summary */}
      {markingDetail.feedbackSummary ? (
        <div className="px-4 py-4 bg-gradient-to-r from-primary-50 to-blue-50 border-b border-slate-100">
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
              <button
                onClick={() => {
                  setFeedbackDraft(markingDetail.feedbackSummary ?? "");
                  setEditingFeedback(true);
                }}
                className="mt-2 text-xs text-primary-500 hover:text-primary-700 font-medium"
              >
                Edit feedback
              </button>
            </div>
          )}
        </div>
      ) : null}

      {/* Per-question grid */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        <div className="grid grid-cols-2 gap-3">
          {markingDetail.questions.map((q) => {
            const awarded = q.marksAwarded ?? null;
            const available = q.marksAvailable ?? null;
            const full = awarded !== null && available !== null && awarded >= available;
            const none = awarded !== null && awarded === 0;
            const submissionPage = getSubmissionPage(q.pageIndex);
            const isRemarking = remarkingId === q.id;
            const isManual = manualId === q.id;

            return (
              <div key={q.id} className="rounded-xl border border-slate-100 bg-white p-2.5 shadow-sm">
                {/* Header: Q number + score */}
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold text-slate-700">Q{q.questionNum}</span>
                  <span className={`text-xs font-bold ${full ? "text-green-600" : none ? "text-red-500" : "text-amber-600"}`}>
                    {awarded !== null ? awarded : "\u2014"}{available !== null ? <span> / {available}</span> : null}
                  </span>
                </div>

                {/* Thumbnail — full width */}
                <button
                  onClick={() => setLightboxQ(q)}
                  className="w-full rounded-lg overflow-hidden border border-slate-200 hover:border-primary-400 transition-colors bg-slate-50 mb-1.5"
                  title="View question image"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/exam/${detailCloneId}/submission?page=${submissionPage}`} alt={`Q${q.questionNum}`}
                    className="w-full h-auto block"
                    style={q.yStartPct != null && q.yEndPct != null ? {
                      objectFit: "cover",
                      objectPosition: `50% ${(q.yStartPct + q.yEndPct) / 2}%`,
                      aspectRatio: `1 / ${((q.yEndPct - q.yStartPct) / 100) * 1.5}`,
                    } : {}}
                  />
                </button>

                {/* Expected answer + AI notes */}
                {q.answer ? (
                  <p className="text-xs text-slate-400 mb-0.5 truncate" title={q.answer}>
                    <span className="font-medium">Ans:</span> {q.answer}
                  </p>
                ) : null}
                {q.markingNotes ? (
                  <p className="text-xs text-slate-500 leading-relaxed mb-1.5 line-clamp-2">{q.markingNotes}</p>
                ) : null}

                {/* Actions */}
                {isManual ? (
                  <div className="flex items-center gap-1.5">
                    <input type="number" value={manualValue} onChange={(e) => setManualValue(e.target.value)}
                      placeholder="Marks" min="0" step="0.5"
                      className="w-14 px-1.5 py-1 text-xs rounded-lg border border-slate-300 focus:outline-none focus:border-primary-400" />
                    <button onClick={() => saveManualMark(q.id)}
                      className="text-xs px-2 py-1 rounded-lg bg-primary-500 text-white font-medium hover:bg-primary-600">
                      Save
                    </button>
                    <button onClick={() => setManualId(null)}
                      className="text-xs px-2 py-1 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50">
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    {isRemarking ? (
                      <div className="flex items-center gap-1 text-xs text-blue-500">
                        <span className="animate-spin rounded-full h-3 w-3 border-2 border-blue-200 border-t-blue-500 inline-block" />
                        <span>Re-marking</span>
                      </div>
                    ) : (
                      <button onClick={() => remarkQuestion(q.id)}
                        className="text-xs px-2 py-1 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 transition-colors">
                        Re-mark
                      </button>
                    )}
                    <button onClick={() => { setManualId(q.id); setManualValue(String(q.marksAwarded ?? "")); }}
                      className="text-xs px-2 py-1 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 transition-colors">
                      Manual
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

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
        <button onClick={() => { if (detailCloneId) triggerMarking(detailCloneId); setMarkingDetail(null); setDetailCloneId(null); }}
          className="w-full py-2.5 rounded-xl border-2 border-slate-200 text-slate-500 text-sm font-medium hover:bg-slate-50 transition-colors">
          Re-mark all questions
        </button>
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
