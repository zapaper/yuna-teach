"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

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
  sourcePaperId: string | null;
  sourceQuestionNum: string | null;
  sourceLabel: string | null;
}

export default function FlaggedPage() {
  const router = useRouter();
  const [items, setItems] = useState<FlaggedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);

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

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary-200 border-t-primary-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3">
        <button onClick={() => router.back()} className="p-1.5 rounded-lg hover:bg-slate-100">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
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
              onClick={() => {
                const examId = item.cloneId ?? item.paperId;
                const isQuizOrFocused = item.paperType === "quiz" || item.paperType === "focused";
                router.push(isQuizOrFocused ? `/exam/${examId}/review` : `/exam/${examId}/overview`);
              }}
              className="w-full text-left bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden hover:border-primary-200 transition-colors cursor-pointer"
            >
              {/* Top row: question identity */}
              <div className="px-4 py-2.5 border-b border-slate-50">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-bold text-slate-800">
                    Q{item.questionNum}
                  </span>
                  <div className="flex items-center gap-1.5 flex-wrap justify-end">
                    <button
                      onClick={(e) => handleDelete(item, e)}
                      disabled={deleting === item.questionId}
                      className="p-1 rounded-lg text-red-400 hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40"
                      title="Remove flag"
                    >
                      {deleting === item.questionId ? (
                        <span className="animate-spin rounded-full h-4 w-4 border-2 border-red-200 border-t-red-500 inline-block" />
                      ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"
                          fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
                          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                      )}
                    </button>
                    {(item.paperType === "quiz" || item.paperType === "focused") && (
                      <span className="text-[10px] font-medium text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">
                        {item.paperType === "focused" ? "Focused" : "Quiz"}
                      </span>
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
                      href={`/exam/${item.sourcePaperId}?highlight=${item.sourceQuestionNum ?? ""}`}
                      onClick={(e) => e.stopPropagation()}
                      className="inline-flex items-center gap-1 text-[10px] font-medium text-primary-600 bg-primary-50 px-2 py-1 rounded hover:bg-primary-100 transition-colors"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24"
                        fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                      </svg>
                      Edit source Q{item.sourceQuestionNum} in original paper
                    </Link>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
