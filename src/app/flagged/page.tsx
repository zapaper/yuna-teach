"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

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
}

export default function FlaggedPage() {
  const router = useRouter();
  const [items, setItems] = useState<FlaggedItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/flagged")
      .then((r) => r.json())
      .then((data) => setItems(data))
      .finally(() => setLoading(false));
  }, []);

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
            <button
              key={item.questionId}
              onClick={() => {
                const examId = item.cloneId ?? item.paperId;
                router.push(`/exam/${examId}/overview`);
              }}
              className="w-full text-left bg-white rounded-xl border border-slate-100 shadow-sm overflow-hidden hover:border-primary-200 transition-colors"
            >
              {/* Top row: question identity */}
              <div className="px-4 py-2.5 border-b border-slate-50">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-bold text-slate-800">
                    Q{item.questionNum}
                  </span>
                  <div className="flex items-center gap-1.5">
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
                  </div>
                </div>
                <p className="text-xs text-slate-400">
                  {[item.subject, item.level].filter(Boolean).join(" · ")}
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
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
