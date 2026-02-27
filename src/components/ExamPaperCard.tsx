"use client";

import Link from "next/link";
import { ExamPaperSummary } from "@/types";
import { useState } from "react";

export default function ExamPaperCard({
  paper,
  userId,
  onDelete,
}: {
  paper: ExamPaperSummary;
  userId: string;
  onDelete: (id: string) => void;
}) {
  const [showConfirm, setShowConfirm] = useState(false);

  return (
    <div className="relative">
      <Link
        href={`/exam/${paper.id}?userId=${userId}`}
        className="block rounded-2xl border-2 border-slate-100 bg-white p-4 shadow-sm transition-all active:scale-[0.98] hover:border-primary-200 hover:shadow-md"
      >
        <div className="flex items-start justify-between">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-lg text-slate-800 truncate">
              {paper.title}
            </h3>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {paper.subject && (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
                  {paper.subject}
                </span>
              )}
              {paper.level && (
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                  {paper.level}
                </span>
              )}
              <span className="text-xs text-slate-400">
                {paper.questionCount} questions
              </span>
            </div>
            {paper.school && (
              <p className="text-xs text-slate-400 mt-1 truncate">
                {paper.school}
              </p>
            )}
          </div>
        </div>
      </Link>

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

      {showConfirm && (
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
      )}
    </div>
  );
}
