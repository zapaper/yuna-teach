"use client";

import { useEffect, useState, useRef, useCallback, use } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, forwardRef } from "react";

export default function ProgressPage({ params }: { params: Promise<{ studentId: string }> }) {
  const { studentId } = use(params);
  return (
    <Suspense>
      <ProgressContent studentId={studentId} />
    </Suspense>
  );
}

export interface TopicData { earned: number; available: number; count: number; }
export interface SubjectData { examCount: number; topics: Record<string, TopicData>; }
export interface TimelineEntry {
  title: string;
  date: string;
  topics: Record<string, number>;
  // earned/available per topic for THIS paper. Lets the chart
  // aggregate mark-weighted across grouped papers — same formula as
  // the parent dashboard's Skill Profile Analysis and the per-topic
  // detail card on this page. Without this we had to fall back to
  // averaging per-paper pcts, which diverged when topic question
  // counts differed across papers.
  topicTotals?: Record<string, { earned: number; available: number }>;
}
interface ProgressData {
  student: { id: string; name: string } | null;
  subjects: Record<string, SubjectData>;
  timeline: Record<string, TimelineEntry[]>;
}

const TOPIC_COLORS = [
  "#6366f1","#f59e0b","#10b981","#ef4444","#8b5cf6","#06b6d4",
  "#f97316","#ec4899","#14b8a6","#84cc16","#a855f7","#0ea5e9",
];

function generateSubjectSummary(studentName: string, subject: string, sd: SubjectData) {
  const topicEntries = Object.entries(sd.topics).filter(([t]) => t !== "Untagged");
  if (topicEntries.length === 0) return { headline: "No data yet.", strong: null, gaps: null };
  const totalEarned = topicEntries.reduce((s, [, t]) => s + t.earned, 0);
  const totalAvailable = topicEntries.reduce((s, [, t]) => s + t.available, 0);
  const overallPct = totalAvailable > 0 ? Math.round((totalEarned / totalAvailable) * 100) : 0;
  // Aligned threshold: weak = ≤ 75% (inclusive), strong = > 75%. Sort weakest
  // first so gaps lead with the most-needed topic.
  const weak = topicEntries
    .filter(([, t]) => t.available > 0 && (t.earned / t.available) <= 0.75)
    .sort(([, a], [, b]) => (a.earned / a.available) - (b.earned / b.available))
    .map(([name]) => name);
  const strong = topicEntries
    .filter(([, t]) => t.available > 0 && (t.earned / t.available) > 0.75)
    .map(([name]) => name);
  return {
    headline: `${studentName}'s ${subject}: Overall ${overallPct}th %tile across ${sd.examCount} exam${sd.examCount !== 1 ? "s" : ""}.`,
    strong: strong.length > 0 ? strong.slice(0, 4).join(", ") : null,
    gaps: weak.length > 0 ? weak.slice(0, 4).join(", ") : null,
    overallPct,
  };
}

function topicStyle(pct: number) {
  if (pct >= 75) return {
    border: "border-[#006c49]",
    badgeBg: "bg-[#006c49]/10",
    badgeText: "text-[#006c49]",
    bar: "bg-[#006c49]",
  };
  if (pct >= 40) return {
    border: "border-[#ffb952]",
    badgeBg: "bg-[#ffb952]/20",
    badgeText: "text-[#d58d00]",
    bar: "bg-[#ffb952]",
  };
  return {
    border: "border-[#ba1a1a]",
    badgeBg: "bg-[#ba1a1a]/10",
    badgeText: "text-[#ba1a1a]",
    bar: "bg-[#ba1a1a]",
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
  const [assignedToast, setAssignedToast] = useState<string | null>(null);
  const [view, setView] = useState<"topic" | "time">("topic");
  const [sharing, setSharing] = useState(false);
  // Admin-only column-chart block. Authoritative check uses the signed
  // session cookie (the API ignores ?userId=), so a parent typing
  // ?parentId=<admin-id> in the URL won't unlock it.
  const [isAdmin, setIsAdmin] = useState(false);
  // Selected topic in the admin chart — drives bar highlighting and
  // the moving-average detail panel below. Cleared on subject change.
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  useEffect(() => { setSelectedTopic(null); }, [activeSubject]);
  const reportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/student-progress?parentId=${parentId}&studentId=${studentId}`);
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

  useEffect(() => {
    fetch("/api/admin/check")
      .then(r => setIsAdmin(r.ok))
      .catch(() => setIsAdmin(false));
  }, []);

  // English syllabus topic → daily-quiz section key (matches the parent-
  // dashboard Assign English Focus flow). Anything not in this map falls
  // through to /api/focused-test.
  const ENGLISH_TOPIC_TO_SECTION: Record<string, string> = {
    "Grammar MCQ": "grammar-mcq",
    "Vocabulary MCQ": "vocab-mcq",
    "Vocabulary Cloze MCQ": "vocab-cloze",
    "Visual Text Comprehension MCQ": "visual-text",
    "Grammar Cloze": "grammar-cloze",
    "Editing (Spelling & Grammar)": "editing",
    "Comprehension Cloze": "comprehension-cloze",
    "Synthesis & Transformation": "synthesis",
    "Synthesis / Transformation": "synthesis",
    "Comprehension (Open-ended)": "comprehension-oeq",
    "Comprehension Open Ended": "comprehension-oeq",
  };

  async function createFocusedTest(subject: string, topic: string) {
    setCreating(topic);
    try {
      const isEnglish = subject.toLowerCase().includes("english");
      const englishSection = isEnglish ? ENGLISH_TOPIC_TO_SECTION[topic] : undefined;

      // Mirror the parent-dashboard flow: English focus practice goes through
      // /api/daily-quiz (focused single-section). Math/Science uses focused-test.
      const res = englishSection
        ? await fetch("/api/daily-quiz", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userId: studentId,
              quizType: "mcq",
              subject: "english",
              englishSections: [englishSection],
              focused: true,
            }),
          })
        : await fetch("/api/focused-test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              parentId,
              studentId,
              subject: subject.toLowerCase().includes("math")
                ? "Mathematics"
                : subject.toLowerCase().includes("science")
                ? "Science"
                : subject,
              topic,
            }),
          });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(data.error || "Failed to create test");
        return;
      }
      if (Array.isArray(data.warnings) && data.warnings.length > 0) alert(data.warnings.join("\n"));
      setAssignedToast(topic);
      setTimeout(() => setAssignedToast(null), 2500);
    } finally {
      setCreating(null);
    }
  }

  const handleShare = useCallback(async () => {
    if (!reportRef.current || !data) return;
    setSharing(true);
    try {
      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(reportRef.current, {
        scale: 2, backgroundColor: "#ffffff", useCORS: true,
        width: reportRef.current.scrollWidth,
        height: reportRef.current.scrollHeight,
      });
      const blob = await new Promise<Blob>(resolve => canvas.toBlob(b => resolve(b!), "image/png"));
      const file = new File([blob], `${data.student?.name ?? "student"}-progress.png`, { type: "image/png" });
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: `${data.student?.name ?? "Student"}'s Learning Progress`, files: [file] });
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = file.name; a.click();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") console.error("Share failed:", e);
    } finally {
      setSharing(false);
    }
  }, [data]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#f8f9ff] flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-[#dce9ff] border-t-[#003366]" />
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
    <div className="min-h-screen bg-[#f8f9ff] pb-28 lg:pb-12">

      {/* ── Focus practice assigned toast ── */}
      {assignedToast && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[100] bg-[#006c49] text-white px-5 py-3 rounded-2xl shadow-lg flex items-center gap-2 animate-[fadeIn_0.2s_ease-out]">
          <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
          <span className="font-bold text-sm">Focus practice assigned: {assignedToast}</span>
        </div>
      )}

      {/* ── Top bar ── */}
      <header className="sticky top-0 z-50 bg-[#f8f9ff]/90 backdrop-blur-lg border-b border-[#e5eeff]">
        <div className="max-w-4xl mx-auto px-5 lg:px-8 py-4 flex items-center justify-between gap-4">
          <button
            onClick={() => parentId ? router.push(`/home/${parentId}?student=${studentId}`) : router.push(`/home/${studentId}`)}
            className="flex items-center gap-1.5 text-sm font-semibold text-[#43474f] hover:text-[#001e40] transition-colors"
          >
            <span className="material-symbols-outlined text-lg">arrow_back</span>
            Back
          </button>
          <h1 className="font-headline font-extrabold text-[#001e40] text-lg truncate">
            {data?.student?.name ?? "Progress Report"}
          </h1>
          <button
            onClick={handleShare}
            disabled={sharing || subjects.length === 0}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#d5e3ff] text-[#001e40] text-sm font-bold hover:bg-[#a7c8ff] transition-colors disabled:opacity-50"
          >
            <span className="material-symbols-outlined text-base">share</span>
            {sharing ? "..." : "Share"}
          </button>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-5 lg:px-8 py-8">

        {/* ── Report header ── */}
        <div className="mb-10">
          <h2 className="text-3xl lg:text-4xl font-extrabold text-[#001e40] font-headline tracking-tight mb-1">
            {data?.student?.name ?? "Student"}
          </h2>
          <p className="text-[#43474f] font-medium text-base">Learning Progress Report</p>
        </div>

        {subjects.length === 0 ? (
          <div className="text-center py-16 rounded-3xl bg-white border-2 border-dashed border-[#c3c6d1]">
            <span className="material-symbols-outlined text-4xl text-[#c3c6d1] mb-3 block">analytics</span>
            <p className="font-bold text-[#001e40]">No marked exams yet</p>
            <p className="text-sm text-[#43474f] mt-1">Assign and mark exams to see progress here</p>
          </div>
        ) : (
          <>
            {/* ── Summary card ── */}
            {subjectSummary && (
              <div className="bg-white rounded-3xl p-7 mb-8 shadow-sm border border-[#e5eeff] relative overflow-hidden">
                <div className="absolute top-0 right-0 w-48 h-48 bg-[#001e40]/5 rounded-full -mr-24 -mt-24 pointer-events-none" />
                <div className="relative z-10">
                  <p className="text-xl text-[#0b1c30] mb-6 font-body leading-relaxed">
                    {data?.student?.name}&apos;s {activeSubject}:{" "}
                    <span className="font-bold text-[#001e40] underline decoration-[#d5e3ff] decoration-4 underline-offset-4">
                      Overall {subjectSummary.overallPct}th %tile
                    </span>{" "}
                    across {currentSubject ? (currentSubject as SubjectData).examCount : 0} exam{(currentSubject as SubjectData)?.examCount !== 1 ? "s" : ""}.
                  </p>
                  <div className="grid md:grid-cols-2 gap-6">
                    {subjectSummary.strong && (
                      <div className="flex gap-3">
                        <div className="w-10 h-10 rounded-2xl bg-[#006c49]/10 flex items-center justify-center shrink-0">
                          <span className="material-symbols-outlined text-[#006c49]">trending_up</span>
                        </div>
                        <div>
                          <p className="text-xs font-bold text-[#006c49] uppercase tracking-wider mb-1">Strong in</p>
                          <p className="text-[#0b1c30] font-semibold leading-snug">{subjectSummary.strong}</p>
                        </div>
                      </div>
                    )}
                    {subjectSummary.gaps && (
                      <div className="flex gap-3">
                        <div className="w-10 h-10 rounded-2xl bg-[#ba1a1a]/10 flex items-center justify-center shrink-0">
                          <span className="material-symbols-outlined text-[#ba1a1a]">error_outline</span>
                        </div>
                        <div>
                          <p className="text-xs font-bold text-[#ba1a1a] uppercase tracking-wider mb-1">Gaps in</p>
                          <p className="text-[#0b1c30] font-semibold leading-snug">{subjectSummary.gaps}</p>
                        </div>
                      </div>
                    )}
                    {!subjectSummary.strong && !subjectSummary.gaps && (
                      <p className="text-sm text-[#43474f] md:col-span-2">Not enough data to identify strengths or gaps yet.</p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* ── Subject tabs + Topic/Time toggle ── */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
              <div className="flex bg-[#eff4ff] p-1.5 rounded-2xl gap-1">
                {subjects.map(subject => (
                  <button
                    key={subject}
                    onClick={() => setActiveSubject(subject)}
                    className={`px-6 py-2.5 rounded-xl font-bold text-sm transition-all ${
                      activeSubject === subject
                        ? "bg-white text-[#001e40] shadow-sm"
                        : "text-[#43474f] hover:text-[#001e40]"
                    }`}
                  >
                    {subject}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1.5 bg-[#eff4ff] p-1 rounded-full self-start sm:self-auto">
                <button
                  onClick={() => setView("topic")}
                  className={`px-5 py-2 rounded-full text-sm font-bold transition-all ${
                    view === "topic" ? "bg-[#001e40] text-white" : "text-[#43474f] hover:text-[#001e40]"
                  }`}
                >Topic</button>
                <button
                  onClick={() => setView("time")}
                  className={`px-5 py-2 rounded-full text-sm font-bold transition-all ${
                    view === "time" ? "bg-[#001e40] text-white" : "text-[#43474f] hover:text-[#001e40]"
                  }`}
                >Time</button>
              </div>
            </div>

            {/* ── Per-topic accuracy chart with subject avg line ──
                Was admin-only behind an isAdmin gate, but the gate
                ran a /api/admin/check round-trip on mount which made
                non-admin parents (the actual target) see the old
                card view for the duration of the fetch, then flip
                to the chart once isAdmin resolved. Universal now —
                everyone sees the same chart immediately. */}
            {currentSubject && view === "topic" && activeSubject && (
              <AdminTopicChart
                subject={activeSubject}
                subjectData={currentSubject}
                timeline={Array.isArray(currentTimeline) ? currentTimeline : []}
                studentName={data?.student?.name ?? "Student"}
                selectedTopic={selectedTopic}
                onSelectTopic={setSelectedTopic}
                onAssignFocus={topic => createFocusedTest(activeSubject, topic)}
                creating={creating}
              />
            )}

            {/* (Legacy topic-cards view removed — AdminTopicChart
                above now serves every viewer. Restore from git if
                we ever need a card variant again.) */}

            {/* ── Time view ── */}
            {view === "time" && (
              <TimelineChart entries={currentTimeline || []} />
            )}
          </>
        )}
      </div>

      {/* Hidden shareable report for html2canvas */}
      {data && activeSubject && currentSubject && (
        <div style={{ position: "absolute", left: "-9999px", top: 0 }}>
          <ShareableReport
            ref={reportRef}
            data={data}
            subject={activeSubject}
            subjectData={currentSubject as SubjectData}
            summary={subjectSummary!}
          />
        </div>
      )}

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-[#f8f9ff]/90 backdrop-blur-lg border-t border-[#e5eeff] flex justify-around items-center py-3 z-50">
        <button
          onClick={() => parentId ? router.push(`/home/${parentId}?student=${studentId}`) : router.back()}
          className="flex flex-col items-center gap-1 text-[#43474f]"
        >
          <span className="material-symbols-outlined">dashboard</span>
          <span className="text-[10px] font-bold uppercase tracking-wider">Home</span>
        </button>
        <button className="flex flex-col items-center gap-1 text-[#001e40]">
          <span className="material-symbols-outlined" style={{ fontVariationSettings: "'FILL' 1" }}>bar_chart</span>
          <span className="text-[10px] font-bold uppercase tracking-wider">Reports</span>
        </button>
        <button
          onClick={handleShare}
          disabled={sharing}
          className="flex flex-col items-center gap-1 text-[#43474f] disabled:opacity-50"
        >
          <span className="material-symbols-outlined">share</span>
          <span className="text-[10px] font-bold uppercase tracking-wider">Share</span>
        </button>
      </nav>
    </div>
  );
}

/* ── Shareable Report ── */
const ShareableReport = forwardRef<
  HTMLDivElement,
  { data: ProgressData; subject: string; subjectData: SubjectData; summary: { headline: string; strong: string | null; gaps: string | null; overallPct?: number } }
>(function ShareableReport({ data, subject, subjectData, summary }, ref) {
  const topicEntries = Object.entries(subjectData.topics)
    .filter(([t]) => t !== "Untagged")
    .sort(([, a], [, b]) => (a.available > 0 ? a.earned / a.available : 0) - (b.available > 0 ? b.earned / b.available : 0));

  return (
    <div ref={ref} style={{ width: 900, padding: 48, fontFamily: "'Inter', system-ui, sans-serif", backgroundColor: "#ffffff", color: "#1e293b" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32, paddingBottom: 24, borderBottom: "3px solid #001e40" }}>
        <div>
          <div style={{ fontSize: 32, fontWeight: 800, color: "#001e40" }}>{data.student?.name}</div>
          <div style={{ fontSize: 16, color: "#43474f", marginTop: 4 }}>{subject} · Learning Progress Report</div>
          <div style={{ fontSize: 13, color: "#737780", marginTop: 4 }}>Generated {new Date().toLocaleDateString("en-SG", { day: "numeric", month: "long", year: "numeric" })}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: "#001e40" }}>MarkForYou.com</div>
          <div style={{ fontSize: 14, color: "#737780", marginTop: 4 }}>AI-Powered Learning Progress</div>
        </div>
      </div>
      <div style={{ marginBottom: 32 }}>
        <div style={{ fontSize: 18, color: "#0b1c30", lineHeight: 1.7 }}>{summary.headline}</div>
        {summary.strong && (
          <div style={{ fontSize: 16, color: "#0b1c30", lineHeight: 1.7, marginTop: 10 }}>
            <span style={{ fontWeight: 700, color: "#006c49" }}>Strong in: </span>{summary.strong}
          </div>
        )}
        {summary.gaps && (
          <div style={{ fontSize: 16, color: "#0b1c30", lineHeight: 1.7, marginTop: 6 }}>
            <span style={{ fontWeight: 700, color: "#ba1a1a" }}>Gaps in: </span>{summary.gaps}
          </div>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 32 }}>
        {topicEntries.map(([topic, td]) => {
          const pct = td.available > 0 ? Math.round((td.earned / td.available) * 100) : 0;
          const barColor = pct >= 75 ? "#006c49" : pct >= 40 ? "#ffb952" : "#ba1a1a";
          const badgeBg = pct >= 75 ? "#e8f5e9" : pct >= 40 ? "#fff8e1" : "#fce4ec";
          const badgeColor = pct >= 75 ? "#006c49" : pct >= 40 ? "#d58d00" : "#ba1a1a";
          return (
            <div key={topic} style={{ border: "1px solid #e5eeff", borderRadius: 12, padding: 16, background: "#ffffff" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 15, fontWeight: 600, color: "#0b1c30" }}>{topic}</span>
                <span style={{ fontSize: 13, fontWeight: 700, padding: "3px 10px", borderRadius: 999, backgroundColor: badgeBg, color: badgeColor }}>
                  {pct}th %tile
                </span>
              </div>
              <div style={{ height: 8, backgroundColor: "#f1f5f9", borderRadius: 999, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${pct}%`, backgroundColor: barColor, borderRadius: 999 }} />
              </div>
              <div style={{ fontSize: 12, color: "#737780", marginTop: 8 }}>
                {td.earned}/{td.available} marks · {td.count} questions
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ paddingTop: 24, borderTop: "2px solid #e5eeff", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 22, fontWeight: 800, color: "#001e40" }}>MarkForYou.com</div>
        <div style={{ fontSize: 12, color: "#737780" }}>AI-powered marking · Personalised learning gaps · Focused practice</div>
      </div>
    </div>
  );
});

/* ── Timeline Chart ── */
function TimelineChart({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="text-center py-12 rounded-3xl bg-white border-2 border-dashed border-[#c3c6d1]">
        <p className="text-[#43474f]">No exam data to chart</p>
      </div>
    );
  }

  // Aggregate entries into groups of 3 for robustness — but use
  // mark-weighted averaging (sum earned / sum available) so the chart
  // points and rankings line up with the per-topic detail card and the
  // parent dashboard's Skill Profile Analysis. Falls back to simple-
  // average over pct if topicTotals isn't present (older API responses).
  const GROUP_SIZE = 3;
  const aggregated: TimelineEntry[] = [];
  const mergeChunk = (chunk: TimelineEntry[]): TimelineEntry => {
    const merged: Record<string, { earned: number; available: number; sum: number; count: number }> = {};
    for (const e of chunk) {
      for (const topic of Object.keys(e.topics)) {
        if (!merged[topic]) merged[topic] = { earned: 0, available: 0, sum: 0, count: 0 };
        const tt = e.topicTotals?.[topic];
        if (tt) {
          merged[topic].earned += tt.earned;
          merged[topic].available += tt.available;
        }
        merged[topic].sum += e.topics[topic];
        merged[topic].count++;
      }
    }
    const topics: Record<string, number> = {};
    const topicTotals: Record<string, { earned: number; available: number }> = {};
    for (const [topic, m] of Object.entries(merged)) {
      // Prefer mark-weighted; fall back to per-paper average if the
      // earned/available data isn't there for any reason.
      topics[topic] = m.available > 0
        ? Math.round((m.earned / m.available) * 100)
        : Math.round(m.sum / m.count);
      topicTotals[topic] = { earned: m.earned, available: m.available };
    }
    return {
      title: `Avg of ${chunk.length}`,
      date: chunk[chunk.length - 1].date,
      topics,
      topicTotals,
    };
  };

  if (entries.length < GROUP_SIZE) {
    aggregated.push(mergeChunk(entries));
  } else {
    const usable = entries.slice(-(Math.floor(entries.length / GROUP_SIZE) * GROUP_SIZE));
    for (let i = 0; i < usable.length; i += GROUP_SIZE) {
      aggregated.push(mergeChunk(usable.slice(i, i + GROUP_SIZE)));
    }
  }

  const allTopics = Array.from(new Set(aggregated.flatMap(e => Object.keys(e.topics)))).sort();
  // Rank topics by mark-weighted overall pct across all aggregated
  // points (sum of all earned / sum of all available for the topic).
  // This matches the dashboard's "weakest topic" ranking exactly so
  // the chart highlights the same topics the dashboard flags.
  const topicAvg: Record<string, number> = {};
  for (const t of allTopics) {
    let earnedSum = 0;
    let availableSum = 0;
    for (const e of aggregated) {
      const tt = e.topicTotals?.[t];
      if (tt) {
        earnedSum += tt.earned;
        availableSum += tt.available;
      }
    }
    if (availableSum > 0) {
      topicAvg[t] = (earnedSum / availableSum) * 100;
    } else {
      // Fallback: simple per-paper average.
      const vals = aggregated.map(e => e.topics[t]).filter((v): v is number => typeof v === "number");
      topicAvg[t] = vals.length > 0 ? vals.reduce((s, v) => s + v, 0) / vals.length : 100;
    }
  }
  const weakestFirst = [...allTopics].sort((a, b) => topicAvg[a] - topicAvg[b]);
  const highlightedTopics = new Set(weakestFirst.slice(0, 5));
  const topicColorMap: Record<string, string> = {};
  const GREY = "#c3c6d1";
  allTopics.forEach((t, i) => { topicColorMap[t] = TOPIC_COLORS[i % TOPIC_COLORS.length]; });

  const [filterMode, setFilterMode] = useState<"weak" | "all">("weak");
  const colorFor = (topic: string) => {
    if (filterMode === "all") return topicColorMap[topic];
    return highlightedTopics.has(topic) ? topicColorMap[topic] : GREY;
  };

  const W = 600, H = 260, padL = 40, padR = 20, padT = 16, padB = 20;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const n = aggregated.length;
  const xStep = n > 1 ? chartW / (n - 1) : 0;

  function x(i: number) { return padL + (n > 1 ? i * xStep : chartW / 2); }
  function y(pct: number) { return padT + chartH - (pct / 100) * chartH; }
  // Draw highlighted lines on top of grey ones so they aren't overdrawn.
  const topicsInDrawOrder = filterMode === "weak"
    ? [...allTopics].sort((a, b) => Number(highlightedTopics.has(a)) - Number(highlightedTopics.has(b)))
    : allTopics;
  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-1.5 bg-[#eff4ff] p-1 rounded-full">
          <button
            onClick={() => setFilterMode("weak")}
            className={`px-4 py-1.5 rounded-full text-xs font-bold transition-all ${filterMode === "weak" ? "bg-[#001e40] text-white" : "text-[#43474f] hover:text-[#001e40]"}`}
          >Weak Only</button>
          <button
            onClick={() => setFilterMode("all")}
            className={`px-4 py-1.5 rounded-full text-xs font-bold transition-all ${filterMode === "all" ? "bg-[#001e40] text-white" : "text-[#43474f] hover:text-[#001e40]"}`}
          >All</button>
        </div>
        {filterMode === "weak" && (
          <p className="text-[10px] text-[#737780]">Showing top 5 weakest in colour</p>
        )}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 mb-4">
        {(filterMode === "weak" ? weakestFirst.slice(0, 5) : allTopics).map(topic => (
          <div key={topic} className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: colorFor(topic) }} />
            <span className="text-[11px] text-[#43474f]">{topic}</span>
          </div>
        ))}
      </div>
      <div className="rounded-3xl border border-[#e5eeff] bg-white p-4 shadow-sm overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: 320 }}>
          {[0, 25, 50, 75, 100].map(pct => (
            <g key={pct}>
              <line x1={padL} x2={W - padR} y1={y(pct)} y2={y(pct)} stroke="#e5eeff" strokeWidth={pct === 0 ? 1.5 : 0.75} strokeDasharray={pct === 0 ? undefined : "4 4"} />
              <text x={padL - 6} y={y(pct) + 4} textAnchor="end" fill="#737780" fontSize={10}>{pct}%</text>
            </g>
          ))}
          {topicsInDrawOrder.map(topic => {
            const color = colorFor(topic);
            const isGrey = filterMode === "weak" && !highlightedTopics.has(topic);
            const points = aggregated.map((e, i) => e.topics[topic] !== undefined ? { idx: i, pct: e.topics[topic] } : null).filter(Boolean) as { idx: number; pct: number }[];
            if (points.length === 0) return null;
            const pathD = points.map((p, j) => `${j === 0 ? "M" : "L"} ${x(p.idx)} ${y(p.pct)}`).join(" ");
            return (
              <g key={topic} opacity={isGrey ? 0.5 : 1}>
                {points.length > 1 && <path d={pathD} fill="none" stroke={color} strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" />}
                {points.map(p => <circle key={p.idx} cx={x(p.idx)} cy={y(p.pct)} r={5.5} fill={color} stroke="white" strokeWidth={2.5} />)}
              </g>
            );
          })}
        </svg>
      </div>
      <p className="text-[10px] text-[#c3c6d1] mt-2 text-right italic">Each data point is average of three quizzes/papers</p>
    </div>
  );
}

// Admin-only chart: per-topic accuracy column chart with the student's
// own subject average as a dashed horizontal line. Bars sorted high → low
// so strongest topics surface first; topics with <3 questions filtered out
// to suppress single-question noise. Uses the same SubjectData feeding the
// existing topic cards below, so no extra API.
export function AdminTopicChart({
  subject,
  subjectData,
  timeline,
  studentName,
  selectedTopic,
  onSelectTopic,
  onAssignFocus,
  creating,
}: {
  subject: string;
  subjectData: SubjectData;
  timeline: TimelineEntry[];
  studentName: string;
  selectedTopic: string | null;
  onSelectTopic: (topic: string | null) => void;
  onAssignFocus: (topic: string) => void;
  creating: string | null;
}) {
  const MIN_QS = 3;
  const topics = Object.entries(subjectData.topics)
    .filter(([t, td]) => t !== "Untagged" && td.available > 0 && td.count >= MIN_QS)
    .map(([t, td]) => ({
      topic: t,
      pct: (td.earned / td.available) * 100,
      attempts: td.count,
      earned: td.earned,
      available: td.available,
    }))
    .sort((a, b) => b.pct - a.pct);
  if (topics.length === 0) return null;
  const totalEarned = topics.reduce((s, t) => s + t.earned, 0);
  const totalAvailable = topics.reduce((s, t) => s + t.available, 0);
  const totalAttempts = topics.reduce((s, t) => s + t.attempts, 0);
  const avg = totalAvailable > 0 ? (totalEarned / totalAvailable) * 100 : 0;

  // Chart is sized to fit the longest topic label at the rotated
  // -40° x-axis position without truncation. Each character is ~7.5px
  // at fontSize=13; at -40° the vertical footprint of a label is
  // length × sin(40°) ≈ 0.64 × label width plus a baseline buffer.
  const longest = topics.reduce((m, t) => Math.max(m, t.topic.length), 0);
  const W = 1100;
  const labelHeight = Math.ceil(longest * 7.5 * 0.64) + 24; // px
  const padL = 50, padR = 20, padT = 30, padB = Math.max(110, labelHeight);
  const H = 30 + 250 + padB; // padT + plot + padB so the plot stays ≥250px tall
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = topics.length;
  const slot = plotW / Math.max(1, n);
  // Bars occupy 90% of their slot — denser layout so the visual
  // sweep across topics reads as a continuous shape rather than a
  // sparse row of skinny bars.
  const barW = Math.min(70, slot * 0.9);
  // Auto-zoom: if every topic AND the avg sit at ≥50%, drop the y-axis
  // floor to 50 so the differences between strong topics are easier to
  // see. Otherwise keep the full 0–100 range so any genuinely weak
  // topic still reads correctly.
  const minTopicPct = Math.min(...topics.map(t => t.pct));
  const yMin = (minTopicPct >= 50 && avg >= 50) ? 50 : 0;
  const yStep = yMin === 50 ? 10 : 25;
  const yTicks: number[] = [];
  for (let v = yMin; v <= 100; v += yStep) yTicks.push(v);
  const y = (pct: number) => {
    const clamped = Math.max(yMin, Math.min(100, pct));
    return padT + plotH - ((clamped - yMin) / (100 - yMin)) * plotH;
  };

  return (
    <div className="bg-white rounded-2xl border-2 border-violet-200 p-5 mb-4 shadow-sm">
      <h3 className="text-sm font-extrabold text-violet-700 uppercase tracking-widest mb-1">Per-topic accuracy</h3>
      <p className="text-xs text-[#43474f] mb-3">
        {studentName} — {subject}. {topics.length} topic{topics.length === 1 ? "" : "s"} with ≥{MIN_QS} attempts · {totalAttempts.toLocaleString()} total attempts · subject avg <span className="font-bold text-rose-600">{avg.toFixed(1)}%</span>
      </p>
      {/* Desktop / tablet: vertical column chart with rotated x-labels.
          Both the bar AND the x-axis label are clickable — clicking
          either selects the topic, highlighting the bar and surfacing
          the moving-average detail panel below. */}
      <div className="hidden md:block w-full">
        <svg viewBox={`0 0 ${W} ${H}`} className="block w-full h-auto">
          {/* y-axis gridlines */}
          {yTicks.map(pct => (
            <g key={pct}>
              <line x1={padL} y1={y(pct)} x2={padL + plotW} y2={y(pct)} stroke="#E5E7EB" strokeWidth={1} />
              <text x={padL - 6} y={y(pct) + 4} textAnchor="end" fill="#737780" fontSize={10}>{pct}%</text>
            </g>
          ))}
          {/* bars */}
          {topics.map((t, i) => {
            const x = padL + slot * i + (slot - barW) / 2;
            const by = y(t.pct);
            const h = (padT + plotH) - by;
            const isSel = selectedTopic === t.topic;
            const fill = isSel
              ? "#7C3AED"
              : t.pct >= avg ? "#10B981" : "#94A3B8";
            const handleClick = () => onSelectTopic(isSel ? null : t.topic);
            return (
              <g key={t.topic} style={{ cursor: "pointer" }} onClick={handleClick}>
                {/* Larger transparent hit area so taps near the bar
                    or label also count. */}
                <rect x={x - slot * 0.05} y={padT} width={barW + slot * 0.1} height={plotH + padB - 20} fill="transparent" />
                <rect x={x} y={by} width={barW} height={h} fill={fill} rx={3}
                  stroke={isSel ? "#5B21B6" : "transparent"} strokeWidth={isSel ? 2 : 0} />
                <text x={x + barW / 2} y={by - 18} textAnchor="middle" fill="#001E40" fontSize={16} fontWeight="bold">{t.pct.toFixed(0)}%</text>
                <text x={x + barW / 2} y={by - 4} textAnchor="middle" fill="#737780" fontSize={11}>n={t.attempts}</text>
                {/* x-axis label rotated -40° */}
                <text
                  x={x + barW / 2}
                  y={padT + plotH + 10}
                  fill={isSel ? "#5B21B6" : "#43474f"}
                  fontSize={13}
                  fontWeight={isSel ? "bold" : "600"}
                  textAnchor="end"
                  transform={`rotate(-40 ${x + barW / 2} ${padT + plotH + 10})`}
                >{t.topic}</text>
              </g>
            );
          })}
          {/* dashed avg line, drawn after bars so it sits on top */}
          <line x1={padL} y1={y(avg)} x2={padL + plotW} y2={y(avg)} stroke="#DC2626" strokeWidth={2} strokeDasharray="8 6" />
          <text x={padL + plotW - 4} y={y(avg) - 6} textAnchor="end" fill="#DC2626" fontSize={13} fontWeight="bold">avg {avg.toFixed(1)}%</text>
        </svg>
      </div>

      {/* Mobile (<md): horizontal-bar list. Each row = topic; the bar
          runs left-to-right, % shown at the end. A single vertical
          dashed red line sits across all bars at the subject average. */}
      <div className="md:hidden pl-1 pr-3">
        {(() => {
          const avgFrac = (Math.max(yMin, Math.min(100, avg)) - yMin) / (100 - yMin);
          return (
            <div className="flex flex-col gap-1.5">
              {topics.map(t => {
                const isSel = selectedTopic === t.topic;
                const colorBar = isSel ? "bg-violet-600" : t.pct >= avg ? "bg-emerald-500" : "bg-slate-400";
                const colorPct = isSel ? "text-violet-700" : t.pct >= avg ? "text-emerald-700" : "text-slate-600";
                const barFrac = (Math.max(yMin, Math.min(100, t.pct)) - yMin) / (100 - yMin);
                return (
                  <button
                    type="button"
                    key={t.topic}
                    onClick={() => onSelectTopic(isSel ? null : t.topic)}
                    className={`w-full text-left grid grid-cols-[40%_1fr_3rem] gap-2 items-center text-[12px] py-1 px-1 -mx-1 rounded transition-colors ${isSel ? "bg-violet-50 ring-1 ring-violet-200" : "hover:bg-slate-50"}`}
                  >
                    <div className={`truncate font-semibold ${isSel ? "text-violet-800" : "text-[#001e40]"}`} title={t.topic}>
                      {t.topic}
                      <span className="ml-1 text-[10px] text-[#737780] font-medium">n={t.attempts}</span>
                    </div>
                    {/* Bar track. Avg dashed line lives INSIDE the
                        track at left:${avgFrac * 100}%, which is the
                        exact same coordinate space the colored bar's
                        width uses — so they always line up vertically
                        across rows regardless of label-column width. */}
                    <div className="relative h-8 bg-slate-100 rounded">
                      <div className="absolute inset-0 rounded overflow-hidden">
                        <div className={`h-full ${colorBar}`} style={{ width: `${barFrac * 100}%` }} />
                      </div>
                      <div
                        className="absolute top-0 bottom-0 border-l-2 border-dashed border-rose-600 pointer-events-none"
                        style={{ left: `${avgFrac * 100}%` }}
                        aria-hidden
                      />
                    </div>
                    <span className={`text-[14px] font-extrabold tabular-nums ${colorPct} text-right`}>{t.pct.toFixed(0)}%</span>
                  </button>
                );
              })}
            </div>
          );
        })()}
        <div className="flex items-center justify-between gap-2 mt-3 text-[11px] font-bold">
          <span className="flex items-center gap-2 text-rose-600">
            <span className="inline-block w-4 border-t-2 border-dashed border-rose-600" />
            subject avg {avg.toFixed(1)}%
          </span>
          {yMin > 0 && <span className="text-[#737780]">bars start at {yMin}%</span>}
        </div>
      </div>

      {/* Detail panel — appears when a topic bar/label is tapped. Plots
          the rolling-3-paper average of that topic's accuracy over the
          student's timeline, plus a one-tap Assign Focus Practice button
          for the same topic. */}
      {selectedTopic && (
        <SelectedTopicPanel
          subject={subject}
          topic={selectedTopic}
          timeline={timeline}
          onClose={() => onSelectTopic(null)}
          onAssignFocus={() => onAssignFocus(selectedTopic)}
          creating={creating === selectedTopic}
        />
      )}
      {!selectedTopic && (
        <p className="mt-4 text-[11px] text-slate-400 italic text-center">Tap any bar or label to see the topic's history and assign focused practice.</p>
      )}
    </div>
  );
}

// Detail panel shown beneath the admin bar chart when a topic is
// selected. Plots the rolling-3-paper average of the topic's accuracy
// over time and offers an Assign Focus Practice button for the same
// topic. Hidden until a bar/label is tapped.
export function SelectedTopicPanel({
  subject,
  topic,
  timeline,
  onClose,
  onAssignFocus,
  creating,
}: {
  subject: string;
  topic: string;
  timeline: TimelineEntry[];
  onClose: () => void;
  onAssignFocus: () => void;
  creating: boolean;
}) {
  // Per-paper topic contribution in chronological order. Each entry
  // carries the earned + available marks the topic contributed on
  // that paper. Skip papers that didn't touch the topic.
  const series = timeline
    .map(e => {
      const t = e.topicTotals?.[topic];
      if (!t || t.available <= 0) return null;
      return { date: e.date, title: e.title, earned: t.earned, available: t.available, pct: (t.earned / t.available) * 100 };
    })
    .filter((x): x is { date: string; title: string; earned: number; available: number; pct: number } => x !== null);

  if (series.length === 0) {
    return (
      <div className="mt-5 pt-5 border-t border-violet-100">
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <p className="text-sm font-extrabold text-violet-800">{topic}</p>
          <button onClick={onClose} className="text-[10px] text-slate-400 hover:text-slate-700">close</button>
        </div>
        <p className="text-xs text-slate-500 italic">No paper-level history for this topic yet.</p>
        <button
          onClick={onAssignFocus}
          disabled={creating}
          className="mt-3 w-full sm:w-auto px-5 py-2.5 rounded-xl font-bold text-sm bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50"
        >
          {creating ? "Creating…" : "Assign Focus Practice"}
        </button>
      </div>
    );
  }

  // Bucket into groups of 3 chronological papers ONCE we have enough
  // points for at least two full buckets (≥6 papers). Each bucket
  // becomes one mark-weighted dot — sum(earned across the 3) divided
  // by sum(available across the 3) — so noisy single-paper swings
  // smooth out. Below 6 papers we plot every paper as its own dot,
  // since aggregating 3 with only ~4 total points hides the trend.
  const BUCKET = 3;
  const bucketed = series.length >= 2 * BUCKET;
  const buckets: { from: number; to: number; pct: number; earned: number; available: number; label: string }[] = [];
  if (bucketed) {
    for (let i = 0; i < series.length; i += BUCKET) {
      const window = series.slice(i, i + BUCKET);
      const e = window.reduce((s, p) => s + p.earned, 0);
      const a = window.reduce((s, p) => s + p.available, 0);
      if (a <= 0) continue;
      buckets.push({
        from: i,
        to: Math.min(i + BUCKET - 1, series.length - 1),
        pct: (e / a) * 100,
        earned: e,
        available: a,
        label: `papers ${i + 1}-${Math.min(i + BUCKET, series.length)}`,
      });
    }
  } else {
    series.forEach((p, i) => buckets.push({ from: i, to: i, pct: p.pct, earned: p.earned, available: p.available, label: `paper ${i + 1}` }));
  }
  // Trend = where the student is NOW vs the topic's overall average.
  // "Now" = last bucket (avg of last 3 papers when we have enough
  // data, else just the latest paper). Positive = ahead of their
  // own average, negative = below.
  const subjAvg = (() => {
    const e = series.reduce((s, p) => s + p.earned, 0);
    const a = series.reduce((s, p) => s + p.available, 0);
    return a > 0 ? (e / a) * 100 : 0;
  })();
  const lastDataPoint = buckets.length > 0 ? buckets[buckets.length - 1].pct : 0;
  const trendDelta = lastDataPoint - subjAvg;
  const latest = series[series.length - 1];

  // SVG geometry — short stacked chart that reads on a phone.
  const W = 600, H = 200;
  const padL = 50, padR = 12, padT = 14, padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const allPcts = [...buckets.map(b => b.pct), ...series.map(s => s.pct), subjAvg];
  const yMin = Math.min(50, Math.floor(Math.min(...allPcts) / 10) * 10);
  const y = (pct: number) => padT + plotH - ((Math.max(yMin, Math.min(100, pct)) - yMin) / (100 - yMin)) * plotH;
  // X uses the midpoint of each bucket's underlying papers so the
  // dots sit at the time-centroid of their group.
  const seriesLast = Math.max(1, series.length - 1);
  const xForSeriesIdx = (idx: number) => series.length === 1 ? padL + plotW / 2 : padL + (idx / seriesLast) * plotW;
  const xForBucket = (b: { from: number; to: number }) => xForSeriesIdx((b.from + b.to) / 2);

  return (
    <div className="mt-5 pt-5 border-t border-violet-100">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <div className="min-w-0">
          <p className="text-sm font-extrabold text-violet-800 truncate">{topic}</p>
          <p className="text-[11px] text-slate-500 mt-0.5">
            {(() => {
              if (!bucketed) {
                return `${series.length} paper${series.length === 1 ? "" : "s"} · topic avg ${subjAvg.toFixed(1)}% · latest paper ${latest.pct.toFixed(0)}%`;
              }
              const lastBucket = buckets[buckets.length - 1];
              const lastCount = lastBucket.to - lastBucket.from + 1;
              return `${series.length} papers · topic avg ${subjAvg.toFixed(1)}% · last ${lastCount} paper${lastCount === 1 ? "" : "s"} avg ${lastDataPoint.toFixed(0)}%`;
            })()}
            {buckets.length >= 2 && (
              <>
                {" · "}
                <span
                  className={trendDelta >= 0 ? "text-emerald-600 font-bold" : "text-rose-600 font-bold"}
                  title={bucketed ? "Latest 3-paper window vs topic average" : "Latest paper vs topic average"}
                >
                  {trendDelta >= 0 ? "▲" : "▼"} {Math.abs(trendDelta).toFixed(1)}pp vs topic avg
                </span>
              </>
            )}
          </p>
        </div>
        <button onClick={onClose} className="text-[10px] text-slate-400 hover:text-slate-700 shrink-0">close</button>
      </div>
      <div className="w-full overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="block w-full h-auto min-h-[160px]">
          {[yMin, Math.round((yMin + 100) / 2), 100].map(pct => (
            <g key={pct}>
              <line x1={padL} y1={y(pct)} x2={padL + plotW} y2={y(pct)} stroke="#E5E7EB" strokeWidth={1} />
              <text x={padL - 8} y={y(pct) + 6} textAnchor="end" fill="#43474f" fontSize={16} fontWeight="600">{pct}%</text>
            </g>
          ))}
          {/* Per-paper dots — always shown faintly so the underlying
              points are visible even when buckets aggregate them. */}
          {series.map((p, i) => (
            <circle key={i} cx={xForSeriesIdx(i)} cy={y(p.pct)} r={5} fill="#C4B5FD" />
          ))}
          {/* Bucket dots + connecting line — the main signal. */}
          {buckets.length > 1 && (
            <path
              d={buckets.map((b, i) => `${i === 0 ? "M" : "L"} ${xForBucket(b)} ${y(b.pct)}`).join(" ")}
              fill="none"
              stroke="#7C3AED"
              strokeWidth={3.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
          {buckets.map((b, i) => (
            <circle key={`b${i}`} cx={xForBucket(b)} cy={y(b.pct)} r={8} fill="#7C3AED" stroke="white" strokeWidth={2.5}>
              <title>{`${b.label} · ${b.pct.toFixed(1)}% (${b.earned}/${b.available})`}</title>
            </circle>
          ))}
        </svg>
      </div>
      <p className="text-[10px] text-slate-400 mt-1 text-center italic">
        {bucketed
          ? `Each dark dot = mark-weighted accuracy over a window of 3 papers · light dots = individual papers`
          : `Each dot = one paper · need ≥6 papers before 3-paper grouping kicks in`}
      </p>
      <button
        onClick={onAssignFocus}
        disabled={creating}
        className="mt-3 w-full sm:w-auto sm:ml-auto sm:flex sm:items-center sm:justify-center px-5 py-3 rounded-xl font-bold text-sm bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
      >
        <span className="material-symbols-outlined text-base">target</span>
        {creating ? `Creating ${subject} focus…` : `Assign Focus Practice — ${topic}`}
      </button>
    </div>
  );
}
