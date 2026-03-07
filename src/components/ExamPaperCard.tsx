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

  // Parents: if extraction just finished (ready), go to edit for review; otherwise overview
  // Students: review (if released) or practice; focused tests go to focused page
  const examHref = isExtracting
    ? "#"
    : userRole === "PARENT"
    ? isFocused
      ? `/exam/${paper.id}/overview?userId=${userId}`
      : `/exam/${paper.id}/overview?userId=${userId}`
    : isFocused
    ? paper.markingStatus === "released"
      ? `/exam/${paper.id}/review?userId=${userId}`
      : `/exam/${paper.id}/focused?userId=${userId}`
    : paper.markingStatus === "released"
    ? `/exam/${paper.id}/review?userId=${userId}`
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

  return (
    <div className="relative">
      <Link
        href={examHref}
        className="block rounded-2xl border-2 border-slate-100 bg-white p-4 shadow-sm transition-all active:scale-[0.98] hover:border-primary-200 hover:shadow-md"
      >
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-lg text-slate-800 truncate">
              {paper.title}
            </h3>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {isFocused ? (
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
              {userRole !== "PARENT" ? (
                paper.markingStatus === "released" ? (
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">
                    Marked{paper.score != null ? ` ${paper.score}${paper.totalMarks ? `/${paper.totalMarks}` : ""}` : ""}
                  </span>
                ) : paper.completedAt ? (
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                    Completed
                  </span>
                ) : null
              ) : null}
            </div>
            {paper.school ? (
              <p className="text-xs text-slate-400 mt-1 truncate">
                {paper.school}
              </p>
            ) : null}
          </div>
        </div>
      </Link>

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
