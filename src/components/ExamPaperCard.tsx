"use client";

import Link from "next/link";
import { ExamPaperSummary } from "@/types";
import { useState } from "react";

export default function ExamPaperCard({
  paper,
  userId,
  userRole,
  isAdmin,
  onDelete,
}: {
  paper: ExamPaperSummary;
  userId: string;
  userRole?: "PARENT" | "STUDENT";
  isAdmin?: boolean;
  onDelete?: (id: string) => void;
}) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [taggingSyllabus, setTaggingSyllabus] = useState(false);
  const [syllabusTagged, setSyllabusTagged] = useState(false);
  const [visible, setVisible] = useState(paper.visible);
  const [togglingVisible, setTogglingVisible] = useState(false);
  const [generatingTestQuiz, setGeneratingTestQuiz] = useState(false);

  const isExtracting = paper.extractionStatus === "processing";
  const extractionFailed = paper.extractionStatus === "failed";
  const isTaggablePaper = true; // admin can tag syllabus on any paper

  async function tagSyllabus() {
    setTaggingSyllabus(true);
    try {
      const res = await fetch(`/api/exam/${paper.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "tagSyllabus" }),
      });
      if (res.ok) setSyllabusTagged(true);
    } finally {
      setTaggingSyllabus(false);
    }
  }

  async function toggleVisible() {
    setTogglingVisible(true);
    try {
      await fetch(`/api/exam/${paper.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visible: !visible }),
      });
      setVisible((v) => !v);
    } finally {
      setTogglingVisible(false);
    }
  }

  async function retryExtraction() {
    setRetrying(true);
    try {
      await fetch(`/api/exam/${paper.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retryExtraction: true }),
      });
      // Reload the page to show the spinner
      window.location.reload();
    } catch {
      setRetrying(false);
    }
  }

  const isFocused = paper.paperType === "focused";
  const isQuiz = paper.paperType === "quiz";

  const isMarking = paper.markingStatus === "in_progress";

  // Parents: completed clone → review; master/incomplete papers → non-navigable (assign from dashboard)
  // Students: review (if released/complete) or practice; focused tests go to focused page; quizzes go to quiz page
  const examHref = isExtracting || isMarking
    ? "#"
    : userRole === "PARENT"
    ? (paper.completedAt ? `/exam/${paper.id}/review?userId=${userId}` : "#")
    : paper.markingStatus === "released" || paper.markingStatus === "complete" || !!paper.completedAt
    ? `/exam/${paper.id}/review?userId=${userId}`
    : isQuiz || isFocused
    ? `/quiz/${paper.id}?userId=${userId}`
    : `/exam/${paper.id}?userId=${userId}`;

  if (isExtracting) {
    return (
      <div className="relative">
        <div className="block rounded-2xl border-2 border-blue-200 bg-blue-50/50 p-4 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="shrink-0">
              <div className="animate-spin rounded-full h-10 w-10 border-[3px] border-blue-200 border-t-blue-600" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-lg text-slate-700 truncate">
                {paper.title && paper.title !== "Processing..." ? paper.title : "Exam Paper"}
              </h3>
              <p className="text-sm text-blue-600 mt-0.5">Analyzing and extracting...</p>
              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                {paper.subject ? (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-600">
                    {paper.subject}
                  </span>
                ) : null}
                {paper.level ? (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-green-100 text-green-600">
                    {paper.level}
                  </span>
                ) : null}
                {paper.examType ? (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700">
                    {paper.examType}
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-slate-400 mt-1">This takes 3–5 mins. Feel free to continue with other work!</p>
              <button
                onClick={retryExtraction}
                disabled={retrying}
                className="mt-2 text-xs text-slate-400 hover:text-amber-600 transition-colors disabled:opacity-50"
              >
                {retrying ? "Restarting..." : "Stuck? Tap to retry"}
              </button>
            </div>
          </div>
        </div>

        {/* Delete button for processing cards */}
        {onDelete ? (
          <button
            onClick={(e) => {
              e.preventDefault();
              setShowConfirm(true);
            }}
            className="absolute top-3 right-3 p-2 rounded-full text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors z-10"
            aria-label="Delete exam paper"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 6h18" />
              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            </svg>
          </button>
        ) : null}

        {/* Delete confirmation modal */}
        {showConfirm && onDelete ? (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-xl">
              <h3 className="font-semibold text-lg mb-2">Delete Exam Paper?</h3>
              <p className="text-slate-600 text-sm mb-4">
                This will stop processing and delete the paper. This cannot be undone.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowConfirm(false)}
                  className="flex-1 py-2.5 px-4 rounded-xl border border-slate-200 text-slate-600 font-medium hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    onDelete(paper.id);
                    setShowConfirm(false);
                  }}
                  className="flex-1 py-2.5 px-4 rounded-xl bg-red-500 text-white font-medium hover:bg-red-600"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  // ── Student-friendly card ──────────────────────────────────────────────
  const isStudentView = !isAdmin && userRole !== "PARENT";
  if (isStudentView) {
    let friendlyTitle = paper.title;
    if (isFocused) {
      const topic = paper.title.replace(/^P\d+ Focused: /i, "").replace(/^Focused: /i, "");
      friendlyTitle = `Focused practice on ${topic}`;
    } else if (isQuiz) {
      friendlyTitle = paper.subject ? `Daily ${paper.subject} Quiz` : "Daily Quiz";
    } else {
      const subj = paper.subject ?? "";
      const exam = paper.examType ?? "";
      friendlyTitle = `Practice paper${subj || exam ? " for" : ""}${subj ? ` ${subj}` : ""}${exam ? ` ${exam}` : ""}`;
    }

    const bannerColor = isFocused ? "bg-blue-500" : isQuiz ? "bg-emerald-500"
      : paper.subject?.toLowerCase().includes("math") ? "bg-blue-500"
      : paper.subject?.toLowerCase().includes("science") ? "bg-green-500"
      : paper.subject?.toLowerCase().includes("chinese") ? "bg-orange-500"
      : "bg-primary-500";

    const isCompleted = paper.markingStatus === "released" || (paper.instantFeedback && paper.markingStatus === "complete");
    const isSubmitted = !!paper.completedAt && !isCompleted;
    const isMarking = paper.markingStatus === "in_progress";

    const metaParts = [paper.school, paper.level, paper.examType].filter(Boolean);

    return (
      <Link href={examHref} className="block rounded-2xl overflow-hidden shadow-sm active:scale-[0.98] transition-transform">
        <div className={`${bannerColor} px-4 py-5`}>
          <p className="text-white font-bold text-lg leading-snug">{friendlyTitle}</p>
          {isCompleted && paper.score != null && (
            <p className="text-white/80 text-sm mt-0.5">
              Score: {paper.score}{paper.totalMarks ? `/${paper.totalMarks}` : ""}
            </p>
          )}
        </div>
        <div className="bg-white px-4 py-3 flex items-center justify-between gap-3">
          <p className="text-xs text-slate-400 truncate">{metaParts.join(" · ") || "\u00A0"}</p>
          <span className={`shrink-0 px-4 py-1.5 rounded-xl text-sm font-semibold text-white ${
            isCompleted ? "bg-emerald-500" : isSubmitted || isMarking ? "bg-slate-300" : "bg-primary-500"
          }`}>
            {isCompleted ? "View results →" : isMarking ? "Marking…" : isSubmitted ? "Submitted" : "Let's start!"}
          </span>
        </div>
      </Link>
    );
  }

  return (
    <div className="relative">
      <Link
        href={examHref}
        className={`block rounded-2xl border bg-white p-4 shadow-sm transition-all active:scale-[0.98] hover:shadow-md ${
          paper.subject?.toLowerCase().includes("math") ? "border-l-4 border-l-blue-400 border-slate-100" :
          paper.subject?.toLowerCase().includes("science") ? "border-l-4 border-l-green-400 border-slate-100" :
          paper.subject?.toLowerCase().includes("chinese") ? "border-l-4 border-l-orange-400 border-slate-100" :
          "border-slate-100"
        }`}
      >
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-lg text-slate-800 truncate">
              {paper.title}
            </h3>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {isAdmin && paper.cleanExtracted && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-teal-50 text-teal-600 border border-teal-200">
                  Clean Extracted
                </span>
              )}
              {isQuiz ? (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">
                  Quiz
                </span>
              ) : isFocused ? (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">
                  Focused Test
                </span>
              ) : null}
              {paper.subject ? (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
                  {paper.subject}
                </span>
              ) : null}
              {paper.level ? (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                  {paper.level}
                </span>
              ) : null}
              {paper.examType ? (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                  {paper.examType}
                </span>
              ) : null}
              {userRole === "PARENT" && paper.assignmentCount > 0 ? (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
                  {paper.assignmentCount} student{paper.assignmentCount !== 1 ? "s" : ""} assigned
                </span>
              ) : paper.assignedToName ? (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
                  Assigned to {paper.assignedToName}
                </span>
              ) : null}
              {extractionFailed ? (
                <button
                  onClick={(e) => { e.preventDefault(); retryExtraction(); }}
                  disabled={retrying}
                  className="text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-700 hover:bg-red-200 transition-colors disabled:opacity-50"
                >
                  {retrying ? "Retrying..." : "Extraction failed — tap to retry"}
                </button>
              ) : (
                <span className="text-xs text-slate-400">
                  {paper.questionCount} questions
                </span>
              )}
              {isAdmin && paper.flaggedCount > 0 ? (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-red-100 text-red-600 inline-flex items-center gap-1">
                  <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24"
                    fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                    <line x1="4" y1="22" x2="4" y2="15" />
                  </svg>
                  {paper.flaggedCount} flagged
                </span>
              ) : null}
              {userRole === "PARENT" ? (
                isMarking ? (
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
                    Marking
                  </span>
                ) : paper.pendingReviewCount > 0 ? (
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-orange-100 text-orange-700">
                    Pending review ({paper.pendingReviewCount})
                  </span>
                ) : null
              ) : (
                paper.markingStatus === "released" || (paper.instantFeedback && paper.markingStatus === "complete") ? (
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">
                    Marked{paper.score != null ? ` ${paper.score}${paper.totalMarks ? `/${paper.totalMarks}` : ""}` : ""}
                  </span>
                ) : paper.markingStatus === "in_progress" ? (
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">
                    Marking…
                  </span>
                ) : paper.completedAt ? (
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                    Submitted
                  </span>
                ) : null
              )}
            </div>
            {paper.school ? (
              <p className="text-xs text-slate-400 mt-1 truncate">
                {paper.school}
              </p>
            ) : null}
          </div>
        </div>
      </Link>

      {/* Visibility toggle — admin only, master papers only, sits left of trash can */}
      {isAdmin && !paper.paperType && (
        <button
          onClick={(e) => { e.preventDefault(); if (!togglingVisible) toggleVisible(); }}
          disabled={togglingVisible}
          title={visible ? "Click to hide from parents" : "Click to make visible to parents"}
          className={`absolute top-3 right-14 p-2 rounded-full transition-colors z-10 disabled:opacity-50 ${
            visible
              ? "text-green-500 hover:bg-green-50"
              : "text-slate-300 hover:text-slate-500 hover:bg-slate-100"
          }`}
        >
          {visible ? (
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>
            </svg>
          )}
        </button>
      )}

      {/* Generate Test Quiz — admin only, clean extracted papers */}
      {isAdmin && paper.cleanExtracted && !paper.paperType && (
        <button
          onClick={async (e) => {
            e.preventDefault();
            if (generatingTestQuiz) return;
            setGeneratingTestQuiz(true);
            try {
              const res = await fetch("/api/daily-quiz", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ userId, sourcePaperId: paper.id }),
              });
              const data = await res.json();
              if (res.ok && data.id) {
                window.open(`/quiz/${data.id}?userId=${userId}`, "_blank");
              } else {
                alert(data.error || "Failed to generate test quiz");
              }
            } catch { alert("Something went wrong"); }
            finally { setGeneratingTestQuiz(false); }
          }}
          disabled={generatingTestQuiz}
          className="absolute top-3 right-28 p-2 rounded-full text-purple-500 hover:bg-purple-50 transition-colors z-10 disabled:opacity-50"
          title="Generate Test Quiz"
        >
          <span className="material-symbols-outlined text-lg">{generatingTestQuiz ? "hourglass_top" : "science"}</span>
        </button>
      )}

      {/* Tag Syllabus button — Math papers, parents only, not already tagged */}
      {isAdmin && isTaggablePaper && !isExtracting && !extractionFailed && !paper.syllabusTagged && (
        <button
          onClick={(e) => {
            e.preventDefault();
            if (!taggingSyllabus && !syllabusTagged) tagSyllabus();
          }}
          disabled={taggingSyllabus || syllabusTagged}
          className="absolute bottom-3 right-3 text-[11px] font-medium px-2.5 py-1 rounded-lg border border-dashed border-purple-300 text-purple-500 hover:border-purple-400 hover:text-purple-700 hover:bg-purple-50 disabled:opacity-50 transition-colors z-10"
        >
          {taggingSyllabus ? "Tagging..." : syllabusTagged ? "Tagged" : "Tag Syllabus"}
        </button>
      )}

      {/* Delete button — only for parents/owners */}
      {onDelete ? (
        <button
          onClick={(e) => {
            e.preventDefault();
            setShowConfirm(true);
          }}
          className="absolute top-3 right-3 p-2 rounded-full text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors z-10"
          aria-label="Delete exam paper"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 6h18" />
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
          </svg>
        </button>
      ) : null}

      {/* Delete confirmation modal */}
      {showConfirm && onDelete ? (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-xl">
            <h3 className="font-semibold text-lg mb-2">Delete Exam Paper?</h3>
            <p className="text-slate-600 text-sm mb-4">
              Are you sure you want to delete &quot;{paper.title}&quot;? This
              cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowConfirm(false)}
                className="flex-1 py-2.5 px-4 rounded-xl border border-slate-200 text-slate-600 font-medium hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  onDelete(paper.id);
                  setShowConfirm(false);
                }}
                className="flex-1 py-2.5 px-4 rounded-xl bg-red-500 text-white font-medium hover:bg-red-600"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
