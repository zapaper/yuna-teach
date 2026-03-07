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

interface TimelineEntry {
  title: string;
  date: string;
  topics: Record<string, number>;
}

interface ProgressData {
  student: { id: string; name: string } | null;
  subjects: Record<string, SubjectData>;
  timeline: Record<string, TimelineEntry[]>;
}

const TOPIC_COLORS = [
  "#6366f1", // indigo
  "#f59e0b", // amber
  "#10b981", // emerald
  "#ef4444", // red
  "#8b5cf6", // violet
  "#06b6d4", // cyan
  "#f97316", // orange
  "#ec4899", // pink
  "#14b8a6", // teal
  "#84cc16", // lime
  "#a855f7", // purple
  "#0ea5e9", // sky
];

function ProgressContent({ studentId }: { studentId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const parentId = searchParams.get("parentId") ?? "";

  const [data, setData] = useState<ProgressData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeSubject, setActiveSubject] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [view, setView] = useState<"topic" | "time">("topic");

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
      router.push(`/home/${parentId}?t=${Date.now()}`);
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
  const currentTimeline = activeSubject && data?.timeline[activeSubject];

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

      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-bold text-slate-800">
          {data?.student?.name || "Student"}&apos;s Progress
        </h1>
        {/* Topic / Time toggle */}
        {subjects.length > 0 && (
          <div className="flex bg-slate-100 rounded-lg p-0.5">
            <button
              onClick={() => setView("topic")}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                view === "topic"
                  ? "bg-white text-slate-800 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              Topic
            </button>
            <button
              onClick={() => setView("time")}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                view === "time"
                  ? "bg-white text-slate-800 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              Time
            </button>
          </div>
        )}
      </div>
      <p className="text-sm text-slate-400 mb-5">
        {view === "topic"
          ? "Performance by topic across all marked exams"
          : "Score trends over time by topic"}
      </p>

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

          {currentSubject && view === "topic" && (
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

          {view === "time" && (
            <TimelineChart entries={currentTimeline || []} />
          )}
        </>
      )}
    </div>
  );
}

function TimelineChart({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-slate-400">No exam data to chart</p>
      </div>
    );
  }

  // Collect all topics across all exams
  const allTopics = Array.from(
    new Set(entries.flatMap((e) => Object.keys(e.topics)))
  ).sort();

  const topicColorMap: Record<string, string> = {};
  allTopics.forEach((t, i) => {
    topicColorMap[t] = TOPIC_COLORS[i % TOPIC_COLORS.length];
  });

  // Chart dimensions
  const W = 600;
  const H = 300;
  const padL = 40;
  const padR = 20;
  const padT = 16;
  const padB = 60;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const n = entries.length;
  const xStep = n > 1 ? chartW / (n - 1) : 0;

  function x(i: number) {
    return padL + (n > 1 ? i * xStep : chartW / 2);
  }
  function y(pct: number) {
    return padT + chartH - (pct / 100) * chartH;
  }

  // Format date label
  function dateLabel(iso: string) {
    if (!iso) return "";
    const d = new Date(iso);
    return `${d.getDate()}/${d.getMonth() + 1}`;
  }

  return (
    <div>
      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 mb-4">
        {allTopics.map((topic) => (
          <div key={topic} className="flex items-center gap-1.5">
            <div
              className="w-3 h-3 rounded-full shrink-0"
              style={{ backgroundColor: topicColorMap[topic] }}
            />
            <span className="text-[11px] text-slate-600">{topic}</span>
          </div>
        ))}
      </div>

      {/* SVG Chart */}
      <div className="rounded-2xl border-2 border-slate-100 bg-white p-3 shadow-sm overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 320 }}>
          {/* Y-axis grid lines and labels */}
          {[0, 25, 50, 75, 100].map((pct) => (
            <g key={pct}>
              <line
                x1={padL}
                x2={W - padR}
                y1={y(pct)}
                y2={y(pct)}
                stroke="#e2e8f0"
                strokeWidth={pct === 0 ? 1.5 : 0.75}
                strokeDasharray={pct === 0 ? undefined : "4 4"}
              />
              <text
                x={padL - 6}
                y={y(pct) + 4}
                textAnchor="end"
                className="fill-slate-400"
                fontSize={10}
              >
                {pct}%
              </text>
            </g>
          ))}

          {/* X-axis labels */}
          {entries.map((e, i) => (
            <text
              key={i}
              x={x(i)}
              y={H - padB + 16}
              textAnchor="middle"
              className="fill-slate-400"
              fontSize={9}
            >
              {dateLabel(e.date)}
            </text>
          ))}

          {/* Exam title labels (rotated, below date) */}
          {entries.map((e, i) => {
            const label = e.title.length > 18 ? e.title.slice(0, 16) + "..." : e.title;
            return (
              <text
                key={`t-${i}`}
                x={x(i)}
                y={H - padB + 30}
                textAnchor="middle"
                className="fill-slate-300"
                fontSize={8}
              >
                {label}
              </text>
            );
          })}

          {/* Lines + dots per topic */}
          {allTopics.map((topic) => {
            const color = topicColorMap[topic];
            // Build points for exams that have this topic
            const points: { idx: number; pct: number }[] = [];
            entries.forEach((e, i) => {
              if (e.topics[topic] !== undefined) {
                points.push({ idx: i, pct: e.topics[topic] });
              }
            });

            if (points.length === 0) return null;

            const pathD = points
              .map((p, j) => `${j === 0 ? "M" : "L"} ${x(p.idx)} ${y(p.pct)}`)
              .join(" ");

            return (
              <g key={topic}>
                {points.length > 1 && (
                  <path
                    d={pathD}
                    fill="none"
                    stroke={color}
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )}
                {points.map((p) => (
                  <circle
                    key={p.idx}
                    cx={x(p.idx)}
                    cy={y(p.pct)}
                    r={4}
                    fill={color}
                    stroke="white"
                    strokeWidth={2}
                  />
                ))}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
