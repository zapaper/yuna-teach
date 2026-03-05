"use client";

import { useEffect, useState, use } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

export default function ProgressPage({
  params,
}: {
  params: Promise<{ studentId: string }>;
}) {
  const { studentId } = use(params);
  return (
    <Suspense>
      <ProgressContent studentId={studentId} />
    </Suspense>
  );
}

interface TopicData {
  earned: number;
  available: number;
  count: number;
}

interface SubjectData {
  examCount: number;
  topics: Record<string, TopicData>;
}

interface ProgressData {
  student: { id: string; name: string } | null;
  subjects: Record<string, SubjectData>;
}

function ProgressContent({ studentId }: { studentId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const parentId = searchParams.get("parentId") ?? "";

  const [data, setData] = useState<ProgressData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeSubject, setActiveSubject] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(
          `/api/student-progress?parentId=${parentId}&studentId=${studentId}`
        );
        if (!res.ok) throw new Error("Failed");
        const json: ProgressData = await res.json();
        setData(json);
        const subjects = Object.keys(json.subjects);
        if (subjects.length > 0) setActiveSubject(subjects[0]);
      } catch {
        setData(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [parentId, studentId]);

  async function createFocusedTest(subject: string, topic: string) {
    setCreating(topic);
    try {
      const res = await fetch("/api/focused-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentId, studentId, subject, topic }),
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || "Failed to create test");
        return;
      }
      const { id } = await res.json();
      router.push(`/exam/${id}/focused?userId=${studentId}`);
    } finally {
      setCreating(null);
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-24">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-200 border-t-primary-500" />
      </div>
    );
  }

  const subjects = data ? Object.keys(data.subjects) : [];
  const currentSubject = activeSubject && data?.subjects[activeSubject];

  return (
    <div className="p-6 pb-24 max-w-2xl mx-auto">
      {/* Back */}
      <button
        onClick={() => router.push(`/home/${parentId}`)}
        className="flex items-center gap-1 text-slate-500 mb-6 hover:text-slate-700"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m15 18-6-6 6-6" />
        </svg>
        Home
      </button>

      <h1 className="text-xl font-bold text-slate-800 mb-1">
        {data?.student?.name || "Student"}&apos;s Progress
      </h1>
      <p className="text-sm text-slate-400 mb-5">Performance by topic across all marked exams</p>

      {subjects.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-slate-400">No marked exams yet</p>
          <p className="text-xs text-slate-300 mt-1">Assign and mark exams to see progress here</p>
        </div>
      ) : (
        <>
          {/* Subject tabs */}
          <div className="flex gap-2 mb-5 overflow-x-auto pb-1">
            {subjects.map((subject) => (
              <button
                key={subject}
                onClick={() => setActiveSubject(subject)}
                className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
                  activeSubject === subject
                    ? "bg-primary-500 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {subject}
              </button>
            ))}
          </div>

          {currentSubject && (
            <>
              <p className="text-sm text-slate-500 mb-4">
                {currentSubject.examCount} exam{currentSubject.examCount !== 1 ? "s" : ""} marked
              </p>

              <div className="space-y-3">
                {Object.entries(currentSubject.topics)
                  .filter(([topic]) => topic !== "Untagged")
                  .sort(([, a], [, b]) => {
                    const pctA = a.available > 0 ? a.earned / a.available : 0;
                    const pctB = b.available > 0 ? b.earned / b.available : 0;
                    return pctA - pctB; // weakest first
                  })
                  .map(([topic, td]) => {
                    const pct = td.available > 0 ? Math.round((td.earned / td.available) * 100) : 0;
                    return (
                      <div
                        key={topic}
                        className="rounded-2xl border-2 border-slate-100 bg-white p-4 shadow-sm"
                      >
                        <div className="flex items-center justify-between mb-2">
                          <h3 className="font-semibold text-slate-800 text-sm">{topic}</h3>
                          <span className="text-xs text-slate-500 tabular-nums">
                            {td.earned} / {td.available} ({pct}%)
                          </span>
                        </div>
                        <div className="h-2 bg-slate-100 rounded-full overflow-hidden mb-3">
                          <div
                            className={`h-full rounded-full transition-all ${
                              pct >= 70 ? "bg-green-500" : pct >= 40 ? "bg-amber-500" : "bg-red-400"
                            }`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] text-slate-400">{td.count} questions</span>
                          <button
                            onClick={() => createFocusedTest(activeSubject!, topic)}
                            disabled={creating === topic}
                            className="text-xs font-medium px-3 py-1.5 rounded-xl border border-primary-200 text-primary-600 hover:bg-primary-50 disabled:opacity-50 transition-colors"
                          >
                            {creating === topic ? "Creating..." : "Create Focused Test"}
                          </button>
                        </div>
                      </div>
                    );
                  })}

                {/* Untagged section if exists */}
                {currentSubject.topics["Untagged"] && (
                  <div className="rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50 p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-slate-500">Untagged questions</span>
                      <span className="text-xs text-slate-400 tabular-nums">
                        {currentSubject.topics["Untagged"].earned} / {currentSubject.topics["Untagged"].available}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
