"use client";

import { Suspense, useEffect, useState, use } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ExamPaperDetail, User } from "@/types";

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

function ExamOverviewContent({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";

  const [paper, setPaper] = useState<ExamPaperDetail | null>(null);
  const [students, setStudents] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [assigning, setAssigning] = useState(false);
  const [submissionPageCount, setSubmissionPageCount] = useState<number | null>(null);
  const [viewingPage, setViewingPage] = useState<number | null>(null);

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
        // Fetch submission info if exam is completed
        if (paperData.completedAt) {
          const subRes = await fetch(`/api/exam/${id}/submission`);
          if (subRes.ok) {
            const sub = await subRes.json();
            setSubmissionPageCount(sub.pageCount ?? 0);
          }
        }
      } catch {
        // handled by null check below
      } finally {
        setLoading(false);
      }
    }
    fetchAll();
  }, [id]);

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
          ? {
              ...prev,
              assignedToId: studentId,
              assignedToName: student?.name ?? null,
            }
          : prev
      );
    } finally {
      setAssigning(false);
    }
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
        <button
          onClick={() => router.push(backPath)}
          className="mt-4 text-primary-500 underline"
        >
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

  return (
    <div className="p-6 pb-24 max-w-2xl mx-auto">
      {/* Back */}
      <button
        onClick={() => router.push(backPath)}
        className="flex items-center gap-1 text-slate-500 mb-6 hover:text-slate-700"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
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
        <InfoRow
          label="Year / Semester"
          value={
            [paper.year, paper.semester].filter(Boolean).join(" / ") || null
          }
        />
        <InfoRow label="Total Questions" value={String(questionsDetected)} />
        <InfoRow label="Total Marks" value={paper.totalMarks} />
      </Section>

      {/* Detection Status */}
      <Section title="Detection Status">
        <div className="flex items-center justify-between py-2">
          <span className="text-sm text-slate-600">Questions detected</span>
          <span className="font-semibold text-slate-800">
            {questionsDetected}
          </span>
        </div>
        <div className="flex items-center justify-between py-2 border-t border-slate-100">
          <span className="text-sm text-slate-600">Answers detected</span>
          <span
            className={`font-semibold ${hasMissingAnswers ? "text-red-500" : "text-green-600"}`}
          >
            {answersDetected} / {questionsDetected}
            {hasMissingAnswers && (
              <span className="ml-2 text-xs font-normal text-red-400">
                ({missingAnswers} missing)
              </span>
            )}
          </span>
        </div>
        {hasMissingAnswers && (
          <div className="mt-2 flex items-start gap-2 rounded-xl bg-red-50 border border-red-200 px-3 py-2">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-red-500 mt-0.5 shrink-0"
            >
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <p className="text-xs text-red-600">
              Some answers could not be detected automatically. Use the Edit
              page to fill them in manually.
            </p>
          </div>
        )}
        <button
          onClick={() =>
            router.push(`/exam/${id}/edit?userId=${userId}`)
          }
          className="mt-3 w-full py-2.5 px-4 rounded-xl border-2 border-primary-200 text-primary-600 font-medium text-sm hover:bg-primary-50 transition-colors"
        >
          Edit Questions &amp; Answers
        </button>
      </Section>

      {/* Assignment */}
      <Section title="Assignment">
        {/* Current assignment status */}
        {paper.assignedToName ? (
          <>
            <InfoRow label="Assigned to" value={paper.assignedToName} />
            <InfoRow
              label="Status"
              value={
                paper.completedAt
                  ? `Submitted on ${new Date(paper.completedAt).toLocaleDateString()}`
                  : "In progress"
              }
              highlight={paper.completedAt ? "green" : "amber"}
            />
            {(paper.timeSpentSeconds ?? 0) > 0 && (
              <InfoRow
                label="Time spent"
                value={(() => {
                  const s = paper.timeSpentSeconds ?? 0;
                  const h = Math.floor(s / 3600);
                  const m = Math.floor((s % 3600) / 60);
                  const sec = s % 60;
                  return h > 0
                    ? `${h}h ${m}m ${sec}s`
                    : m > 0
                    ? `${m}m ${sec}s`
                    : `${sec}s`;
                })()}
              />
            )}
            {paper.score !== null && paper.score !== undefined && (
              <InfoRow
                label="Score"
                value={
                  paper.totalMarks
                    ? `${paper.score} / ${paper.totalMarks}`
                    : String(paper.score)
                }
              />
            )}
          </>
        ) : (
          <p className="text-sm text-slate-400 py-2">
            Not yet assigned to any student.
          </p>
        )}

        {/* Assign / change student */}
        <div className="mt-3 pt-3 border-t border-slate-100">
          <p className="text-xs font-medium text-slate-500 mb-2">
            {paper.assignedToName ? "Change assignment" : "Assign to student"}
          </p>
          {students.length === 0 ? (
            <p className="text-xs text-slate-400">
              No student profiles found.
            </p>
          ) : (
            <div className="space-y-2">
              {students.map((student) => (
                <button
                  key={student.id}
                  onClick={() => handleAssign(student.id)}
                  disabled={assigning}
                  className={`w-full text-left rounded-xl py-2.5 px-3 border-2 transition-colors disabled:opacity-50 ${
                    paper.assignedToId === student.id
                      ? "border-blue-400 bg-blue-50 text-blue-700"
                      : "border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50"
                  }`}
                >
                  <span className="font-medium text-sm">{student.name}</span>
                  {student.level && (
                    <span className="text-xs text-slate-400 ml-2">
                      P{student.level}
                    </span>
                  )}
                  {paper.assignedToId === student.id && (
                    <span className="text-xs text-blue-500 ml-2">
                      ✓ current
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
          {paper.assignedToId && (
            <button
              onClick={() => handleAssign(null)}
              disabled={assigning}
              className="mt-2 w-full py-2 px-3 rounded-xl border border-red-200 text-red-600 text-sm font-medium hover:bg-red-50 disabled:opacity-50 transition-colors"
            >
              Unassign
            </button>
          )}
        </div>
      </Section>

      {/* Submission */}
      {paper.completedAt && (
        <Section title="Submission">
          <div className="py-2 flex items-center justify-between">
            <span className="text-sm text-slate-600">Submitted on</span>
            <span className="text-sm font-semibold text-green-600">
              {new Date(paper.completedAt).toLocaleDateString("en-SG", {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </span>
          </div>
          {submissionPageCount !== null && submissionPageCount > 0 && (
            <div className="mt-1 pb-3">
              <p className="text-xs text-slate-400 mb-2">
                {submissionPageCount} page{submissionPageCount !== 1 ? "s" : ""} submitted
              </p>
              <div className="grid grid-cols-3 gap-2">
                {Array.from({ length: submissionPageCount }, (_, i) => (
                  <button
                    key={i}
                    onClick={() => setViewingPage(i)}
                    className="aspect-[3/4] rounded-xl overflow-hidden border-2 border-slate-200 hover:border-primary-400 transition-colors bg-slate-50"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/exam/${id}/submission?page=${i}`}
                      alt={`Page ${i + 1}`}
                      className="w-full h-full object-cover"
                    />
                  </button>
                ))}
              </div>
            </div>
          )}
          {submissionPageCount === 0 && (
            <p className="text-xs text-slate-400 py-2">
              No pages saved with this submission.
            </p>
          )}
        </Section>
      )}

      {/* Full-page image viewer */}
      {viewingPage !== null && submissionPageCount !== null && (
        <div
          className="fixed inset-0 z-50 bg-black/90 flex flex-col"
          onClick={() => setViewingPage(null)}
        >
          <div className="flex items-center justify-between px-4 py-3 bg-black/60 shrink-0">
            <span className="text-white text-sm font-medium">
              Page {viewingPage + 1} / {submissionPageCount}
            </span>
            <button className="text-slate-300 hover:text-white p-1">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div
            className="flex-1 overflow-auto flex items-start justify-center p-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/exam/${id}/submission?page=${viewingPage}`}
              alt={`Page ${viewingPage + 1}`}
              className="max-w-full h-auto rounded-xl shadow-2xl"
            />
          </div>
          <div className="flex items-center justify-center gap-6 py-3 bg-black/60 shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); setViewingPage((p) => Math.max(0, (p ?? 0) - 1)); }}
              disabled={viewingPage === 0}
              className="p-2 rounded-xl text-slate-300 hover:text-white disabled:opacity-30"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
            <span className="text-slate-300 text-sm tabular-nums">
              {viewingPage + 1} / {submissionPageCount}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); setViewingPage((p) => Math.min((submissionPageCount ?? 1) - 1, (p ?? 0) + 1)); }}
              disabled={viewingPage === submissionPageCount - 1}
              className="p-2 rounded-xl text-slate-300 hover:text-white disabled:opacity-30"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Start practice button */}
      {paper.assignedToId && (
        <button
          onClick={() =>
            router.push(
              `/exam/${id}?userId=${paper.assignedToId}`
            )
          }
          className="w-full py-3.5 rounded-2xl bg-primary-500 text-white font-semibold text-base hover:bg-primary-600 transition-colors"
        >
          Open Practice
        </button>
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-6 rounded-2xl border border-slate-100 bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 bg-slate-50 border-b border-slate-100">
        <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">
          {title}
        </h2>
      </div>
      <div className="px-4 py-1">{children}</div>
    </div>
  );
}

function InfoRow({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string | null | undefined;
  highlight?: "green" | "amber";
}) {
  const valueClass =
    highlight === "green"
      ? "text-green-600 font-semibold"
      : highlight === "amber"
        ? "text-amber-600 font-semibold"
        : "text-slate-800 font-semibold";

  return (
    <div className="flex items-center justify-between py-2 border-b border-slate-50 last:border-0">
      <span className="text-sm text-slate-500">{label}</span>
      <span className={`text-sm ${valueClass}`}>{value ?? "—"}</span>
    </div>
  );
}
