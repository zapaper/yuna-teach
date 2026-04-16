"use client";

import { useEffect, useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import AdminNav from "@/components/AdminNav";

interface FlaggedItem {
  questionId: string;
  questionNum: string;
  answer: string | null;
  marksAwarded: number | null;
  marksAvailable: number | null;
  markingNotes: string | null;
  studentAnswer: string | null;
  flaggedAt: string | null;
  paperId: string;
  cloneId: string | null;
  paperType: string | null;
  paperTitle: string;
  subject: string | null;
  level: string | null;
  school: string | null;
  year: string | null;
  examType: string | null;
  transcribedStem: string | null;
  syllabusTopic: string | null;
  studentName: string | null;
  parentName: string | null;
  flaggedBy: { id: string; name: string; role: string } | null;
  sourcePaperId: string | null;
  sourceQuestionId: string | null;
  sourceQuestionNum: string | null;
  sourceLabel: string | null;
}

export default function FlaggedPage() {
  return (
    <Suspense>
      <FlaggedContent />
    </Suspense>
  );
}

function FlaggedContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";

  const [items, setItems] = useState<FlaggedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState<Record<string, string>>({});
  const [replying, setReplying] = useState<string | null>(null);
  const [replySent, setReplySent] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetch("/api/flagged")
      .then((r) => r.json())
      .then((data) => setItems(data))
      .finally(() => setLoading(false));
  }, []);

  async function handleDelete(item: FlaggedItem, e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm("Remove this flag?")) return;
    setDeleting(item.questionId);
    try {
      const examId = item.cloneId ?? item.paperId;
      await fetch(`/api/exam/${examId}/flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: item.questionId }),
      });
      setItems(prev => prev.filter(i => i.questionId !== item.questionId));
    } finally {
      setDeleting(null);
    }
  }

  async function handleReply(item: FlaggedItem, e: React.MouseEvent) {
    e.stopPropagation();
    const message = replyDraft[item.questionId]?.trim();
    if (!message) return;
    setReplying(item.questionId);
    try {
      await fetch(`/api/exam/questions/${item.questionId}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      setReplySent(prev => ({ ...prev, [item.questionId]: true }));
      setReplyDraft(prev => ({ ...prev, [item.questionId]: "" }));
    } finally {
      setReplying(null);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary-200 border-t-primary-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24 lg:pb-0">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3">
        <div>
          <h1 className="text-lg font-bold text-slate-800">Flagged Questions</h1>
          <p className="text-xs text-slate-400">{items.length} flagged</p>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-slate-400">No flagged questions</p>
        </div>
      ) : (
        <div className="px-4 py-3 space-y-3">
          {items.map((item) => (
            <div
              key={item.questionId}
              className="w-full text-left bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden"
            >
              {/* Top row: question identity */}
              <div className="px-4 py-2.5 border-b border-slate-50">
                <div className="flex items-center justify-between mb-1">
                  <button
                    onClick={() => {
                      const examId = item.cloneId ?? item.paperId;
                      const isQuizOrFocused = item.paperType === "quiz" || item.paperType === "focused";
                      const path = isQuizOrFocused ? `/exam/${examId}/review` : `/exam/${examId}/overview`;
                      window.open(`${path}?userId=${userId}`, "_blank");
                    }}
                    className="text-sm font-bold text-primary-600 hover:text-primary-800 underline underline-offset-2"
                  >
                    Q{item.questionNum} ↗
                  </button>
                  <div className="flex items-center gap-1.5 flex-wrap justify-end">
                    <button
                      onClick={(e) => handleDelete(item, e)}
                      disabled={deleting === item.questionId}
                      className="p-2.5 rounded-xl text-red-400 hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40 min-w-[40px] min-h-[40px] flex items-center justify-center"
                      title="Remove flag"
                    >
                      {deleting === item.questionId ? (
                        <span className="animate-spin rounded-full h-5 w-5 border-2 border-red-200 border-t-red-500 inline-block" />
                      ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
                          fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
                          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                      )}
                    </button>
                    {(item.paperType === "quiz" || item.paperType === "focused") && (
                      <button
                        onClick={() => {
                          const examId = item.cloneId ?? item.paperId;
                          window.open(`/exam/${examId}/review?userId=${userId}`, "_blank");
                        }}
                        className="text-[10px] font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 px-1.5 py-0.5 rounded underline underline-offset-2"
                        title="Open quiz review"
                      >
                        {item.paperType === "focused" ? "Focused ↗" : "Quiz ↗"}
                      </button>
                    )}
                    {item.year && (
                      <span className="text-[10px] font-medium text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">
                        {item.year}
                      </span>
                    )}
                    {item.examType && (
                      <span className="text-[10px] font-medium text-violet-600 bg-violet-50 px-1.5 py-0.5 rounded">
                        {item.examType}
                      </span>
                    )}
                    {item.school && (
                      <span className="text-[10px] font-medium text-teal-600 bg-teal-50 px-1.5 py-0.5 rounded">
                        {item.school}
                      </span>
                    )}
                    {/* Fallback: show raw sourceLabel if individual fields are still missing */}
                    {!item.school && !item.year && !item.examType && item.sourceLabel && (
                      <span className="text-[10px] font-medium text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded">
                        {item.sourceLabel}
                      </span>
                    )}
                  </div>
                </div>
                <p className="text-xs text-slate-600 font-medium truncate">{item.paperTitle}</p>
                <p className="text-xs text-slate-400">
                  {[item.subject, item.level ? (/^\d+$/.test(item.level) ? `Primary ${item.level}` : item.level) : null].filter(Boolean).join(" · ")}
                  {item.studentName ? ` · ${item.studentName}` : ""}
                </p>
                {item.flaggedBy && (
                  <p className="text-[10px] text-amber-600 mt-0.5 font-semibold">Flagged by: {item.flaggedBy.name} ({item.flaggedBy.role.toLowerCase()})</p>
                )}
                {item.syllabusTopic && (
                  <p className="text-[10px] text-slate-400 mt-0.5">Topic: {item.syllabusTopic}</p>
                )}
              </div>

              {/* Content */}
              <div className="px-4 py-2.5 space-y-1.5">
                {/* Question text */}
                {item.transcribedStem && (
                  <p className="text-xs text-slate-600 line-clamp-2">{item.transcribedStem}</p>
                )}

                {/* Marks */}
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-slate-400">Marks:</span>
                  <span className={`font-semibold ${
                    item.marksAwarded === null ? "text-amber-500" :
                    item.marksAwarded >= (item.marksAvailable ?? 0) ? "text-green-600" :
                    item.marksAwarded === 0 ? "text-red-500" : "text-amber-600"
                  }`}>
                    {item.marksAwarded === null ? "Not marked" : `${item.marksAwarded} / ${item.marksAvailable ?? "?"}`}
                  </span>
                </div>

                {/* Expected answer */}
                {item.answer && (
                  <div className="text-xs">
                    <span className="text-slate-400">Expected: </span>
                    <span className="text-slate-600">{item.answer.length > 80 ? item.answer.slice(0, 80) + "..." : item.answer}</span>
                  </div>
                )}

                {/* Student answer (from marking notes) */}
                {item.studentAnswer && (
                  <div className="text-xs">
                    <span className="text-slate-400">Student wrote: </span>
                    <span className="text-slate-700 font-medium">{item.studentAnswer}</span>
                  </div>
                )}

                {/* Marking notes */}
                {item.markingNotes && (
                  <div className="text-xs">
                    <span className="text-slate-400">Notes: </span>
                    <span className="text-slate-500">{item.markingNotes.length > 100 ? item.markingNotes.slice(0, 100) + "..." : item.markingNotes}</span>
                  </div>
                )}

                {/* Flagged date */}
                {item.flaggedAt && (
                  <p className="text-[10px] text-slate-300">
                    Flagged {new Date(item.flaggedAt).toLocaleDateString()}
                  </p>
                )}

                {/* Source question link — for editing Q or A */}
                {item.sourcePaperId && (
                  <div className="pt-1">
                    <Link
                      href={`/exam/${item.sourcePaperId}/transcribe-edit?userId=${userId}${item.sourceQuestionId ? `#q-${item.sourceQuestionId}` : ""}`}
                      target="_blank"
                      rel="noopener"
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1 text-[10px] font-medium text-primary-600 bg-primary-50 px-2 py-1 rounded hover:bg-primary-100 transition-colors"
                    >
                      <span className="material-symbols-outlined text-[10px]">edit</span>
                      Clean Edit Q{item.sourceQuestionNum} ↗
                    </Link>
                  </div>
                )}

                {/* Admin reply box */}
                {userId && (
                  <div className="pt-2 border-t border-slate-50" onClick={(e) => e.stopPropagation()}>
                    {replySent[item.questionId] ? (
                      <p className="text-[11px] text-green-600 font-medium">Reply sent ✓</p>
                    ) : (
                      <div className="flex gap-2 items-start">
                        <textarea
                          value={replyDraft[item.questionId] ?? ""}
                          onChange={(e) => setReplyDraft(prev => ({ ...prev, [item.questionId]: e.target.value }))}
                          placeholder="Reply to student (e.g. Answer key was wrong — amended. Thank you!)"
                          rows={2}
                          className="flex-1 text-xs rounded-lg border border-slate-200 px-2.5 py-1.5 resize-none focus:outline-none focus:border-primary-400 placeholder:text-slate-300"
                        />
                        <button
                          onClick={(e) => handleReply(item, e)}
                          disabled={!replyDraft[item.questionId]?.trim() || replying === item.questionId}
                          className="shrink-0 text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-primary-500 text-white hover:bg-primary-600 disabled:opacity-40 transition-colors"
                        >
                          {replying === item.questionId ? "…" : "Send"}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}
