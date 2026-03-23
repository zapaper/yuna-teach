"use client";

import { useEffect, useState, useRef, useCallback, use } from "react";
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
  "#6366f1", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#06b6d4",
  "#f97316", "#ec4899", "#14b8a6", "#84cc16", "#a855f7", "#0ea5e9",
];

/** Generate a structured summary for ONE subject */
function generateSubjectSummary(
  studentName: string,
  subject: string,
  sd: SubjectData
): { headline: string; strong: string | null; gaps: string | null } {
  const topicEntries = Object.entries(sd.topics).filter(([t]) => t !== "Untagged");
  if (topicEntries.length === 0) return { headline: "No data yet.", strong: null, gaps: null };

  const totalEarned = topicEntries.reduce((s, [, t]) => s + t.earned, 0);
  const totalAvailable = topicEntries.reduce((s, [, t]) => s + t.available, 0);
  const overallPct = totalAvailable > 0 ? Math.round((totalEarned / totalAvailable) * 100) : 0;

  const weak = topicEntries
    .filter(([, t]) => t.available > 0 && (t.earned / t.available) < 0.6)
    .sort(([, a], [, b]) => (a.earned / a.available) - (b.earned / b.available))
    .map(([name]) => name);
  const strong = topicEntries
    .filter(([, t]) => t.available > 0 && (t.earned / t.available) >= 0.8)
    .map(([name]) => name);

  const headline = `${studentName}'s ${subject}: Overall ${overallPct}% across ${sd.examCount} exam${sd.examCount !== 1 ? "s" : ""}.`;
  return {
    headline,
    strong: strong.length > 0 ? strong.slice(0, 4).join(", ") : null,
    gaps: weak.length > 0 ? weak.slice(0, 4).join(", ") : null,
  };
}

function ProgressContent({ studentId }: { studentId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const parentId = searchParams.get("parentId") ?? "";

  const [data, setData] = useState<ProgressData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeSubject, setActiveSubject] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [view, setView] = useState<"topic" | "time">("topic");
  const [sharing, setSharing] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);

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

  const handleShare = useCallback(async () => {
    if (!reportRef.current || !data) return;
    setSharing(true);
    try {
      // Dynamically import html2canvas
      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(reportRef.current, {
        scale: 2,
        backgroundColor: "#ffffff",
        useCORS: true,
        width: reportRef.current.scrollWidth,
        height: reportRef.current.scrollHeight,
      });
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((b) => resolve(b!), "image/png")
      );
      const file = new File([blob], `${data.student?.name ?? "student"}-progress.png`, { type: "image/png" });

      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({
          title: `${data.student?.name ?? "Student"}'s Learning Progress`,
          files: [file],
        });
      } else {
        // Fallback: download
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        console.error("Share failed:", e);
      }
    } finally {
      setSharing(false);
    }
  }, [data]);

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
  const subjectSummary = (activeSubject && currentSubject && data)
    ? generateSubjectSummary(data.student?.name ?? "Student", activeSubject, currentSubject)
    : null;

  return (
    <div className="p-6 pb-24 max-w-2xl mx-auto">
      {/* Back */}
      <button
        onClick={() => router.push(`/home/${parentId}`)}
        className="flex items-center gap-1 text-slate-500 mb-4 hover:text-slate-700"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m15 18-6-6 6-6" />
        </svg>
        Home
      </button>

      {/* Header */}
      <div className="mb-5">
        <div className="rounded-t-2xl bg-gradient-to-r from-primary-500 to-primary-700 text-white px-5 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">{data?.student?.name || "Student"}</h1>
            <p className="text-primary-100 text-sm mt-0.5">Learning Progress Report</p>
          </div>
          <button
            onClick={handleShare}
            disabled={sharing || subjects.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/20 hover:bg-white/30 text-white text-xs font-medium transition-colors disabled:opacity-50"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
              <polyline points="16 6 12 2 8 6" />
              <line x1="12" y1="2" x2="12" y2="15" />
            </svg>
            {sharing ? "..." : "Share"}
          </button>
        </div>
        {subjectSummary && (
          <div className="rounded-b-2xl border border-t-0 border-slate-200 bg-white px-5 py-4">
            <p className="text-sm text-slate-700 leading-relaxed">{subjectSummary.headline}</p>
            {subjectSummary.strong && (
              <p className="text-sm text-slate-700 leading-relaxed mt-2">
                <strong className="text-green-700">Strong in:</strong> {subjectSummary.strong}
              </p>
            )}
            {subjectSummary.gaps && (
              <p className="text-sm text-slate-700 leading-relaxed mt-1">
                <strong className="text-red-600">Gaps in:</strong> {subjectSummary.gaps}
              </p>
            )}
            {!subjectSummary.gaps && !subjectSummary.strong && (
              <p className="text-sm text-slate-400 mt-2">Not enough data to identify strengths or gaps yet.</p>
            )}
          </div>
        )}
      </div>

      {/* View toggle */}
      {subjects.length > 0 && (
        <div className="flex items-center justify-between mb-4">
          <div className="flex gap-2 overflow-x-auto pb-1">
            {subjects.map((subject) => (
              <button
                key={subject}
                onClick={() => setActiveSubject(subject)}
                className={`px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
                  activeSubject === subject
                    ? "bg-primary-500 text-white shadow-md"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {subject}
              </button>
            ))}
          </div>
          <div className="flex bg-slate-100 rounded-lg p-0.5 shrink-0 ml-2">
            <button
              onClick={() => setView("topic")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                view === "topic"
                  ? "bg-white text-slate-800 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              Topic
            </button>
            <button
              onClick={() => setView("time")}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                view === "time"
                  ? "bg-white text-slate-800 shadow-sm"
                  : "text-slate-500 hover:text-slate-700"
              }`}
            >
              Time
            </button>
          </div>
        </div>
      )}

      {subjects.length === 0 ? (
        <div className="text-center py-12 rounded-2xl bg-slate-50 border-2 border-dashed border-slate-200">
          <p className="text-slate-400 font-medium">No marked exams yet</p>
          <p className="text-xs text-slate-300 mt-1">Assign and mark exams to see progress here</p>
        </div>
      ) : (
        <>
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
                    const barColor = pct >= 70 ? "bg-green-500" : pct >= 40 ? "bg-amber-500" : "bg-red-400";
                    const badgeColor = pct >= 70 ? "text-green-700 bg-green-50" : pct >= 40 ? "text-amber-700 bg-amber-50" : "text-red-700 bg-red-50";
                    return (
                      <div
                        key={topic}
                        className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm hover:shadow-md transition-shadow"
                      >
                        <div className="flex items-center justify-between mb-2">
                          <h3 className="font-semibold text-slate-800">{topic}</h3>
                          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${badgeColor}`}>
                            {pct}%
                          </span>
                        </div>
                        <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden mb-3">
                          <div
                            className={`h-full rounded-full transition-all ${barColor}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-slate-400">
                            {td.earned}/{td.available} marks &middot; {td.count} questions
                          </span>
                          <button
                            onClick={() => createFocusedTest(activeSubject!, topic)}
                            disabled={creating === topic}
                            className="text-xs font-medium px-3 py-1.5 rounded-xl bg-primary-50 text-primary-600 hover:bg-primary-100 disabled:opacity-50 transition-colors"
                          >
                            {creating === topic ? "Creating..." : "Focused Test"}
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

      {/* ── Hidden shareable report (off-screen, rendered for html2canvas) ── */}
      {data && activeSubject && currentSubject && (
        <div style={{ position: "absolute", left: "-9999px", top: 0 }}>
          <ShareableReport
            ref={reportRef}
            data={data}
            subject={activeSubject}
            subjectData={currentSubject}
            summary={subjectSummary!}
          />
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Shareable Report — rendered off-screen, captured by html2canvas           */
/* ═══════════════════════════════════════════════════════════════════════════ */

import { forwardRef } from "react";

const ShareableReport = forwardRef<
  HTMLDivElement,
  { data: ProgressData; subject: string; subjectData: SubjectData; summary: { headline: string; strong: string | null; gaps: string | null } }
>(
  function ShareableReport({ data, subject, subjectData, summary }, ref) {
    const topicEntries = Object.entries(subjectData.topics)
      .filter(([t]) => t !== "Untagged")
      .sort(([, a], [, b]) => (a.available > 0 ? a.earned / a.available : 0) - (b.available > 0 ? b.earned / b.available : 0));

    return (
      <div
        ref={ref}
        style={{
          width: 1200,
          padding: 48,
          fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
          backgroundColor: "#ffffff",
          color: "#1e293b",
        }}
      >
        {/* Header with branding */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32, paddingBottom: 24, borderBottom: "3px solid #3b82f6" }}>
          <div>
            <div style={{ fontSize: 24, fontWeight: 700, color: "#1e293b" }}>{data.student?.name}</div>
            <div style={{ fontSize: 14, color: "#64748b", marginTop: 2 }}>{subject}</div>
            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>Generated {new Date().toLocaleDateString("en-SG", { day: "numeric", month: "long", year: "numeric" })}</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 32, fontWeight: 800, color: "#3b82f6" }}>MarkForYou.com</div>
            <div style={{ fontSize: 14, color: "#94a3b8", marginTop: 4 }}>AI-Powered Learning Progress Report</div>
          </div>
        </div>

        {/* Summary */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 15, color: "#334155", lineHeight: 1.7 }}>{summary.headline}</div>
          {summary.strong && (
            <div style={{ fontSize: 15, color: "#334155", lineHeight: 1.7, marginTop: 8 }}>
              <span style={{ fontWeight: 700, color: "#15803d" }}>Strong in: </span>{summary.strong}
            </div>
          )}
          {summary.gaps && (
            <div style={{ fontSize: 15, color: "#334155", lineHeight: 1.7, marginTop: 4 }}>
              <span style={{ fontWeight: 700, color: "#dc2626" }}>Gaps in: </span>{summary.gaps}
            </div>
          )}
        </div>

        {/* Topic cards */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 32 }}>
          {topicEntries.map(([topic, td]) => {
            const pct = td.available > 0 ? Math.round((td.earned / td.available) * 100) : 0;
            const barColor = pct >= 70 ? "#22c55e" : pct >= 40 ? "#f59e0b" : "#ef4444";
            const badgeBg = pct >= 70 ? "#f0fdf4" : pct >= 40 ? "#fffbeb" : "#fef2f2";
            const badgeColor = pct >= 70 ? "#15803d" : pct >= 40 ? "#b45309" : "#dc2626";
            return (
              <div key={topic} style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: 16, background: "#ffffff" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: "#1e293b" }}>{topic}</span>
                  <span style={{
                    fontSize: 12, fontWeight: 700, padding: "2px 8px", borderRadius: 999,
                    backgroundColor: badgeBg, color: badgeColor,
                  }}>
                    {pct}%
                  </span>
                </div>
                <div style={{ height: 8, backgroundColor: "#f1f5f9", borderRadius: 999, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${pct}%`, backgroundColor: barColor, borderRadius: 999 }} />
                </div>
                <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 6 }}>
                  {td.earned}/{td.available} marks &middot; {td.count} questions
                </div>
              </div>
            );
          })}
        </div>

        {/* CTA */}
        <div style={{ fontSize: 14, color: "#3b82f6", fontWeight: 500, textAlign: "center", marginBottom: 32 }}>
          Visit MarkForYou.com to create personalised practices for identified gaps.
        </div>

        {/* Footer branding */}
        <div style={{ paddingTop: 24, borderTop: "3px solid #3b82f6", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 24, fontWeight: 800, color: "#3b82f6" }}>MarkForYou.com</div>
          <div style={{ fontSize: 12, color: "#94a3b8" }}>AI-powered exam marking &middot; Personalised learning gaps analysis &middot; Focused practice</div>
        </div>
      </div>
    );
  }
);

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  Timeline Chart                                                            */
/* ═══════════════════════════════════════════════════════════════════════════ */

function TimelineChart({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="text-center py-12 rounded-2xl bg-slate-50 border-2 border-dashed border-slate-200">
        <p className="text-slate-400">No exam data to chart</p>
      </div>
    );
  }

  const allTopics = Array.from(
    new Set(entries.flatMap((e) => Object.keys(e.topics)))
  ).sort();

  const topicColorMap: Record<string, string> = {};
  allTopics.forEach((t, i) => {
    topicColorMap[t] = TOPIC_COLORS[i % TOPIC_COLORS.length];
  });

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

  function dateLabel(iso: string) {
    if (!iso) return "";
    const d = new Date(iso);
    return `${d.getDate()}/${d.getMonth() + 1}`;
  }

  return (
    <div>
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

      <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 320 }}>
          {[0, 25, 50, 75, 100].map((pct) => (
            <g key={pct}>
              <line
                x1={padL} x2={W - padR} y1={y(pct)} y2={y(pct)}
                stroke="#e2e8f0" strokeWidth={pct === 0 ? 1.5 : 0.75}
                strokeDasharray={pct === 0 ? undefined : "4 4"}
              />
              <text x={padL - 6} y={y(pct) + 4} textAnchor="end" className="fill-slate-400" fontSize={10}>
                {pct}%
              </text>
            </g>
          ))}

          {entries.map((e, i) => (
            <text key={i} x={x(i)} y={H - padB + 16} textAnchor="middle" className="fill-slate-400" fontSize={9}>
              {dateLabel(e.date)}
            </text>
          ))}

          {entries.map((e, i) => {
            const label = e.title.length > 18 ? e.title.slice(0, 16) + "..." : e.title;
            return (
              <text key={`t-${i}`} x={x(i)} y={H - padB + 30} textAnchor="middle" className="fill-slate-300" fontSize={8}>
                {label}
              </text>
            );
          })}

          {allTopics.map((topic) => {
            const color = topicColorMap[topic];
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
                  <path d={pathD} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                )}
                {points.map((p) => (
                  <circle key={p.idx} cx={x(p.idx)} cy={y(p.pct)} r={4} fill={color} stroke="white" strokeWidth={2} />
                ))}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
