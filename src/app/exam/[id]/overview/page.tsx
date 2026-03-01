"use client";

import { Suspense, useEffect, useRef, useState, use } from "react";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import { ExamPaperDetail, ExamQuestionItem, User } from "@/types";

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

// ─── Marking detail question (includes imageData) ─────────────────────────────

interface MarkingQuestion {
  id: string;
  questionNum: string;
  pageIndex: number;
  yStartPct: number | null;
  yEndPct: number | null;
  imageData: string;
  marksAwarded: number | null;
  marksAvailable: number | null;
  markingNotes: string | null;
}

interface MarkingDetail {
  markingStatus: string | null;
  score: number | null;
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

  // Marking state
  const [marking, setMarking] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Marking detail overlay
  const [markingDetail, setMarkingDetail] = useState<MarkingDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Per-question state within overlay
  const [remarkingId, setRemarkingId] = useState<string | null>(null);
  const [manualId, setManualId] = useState<string | null>(null);
  const [manualValue, setManualValue] = useState("");

  // Lightbox for question image pop-up
  const [lightboxQ, setLightboxQ] = useState<MarkingQuestion | null>(null);
  const [submissionPageCount, setSubmissionPageCount] = useState(0);

  // Portal mount guard (portals require document to exist)
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    async function fetchAll() {
      try {
        const [paperRes, usersRes] = await Promise.all([
          fetch(`/api/exam/${id}?summary=true`),
          fetch("/api/users"),
        ]);
        if (!paperRes.ok) throw new Error("Not found");
        const [paperData, usersData] = await Promise.all([
          paperRes.json(),
          usersRes.json(),
        ]);
        setPaper(paperData);
        setStudents(
          (usersData.users as User[]).filter((u) => u.role === "STUDENT")
        );
        if (paperData.completedAt) {
          const subRes = await fetch(`/api/exam/${id}/submission`);
          if (subRes.ok) {
            const sub = await subRes.json();
            setSubmissionPageCount(sub.pageCount ?? 0);
          }
        }
        // If marking was already in_progress when page loaded, start polling
        if (paperData.completedAt && paperData.markingStatus === "in_progress") {
          setMarking(true);
          startPolling();
        }
      } catch {
        // handled by null check below
      } finally {
        setLoading(false);
      }
    }
    fetchAll();
    return () => stopPolling();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  function startPolling() {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/exam/${id}?summary=true`);
        if (!res.ok) return;
        const data: ExamPaperDetail = await res.json();
        setPaper(data);
        if (data.markingStatus === "complete" || data.markingStatus === "failed") {
          stopPolling();
          setMarking(false);
        }
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

  async function triggerMarking() {
    if (marking) return;
    setMarking(true);
    try {
      await fetch(`/api/exam/${id}/mark`, { method: "POST" });
      // Immediately start polling for completion
      startPolling();
    } catch {
      setMarking(false);
    }
  }

  async function openMarkingDetail() {
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/exam/${id}/mark`);
      if (res.ok) setMarkingDetail(await res.json());
    } finally {
      setDetailLoading(false);
    }
  }

  async function remarkQuestion(questionId: string) {
    setRemarkingId(questionId);
    try {
      await fetch(`/api/exam/${id}/mark?questionId=${questionId}`, { method: "POST" });
      // Poll until updated
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        const res = await fetch(`/api/exam/${id}/mark`);
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
      fetch(`/api/exam/${id}/mark`),
      fetch(`/api/exam/${id}?summary=true`),
    ]);
    if (detailRes.ok) setMarkingDetail(await detailRes.json());
    if (summaryRes.ok) setPaper(await summaryRes.json());
  }

  async function handleAssign(studentId: string | null) {
    if (!paper) return;
    setAssigning(true);
    try {
      await fetch(`/api/exam/${paper.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignedToId: studentId }),
      });
      const student = studentId
        ? students.find((s) => s.id === studentId)
        : null;
      setPaper((prev) =>
        prev
          ? { ...prev, assignedToId: studentId, assignedToName: student?.name ?? null }
          : prev
      );
    } finally {
      setAssigning(false);
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

  const isMarked = paper.markingStatus === "complete";
  const isMarkingFailed = paper.markingStatus === "failed";

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
        {paper.school && <span>{paper.school} · </span>}
        Added {new Date(paper.createdAt).toLocaleDateString()}
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
            {hasMissingAnswers && (
              <span className="ml-2 text-xs font-normal text-red-400">({missingAnswers} missing)</span>
            )}
          </span>
        </div>
        {hasMissingAnswers && (
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
        )}
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
              const isAssigned = paper.assignedToId === student.id;
              const isSubmitted = isAssigned && !!paper.completedAt;
              return (
                <div key={student.id} className="flex items-center gap-2 py-2.5">
                  {/* Student info */}
                  <div className="flex-1 min-w-0">
                    <span className="font-semibold text-sm text-slate-800">{student.name}</span>
                    {student.level && <span className="text-xs text-slate-400 ml-1.5">P{student.level}</span>}
                    {isSubmitted && (
                      <span className="ml-2 text-xs text-green-600 font-medium">
                        Submitted {new Date(paper.completedAt!).toLocaleDateString("en-SG", { day: "numeric", month: "short" })}
                      </span>
                    )}
                    {isAssigned && !paper.completedAt && (
                      <span className="ml-2 text-xs text-amber-600 font-medium">In progress</span>
                    )}
                  </div>

                  {/* Marking button — only for assigned + submitted */}
                  {isSubmitted && (
                    <>
                      {marking && (
                        <div className="flex items-center gap-1.5">
                          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-50 border border-blue-200 text-xs text-blue-600">
                            <div className="animate-spin rounded-full h-3 w-3 border-2 border-blue-200 border-t-blue-500" />
                            Marking…
                          </div>
                          <button
                            onClick={async () => {
                              stopPolling();
                              setMarking(false);
                              await fetch(`/api/exam/${id}/mark`, { method: "DELETE" });
                              setPaper((p) => p ? { ...p, markingStatus: null } : p);
                            }}
                            className="text-xs text-slate-400 hover:text-red-500 transition-colors px-1"
                            title="Cancel marking"
                          >
                            ✕
                          </button>
                        </div>
                      )}
                      {!marking && isMarkingFailed && (
                        <button onClick={triggerMarking}
                          className="px-2.5 py-1 rounded-lg bg-red-50 border border-red-200 text-xs text-red-600 hover:bg-red-100 transition-colors">
                          Retry mark
                        </button>
                      )}
                      {!marking && !isMarked && !isMarkingFailed && (
                        <button onClick={triggerMarking}
                          className="px-2.5 py-1 rounded-lg bg-primary-50 border-2 border-primary-300 text-xs font-semibold text-primary-700 hover:bg-primary-100 transition-colors">
                          Mark paper
                        </button>
                      )}
                      {!marking && isMarked && (
                        <button onClick={() => openMarkingDetail()} disabled={detailLoading}
                          className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-green-50 border border-green-300 text-xs font-semibold text-green-700 hover:bg-green-100 transition-colors disabled:opacity-50">
                          {detailLoading
                            ? <><div className="animate-spin rounded-full h-3 w-3 border-2 border-green-200 border-t-green-500" />Loading…</>
                            : <><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24"
                                fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M20 6 9 17l-5-5" />
                              </svg>
                              {paper.score ?? 0}{paper.totalMarks ? `/${paper.totalMarks}` : ""}</>}
                        </button>
                      )}
                    </>
                  )}

                  {/* Assign / Assigned */}
                  {isAssigned ? (
                    <span className="text-xs font-semibold text-blue-600 bg-blue-50 border border-blue-200 rounded-lg px-2.5 py-1 whitespace-nowrap">
                      Assigned
                    </span>
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

        {/* Time spent */}
        {paper.assignedToId && (paper.timeSpentSeconds ?? 0) > 0 && (
          <div className="border-t border-slate-100 pt-1">
            <InfoRow label="Time spent" value={(() => {
              const s = paper.timeSpentSeconds ?? 0;
              const h = Math.floor(s / 3600);
              const m = Math.floor((s % 3600) / 60);
              const sec = s % 60;
              return h > 0 ? `${h}h ${m}m ${sec}s` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
            })()} />
          </div>
        )}

        {/* Unassign */}
        {paper.assignedToId && (
          <div className="border-t border-slate-100 pt-2">
            <button onClick={() => handleAssign(null)} disabled={assigning}
              className="w-full py-2 px-3 rounded-xl border border-red-200 text-red-600 text-sm font-medium hover:bg-red-50 disabled:opacity-50 transition-colors">
              Unassign
            </button>
          </div>
        )}
      </Section>

      {/* Open practice */}
      {paper.assignedToId && (
        <button
          onClick={() => router.push(`/exam/${id}?userId=${paper.assignedToId}`)}
          className="w-full py-3.5 rounded-2xl bg-primary-500 text-white font-semibold text-base hover:bg-primary-600 transition-colors"
        >
          Open Practice
        </button>
      )}

    </div>
  );

  // ── Portals — rendered into document.body to avoid React reconciliation issues ──
  const markingDetailPortal = mounted && markingDetail && createPortal(
    <div className="fixed inset-0 z-50 bg-white flex flex-col">
      {/* Header */}
      <div className="sticky top-0 bg-white border-b border-slate-100 px-4 py-3 flex items-center gap-3">
        <button onClick={() => setMarkingDetail(null)}
          className="p-1.5 -ml-1 rounded-lg text-slate-500 hover:text-slate-700 hover:bg-slate-100">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <div className="flex-1">
          <p className="text-sm font-semibold text-slate-800">{paper.title}</p>
          <p className="text-xs text-slate-400">Marking Results · {paper.assignedToName}</p>
        </div>
        <div className="text-right">
          <p className="text-xl font-bold text-primary-600">
            {markingDetail.score ?? 0}
            {paper.totalMarks ? <span className="text-sm font-normal text-slate-400"> / {paper.totalMarks}</span> : ""}
          </p>
        </div>
      </div>

      {/* Per-question list */}
      <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
        {markingDetail.questions.map((q) => {
          const awarded = q.marksAwarded ?? null;
          const available = q.marksAvailable ?? null;
          const full = awarded !== null && available !== null && awarded >= available;
          const none = awarded !== null && awarded === 0;
          const submissionPage = getSubmissionPage(q.pageIndex);
          const isRemarking = remarkingId === q.id;
          const isManual = manualId === q.id;

          return (
            <div key={q.id} className="px-4 py-3">
              <div className="flex items-start gap-3">
                {/* Question thumbnail */}
                <button
                  onClick={() => setLightboxQ(q)}
                  className="shrink-0 w-16 rounded-lg overflow-hidden border border-slate-200 hover:border-primary-400 transition-colors bg-slate-50"
                  title="View question image"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/exam/${id}/submission?page=${submissionPage}`} alt={`Q${q.questionNum}`}
                    className="w-full h-auto block"
                    style={q.yStartPct != null && q.yEndPct != null ? {
                      objectFit: "cover",
                      objectPosition: `50% ${(q.yStartPct + q.yEndPct) / 2}%`,
                      aspectRatio: `1 / ${((q.yEndPct - q.yStartPct) / 100) * 1.5}`,
                    } : {}}
                  />
                </button>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-sm font-semibold text-slate-700">Q{q.questionNum}</span>
                    <span className={`text-sm font-bold ${full ? "text-green-600" : none ? "text-red-500" : "text-amber-600"}`}>
                      {awarded !== null ? awarded : "—"}{available !== null ? ` / ${available}` : ""}
                    </span>
                  </div>
                  {q.markingNotes && (
                    <p className="text-xs text-slate-500 leading-relaxed mb-2">{q.markingNotes}</p>
                  )}

                  {/* Actions */}
                  {isManual ? (
                    <div className="flex items-center gap-2 mt-1">
                      <input type="number" value={manualValue} onChange={(e) => setManualValue(e.target.value)}
                        placeholder="Marks" min="0" step="0.5"
                        className="w-20 px-2 py-1 text-xs rounded-lg border border-slate-300 focus:outline-none focus:border-primary-400" />
                      <button onClick={() => saveManualMark(q.id)}
                        className="text-xs px-2.5 py-1 rounded-lg bg-primary-500 text-white font-medium hover:bg-primary-600">
                        Save
                      </button>
                      <button onClick={() => setManualId(null)}
                        className="text-xs px-2.5 py-1 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50">
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 mt-1">
                      {isRemarking ? (
                        <div className="flex items-center gap-1 text-xs text-blue-500">
                          <div className="animate-spin rounded-full h-3 w-3 border-2 border-blue-200 border-t-blue-500" />
                          Re-marking…
                        </div>
                      ) : (
                        <button onClick={() => remarkQuestion(q.id)}
                          className="text-xs px-2.5 py-1 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 transition-colors">
                          Re-mark
                        </button>
                      )}
                      <button onClick={() => { setManualId(q.id); setManualValue(String(q.marksAwarded ?? "")); }}
                        className="text-xs px-2.5 py-1 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 transition-colors">
                        Manual
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="border-t border-slate-100 px-4 py-3">
        <button onClick={() => { triggerMarking(); setMarkingDetail(null); }}
          className="w-full py-2.5 rounded-xl border-2 border-slate-200 text-slate-500 text-sm font-medium hover:bg-slate-50 transition-colors">
          Re-mark all questions
        </button>
      </div>
    </div>,
    document.body
  );

  const lightboxPortal = mounted && lightboxQ && createPortal(
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
          src={`/api/exam/${id}/submission?page=${getSubmissionPage(lightboxQ.pageIndex)}`}
          alt={`Q${lightboxQ.questionNum}`}
          className="max-w-full h-auto rounded-xl shadow-2xl"
        />
      </div>
      {submissionPageCount > 1 && (
        <div className="flex items-center justify-center gap-4 py-2 bg-black/60 shrink-0 text-xs text-slate-400">
          Page {getSubmissionPage(lightboxQ.pageIndex) + 1} of {submissionPageCount}
        </div>
      )}
    </div>,
    document.body
  );

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
