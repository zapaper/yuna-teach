"use client";

import { Suspense, useCallback, useEffect, useRef, useState, use, forwardRef } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { getDisplayCombosForKid } from "@/lib/lumi-combos";
import { deriveRationale } from "@/lib/lumi-rationale";
import Link from "next/link";
import { AdminTopicChart, type SubjectData, type TimelineEntry } from "../../progress/[studentId]/page";
import MathText from "@/components/MathText";
import { LUMI_DATA_URI } from "@/lib/lumi-data-uri";

type ProgressData = {
  student: { id: string; name: string } | null;
  subjects: Record<string, SubjectData>;
  timeline: Record<string, TimelineEntry[]>;
};

// Cache helpers — strip the huge base64 diagrams + prune stale keys.
function stripImagesForCache(d: unknown): unknown {
  if (!d || typeof d !== "object") return d;
  const obj = d as { kind?: string; commonMistakes?: Array<{ examples?: unknown[] }>; conceptualGaps?: Array<{ examples?: unknown[] }> };
  if (obj.kind !== "ready") return d;
  const stripExamples = (exs: unknown[]) =>
    exs.map(ex => {
      if (!ex || typeof ex !== "object") return ex;
      const e = ex as Record<string, unknown>;
      return { ...e, diagramImageData: null };
    });
  return {
    ...obj,
    commonMistakes: obj.commonMistakes?.map(m => ({ ...m, examples: stripExamples(m.examples ?? []) })) ?? [],
    conceptualGaps: obj.conceptualGaps?.map(c => ({ ...c, examples: stripExamples(c.examples ?? []) })) ?? [],
  };
}
function pruneOldTutorCacheKeys(currentKey: string) {
  if (typeof window === "undefined") return;
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith("tutor-") && k !== currentKey) keys.push(k);
  }
  for (const k of keys) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
}

type Topline = {
  avgPct: number;
  totalAwarded: number;
  totalAvailable: number;
  paperCount: number;
  strongTopics: Array<{ topic: string; pct: number }>;
  weakTopics: Array<{ topic: string; pct: number; attempts: number }>;
  // Optional so cached payloads from before allTopics shipped still
  // type-check. Falls back to the strong+weak merge for those.
  allTopics?: Array<{ topic: string; pct: number; attempts: number }>;
  nudge: string | null;
};
type MistakeExample = {
  questionRef: string;
  whatWentWrong: string;
  paperTitle: string | null;
  questionNum: string | null;
  questionText: string | null;
  studentAnswer: string | null;
  markingNotes: string | null;
  diagramImageData: string | null;
  optionImages: string[] | null;
  answerImagePaperId: string | null;
  answerImagePageIndex: number | null;
  isMcq: boolean;
  options: string[];
  picked: string | null;
  correct: string | null;
  // Syllabus topic of the question. Used by the runtime to surface
  // a "Most of these mistakes are in [topic]" callout when the pattern's
  // examples concentrate on one topic.
  topic?: string | null;
  // Master examQuestion id — used by ExpandableExample to look up
  // lazy-loaded diagram / option-image blobs from the LazyImages map.
  // loadTutorData ships the field through instead of wiping it before
  // returning, so the client can POST to /api/tutor/[studentId]/diagrams
  // when a parent opens a card.
  questionId?: string | null;
};
type MistakeCard = {
  bucket: string;
  name: string;
  what: string;
  advice: string;
  triggerKeywords: string[];
  examples: MistakeExample[];
  marksLost: number;
};
type ConceptCard = {
  bucket: string;
  name: string;
  what: string;
  advice: string;
  examples: MistakeExample[];
  marksLost: number;
};
type TopicCard = { topic: string; pct: number; attempts: number };

type StaleInfo = {
  kind: "fresh" | "stale";
  cachedAt: string | null;
  cachedWrongs: number;
  currentWrongs: number;
};
// Mirrors src/lib/tutor.ts PreviousAssessmentDelta. Surfaced when the
// workshop has overwritten a prior assessment in this kid's cache, so
// the LumiSummary can call out improvements / patterns cleared since.
type PreviousAssessmentDelta = {
  generatedAt: string;
  patternsCleared: string[];
  patternsNew: string[];
  avgDelta: number | null;
  paperCountDelta: number | null;
};
type WeeklyDelta = {
  prevGeneratedAt: string;
  currGeneratedAt: string;
  papersThisWeek: number;
  questionsThisWeek: number;
  caseA: boolean;
  prefaceText: string;
  wins: Array<{
    patternName: string;
    patternWhat?: string;
    patternAdvice?: string;
    exampleHit: {
      questionId: string;
      paperTitle: string;
      questionNum: string;
      topic: string | null;
      aw: number;
      av: number;
      stem: string;
      studentAnswer: string | null;
      correctAnswer: string | null;
      isMcq: boolean;
      options: string[];
    };
  }>;
  topicProgress: Array<{
    topic: string;
    thisPct: number;
    prevPct: number;
    delta: number;
    attemptsThisWeek: number;
  }>;
  newMistakes: Array<{
    patternName: string;
    patternWhat?: string;
    patternAdvice?: string;
    exampleWrong?: {
      questionId: string;
      paperTitle: string;
      questionNum: string;
      topic: string | null;
      aw: number;
      av: number;
      stem: string;
      studentAnswer: string | null;
      markingNotes: string | null;
      correctAnswer: string | null;
      elaboration: string | null;
      isMcq: boolean;
      options: string[];
    };
  }>;
  notRetested: Array<{ patternName: string }>;
  patternsRetested: string[];
};

type TutorData =
  | {
      kind: "ineligible";
      reason: string;
      paperCount: number;
      childFirst?: string;
      childFullName?: string;
      subject?: string;
      topline?: Topline;
    }
  | {
      kind: "ready";
      childFirst: string;
      childFullName: string;
      subject: string;
      topline: Topline;
      commonMistakes: MistakeCard[];
      conceptualGaps: ConceptCard[];
      topicsForPractice: TopicCard[];
      generatedAt: string;
      stale: StaleInfo;
      previousAssessment: PreviousAssessmentDelta | null;
      weeklyDelta: WeeklyDelta | null;
    };

type LinkedStudent = { id: string; name: string; level?: number | null; hasDiagnosis?: boolean };

export default function TutorPage({ params }: { params: Promise<{ parentId: string }> }) {
  const { parentId } = use(params);
  return (
    <Suspense>
      <TutorContent parentId={parentId} />
    </Suspense>
  );
}

// Fetches + caches the per-student tutor data and renders loading /
// ineligible / ready states. Extracted so /progress/[studentId] (admin
// branch) can reuse the same body without duplicating the data wiring.
export function TutorBodyForStudent({ studentId, parentId, subject, currentChildName, postGreetingSlot }: {
  studentId: string;
  parentId: string;
  subject: string;
  currentChildName?: string;
  // Optional render slot for content that should sit BETWEEN the Lumi
  // greeting card and the progress chart / fluency table. Used by the
  // parent dashboard to inject the OnboardingBanner in that spot on a
  // ?onboarding=1 first-quiz landing. Rendered inside both IneligibleView
  // and ReadyView so the placement is identical whether the kid has
  // crossed the 3-paper eligibility threshold or not.
  postGreetingSlot?: React.ReactNode;
}) {
  const [data, setData] = useState<TutorData | null>(null);
  const [loading, setLoading] = useState(false);
  // Current paper count from the cheap /count endpoint. When it's
  // larger than data.topline.paperCount we surface a caveat banner so
  // the parent knows the cached diagnosis is from before the latest
  // quizzes were completed.
  const [currentPaperCount, setCurrentPaperCount] = useState<number | null>(null);
  // Progress data for the embedded per-topic chart inside ReadyView.
  // Prefetched HERE (in parallel with the tutor fetch) instead of
  // inside FullProgressEmbed's own mount-time useEffect — that removed
  // one waterfall tier off the Lumi load. Keyed on studentId/parentId
  // since the payload spans all subjects.
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [progressErr, setProgressErr] = useState(false);

  useEffect(() => {
    setProgress(null);
    setProgressErr(false);
    const ctrl = new AbortController();
    fetch(`/api/student-progress?parentId=${parentId}&studentId=${studentId}`, { signal: ctrl.signal })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d) setProgress(d as ProgressData);
        else setProgressErr(true);
      })
      .catch(err => { if (err?.name !== "AbortError") setProgressErr(true); });
    return () => ctrl.abort();
  }, [studentId, parentId]);

  useEffect(() => {
    // Clear `data` on every student / subject switch — the previous
    // payload's Common Mistakes / Conceptual Gaps cards otherwise stay
    // visible (under dimmed opacity) while the new fetch runs, which
    // reads as wrong content under the new heading (e.g. Jeremiah's
    // Math mistakes showing while the English tab is selected and
    // loading). Spinner is fine; stale content under a new heading
    // is not.
    //
    // Stale-response guard: if the parent switches student A → B
    // before A's fetch resolves, A's late response would otherwise
    // overwrite B's freshly-set data. We capture the (studentId,
    // subject) the effect was queued with and bail in the .then if
    // either has changed — and AbortController kills the in-flight
    // request entirely.
    setLoading(true);
    setData(null);
    setCurrentPaperCount(null);
    // Persistent cache keyed by (student, subject). Cache is good for
    // 5 days — short enough that a stale diagnosis self-corrects soon
    // after major new activity, long enough that day-to-day Lumi
    // visits don't re-trigger Gemini.
    //
    // The `v2` segment is a cache-bust token. Bump it whenever the
    // bundled diagnoses or the API response shape changes in a way
    // that old localStorage payloads should NOT be served — the new
    // key won't hit any pre-bump cache, and the prune step removes
    // every old `tutor-*` entry.
    const cacheKey = `tutor-v10-${studentId}-${subject}`;
    const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;
    const cachedRaw = typeof window !== "undefined" ? localStorage.getItem(cacheKey) : null;
    let cachedData: TutorData | null = null;
    if (cachedRaw) {
      try {
        const parsed = JSON.parse(cachedRaw) as TutorData;
        if (parsed.kind === "ready") {
          const ageMs = Date.now() - new Date(parsed.generatedAt).getTime();
          if (ageMs < FIVE_DAYS_MS) cachedData = parsed;
        } else if (parsed.kind === "ineligible") {
          // Don't cache the ineligible branch — kid may have just
          // completed their 3rd paper and we don't want to lock them
          // out for 5 days.
        }
      } catch { /* ignore */ }
    }
    if (cachedData) {
      setData(cachedData);
      setLoading(false);
      // Still hit the cheap count endpoint to compute the delta caveat.
      const ctrl = new AbortController();
      fetch(`/api/tutor/${studentId}/count?subject=${encodeURIComponent(subject)}`, { signal: ctrl.signal })
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (d && typeof d.paperCount === "number") setCurrentPaperCount(d.paperCount);
        })
        .catch(() => { /* silent */ });
      return () => ctrl.abort();
    }
    // `stale` flag flipped to true by the cleanup function (which
    // runs immediately on effect re-fire). The prior guard compared
    // `queuedFor.studentId === studentId` — but both were from the
    // SAME closure, so the comparison was always true. That meant a
    // late .finally() from an aborted-but-already-running fetch
    // would toggle setLoading(false) AFTER the new subject's effect
    // had set it to true — spinner disappeared, page went blank.
    let stale = false;
    const ctrl = new AbortController();
    fetch(`/api/tutor/${studentId}?subject=${encodeURIComponent(subject)}`, { signal: ctrl.signal })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (stale) return;
        if (d) {
          setData(d as TutorData);
          if ((d as TutorData).kind === "ready") {
            setCurrentPaperCount(((d as TutorData & { kind: "ready" }).topline.paperCount));
          }
          try {
            const slim = stripImagesForCache(d as TutorData);
            localStorage.setItem(cacheKey, JSON.stringify(slim));
            pruneOldTutorCacheKeys(cacheKey);
          } catch { /* quota — ignore */ }
        }
      })
      .catch(err => {
        if (err?.name !== "AbortError") console.warn("[tutor] fetch failed:", err);
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => { stale = true; ctrl.abort(); };
  }, [studentId, subject]);

  const paperDelta = (() => {
    if (!data || data.kind !== "ready" || currentPaperCount === null) return 0;
    return Math.max(0, currentPaperCount - data.topline.paperCount);
  })();

  const firstName = currentChildName?.split(/\s+/)[0] ?? "";
  // Show spinner ONLY when there's no prior payload to display — i.e.
  // on a true first paint. When the student/subject changes, keep the
  // previous render visible and dim it slightly so the user can see
  // the new payload swap in without a jarring flash, AND surface a
  // small floating loading pill so it's obvious something is happening.
  const showSpinner = loading && !data;
  const showSwitchPill = loading && !!data;
  return (
    <>
      {showSwitchPill && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[120] bg-[#003366] text-white text-sm font-bold px-4 py-2 rounded-full shadow-lg flex items-center gap-2 animate-fade-in">
          <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
          Loading Lumi…
        </div>
      )}
      {showSpinner && (
        <div className="flex flex-col items-center justify-center py-32 gap-6">
          <div className="w-16 h-16 rounded-full border-4 border-slate-100 border-t-[#003366] animate-spin" />
          <p className="text-sm font-medium text-slate-500">Loading Lumi…</p>
        </div>
      )}
      {data && data.kind === "ineligible" && (
        <IneligibleView data={data} subject={subject} loading={loading} studentId={studentId} postGreetingSlot={postGreetingSlot} />
      )}
      {data && data.kind === "ready" && (
        <div className={`transition-opacity ${loading ? "opacity-50" : ""}`}>
          {paperDelta > 0 && (
            <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Since this diagnosis, {firstName || "your child"} has done {paperDelta} more {subject.toLowerCase()} quiz{paperDelta === 1 ? "" : "zes"}. I&apos;ll update this when more data comes in.
            </div>
          )}
          <ReadyView data={data} parentId={parentId} studentId={studentId} prefetchedProgress={progress} prefetchedProgressErr={progressErr} postGreetingSlot={postGreetingSlot} />
        </div>
      )}
      <p className="text-[11px] text-slate-400 mt-12 text-center">
        {data && data.kind === "ready" && `Refreshed every 5 days. Last updated ${new Date(data.generatedAt).toLocaleString()}.`}
      </p>
    </>
  );
}

function TutorContent({ parentId }: { parentId: string }) {
  const searchParams = useSearchParams();
  const [students, setStudents] = useState<LinkedStudent[]>([]);
  const [studentId, setStudentId] = useState<string | null>(searchParams.get("studentId"));
  const [subject, setSubject] = useState<string>(searchParams.get("subject") ?? "Science");

  useEffect(() => {
    // Re-fetch on subject change so the admin list reflects who
    // qualifies in that subject (≥15 analysable wrongs), not just who
    // has a cached diagnosis.
    Promise.all([
      fetch(`/api/users?userId=${parentId}`).then(r => r.ok ? r.json() : null),
      fetch(`/api/tutor/admin-students?subject=${encodeURIComponent(subject)}`).then(r => r.ok ? r.json() : null),
    ]).then(([parentResp, adminResp]) => {
      const linked = (parentResp?.user?.linkedStudents as LinkedStudent[] | undefined) ?? [];
      const adminExtras = (adminResp?.students as LinkedStudent[] | undefined) ?? [];
      const merged = new Map<string, LinkedStudent>();
      for (const s of linked) if (s.id) merged.set(s.id, s);
      for (const s of adminExtras) if (s.id) merged.set(s.id, { ...merged.get(s.id), ...s });
      const list = [...merged.values()];
      setStudents(list);
      if (!studentId && list.length > 0) setStudentId(list[0].id);
    });
  }, [parentId, studentId, subject]);

  const currentChild = students.find(s => s.id === studentId);

  return (
    <div className="min-h-screen bg-[#f8f9ff]">
      <header className="border-b border-slate-100 bg-white">
        <div className="max-w-5xl mx-auto px-8 py-5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link href={`/home/${parentId}`} className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-slate-50 transition-colors">
              <span className="material-symbols-outlined text-[#001e40]">arrow_back</span>
            </Link>
            <div>
              <p className="text-xs text-slate-500 font-medium">Tutor</p>
              <h1 className="text-lg font-headline font-extrabold text-[#001e40]">
                {currentChild ? `${currentChild.name.split(/\s+/)[0]}'s ${subject}` : `${subject}`}
              </h1>
            </div>
          </div>
          <div className="flex gap-2 items-center">
            {students.length > 1 && (
              <select value={studentId ?? ""} onChange={e => setStudentId(e.target.value)} className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 bg-white">
                {students.map(s => {
                  const noDx = s.hasDiagnosis === false;
                  const level = s.level ? `P${s.level} ` : "";
                  return (
                    <option key={s.id} value={s.id}>
                      {level}{s.name}{noDx ? " — no diagnosis yet" : ""}
                    </option>
                  );
                })}
              </select>
            )}
            <select value={subject} onChange={e => setSubject(e.target.value)} className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 bg-white">
              <option>Science</option>
              <option>Math</option>
              <option>English</option>
              {/* Chinese intentionally omitted — no Chinese diagnoses
                  bundled yet; re-add when Chinese workshops ship. */}
            </select>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-8 py-10 hidden lg:block">
        {studentId && <TutorBodyForStudent studentId={studentId} parentId={parentId} subject={subject} currentChildName={currentChild?.name} />}
      </main>

      <main className="lg:hidden max-w-5xl mx-auto px-6 py-12 text-center">
        <p className="text-sm text-slate-500">Tutor is best viewed on a larger screen — please open this on a desktop or tablet.</p>
      </main>
    </div>
  );
}

// Shown when the kid has fewer than 3 papers. The bare "Not enough
// data yet" card was confusing parents — looked broken. Now we
// render the Lumi greeting + a small topic chart (whenever any
// papers exist) + a "need more data" banner so it's obvious things
// are working, just early.
function IneligibleView({
  data,
  subject,
  loading,
  studentId,
  postGreetingSlot,
}: {
  data: Extract<TutorData, { kind: "ineligible" }>;
  subject: string;
  loading: boolean;
  studentId: string;
  postGreetingSlot?: React.ReactNode;
}) {
  const topline = data.topline;
  const childFirst = data.childFirst;
  const remaining = Math.max(0, 3 - data.paperCount);
  // Same merge rule as the share-image chart so the on-screen chart
  // matches what'll get exported once the kid is eligible.
  const chartTopics = topline
    ? (() => {
        if (topline.allTopics && topline.allTopics.length > 0) {
          return topline.allTopics.map(t => ({ topic: t.topic, pct: t.pct }));
        }
        const seen = new Map<string, number>();
        for (const t of topline.strongTopics) seen.set(t.topic, t.pct);
        for (const t of topline.weakTopics) seen.set(t.topic, t.pct);
        return [...seen.entries()].map(([topic, pct]) => ({ topic, pct })).sort((a, b) => b.pct - a.pct);
      })()
    : [];
  return (
    <div className={`transition-opacity ${loading ? "opacity-50" : ""}`}>
      {/* Lumi greeting card — mirrors ReadyView's header so it doesn't
          feel like a different page when the kid crosses the 3-paper
          threshold. */}
      <section className="bg-white rounded-2xl border border-slate-200 shadow-sm px-6 sm:px-8 py-6 mb-6 flex flex-col items-center gap-4 md:flex-row md:items-start md:gap-6">
        <LumiAvatar />
        <div className="flex-1 w-full">
          <p className="text-[#001e40] text-base leading-relaxed">
            Hi! I&apos;m <strong>Lumi</strong>, your owl assistant <span className="text-[10px] uppercase tracking-wider font-bold text-violet-600 bg-violet-50 px-1.5 py-0.5 rounded">Beta</span>.
            {topline && childFirst && <> Here&apos;s where {childFirst} stands in {subject} so far.</>}
            {!topline && <> {data.reason}</>}
          </p>
          {topline && (
            <p className="text-sm text-[#001e40] mt-3">
              Average <strong>{topline.avgPct}%</strong> across <strong>{topline.paperCount}</strong> {subject.toLowerCase()} paper{topline.paperCount === 1 ? "" : "s"} ({topline.totalAwarded}/{topline.totalAvailable} marks).
            </p>
          )}
        </div>
      </section>

      {postGreetingSlot}

      {/* English Grammar + Synthesis sub-topic fluency table. Rendered
          ABOVE the Topic Accuracy chart on English — parents care
          about the rule-family breakdown more than the flat Grammar-MCQ
          vs Synthesis section split. GrammarRadar no-ops on non-English
          so the guard here is belt-and-braces. Use toLowerCase includes
          so the check accepts 'English' AND 'English Language'. */}
      {subject.toLowerCase().includes("english") && (
        <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 mb-6">
          <GrammarRadar studentId={studentId} subject={subject} childFirst={childFirst ?? "your child"} />
        </section>
      )}

      {/* Topic chart — only when we have at least one tagged topic
          worth showing. Mirrors LumiShareable's column-chart layout
          but rendered with CSS so it's interactive on screen. */}
      {chartTopics.length > 0 && topline && (
        <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 mb-6">
          <h3 className="text-sm font-bold text-[#001e40] mb-3">Topic Accuracy · average {topline.avgPct}%</h3>
          {(() => {
            const plotH = 200;
            // Same 110% headroom as the share-image chart so the "100%"
            // pct label has room above the column.
            const colMax = 110;
            const avgTopPx = plotH - (topline.avgPct / colMax) * plotH;
            return (
              <>
                <div style={{ position: "relative", height: plotH, borderBottom: "2px solid #0b1c30" }}>
                  <div style={{ position: "absolute", left: 0, right: 0, top: avgTopPx, borderTop: "2px dashed #003366", zIndex: 2 }} />
                  <div style={{ position: "absolute", left: 0, top: Math.max(0, avgTopPx - 22), fontSize: 11, fontWeight: 800, color: "#003366", backgroundColor: "#eff4ff", padding: "2px 6px", borderRadius: 4, zIndex: 3 }}>
                    Avg {topline.avgPct}%
                  </div>
                  <div style={{ display: "flex", height: plotH, gap: 12 }}>
                    {chartTopics.map((t) => {
                      const h = Math.max(2, (t.pct / colMax) * plotH);
                      // Match the share-PNG chart at line ~908: below
                      // the kid's own average → orange (attention), at
                      // or above → green. Anchoring on avgPct keeps the
                      // chart calibrated to THIS kid.
                      const barColor = t.pct < topline.avgPct ? "#ffb952" : "#006c49";
                      return (
                        // minWidth: 0 — without this, a flex item's default
                        // min-width: auto lets its content (the pct label,
                        // or the longest word in the topic) push the cell
                        // wider than its flex share. That desynchs the bar
                        // row from the label row when there are many topics
                        // (Science kids hit ~18), so labels drift right of
                        // their columns. Pinning to 0 forces flex: 1 to
                        // actually be 1.
                        <div key={t.topic} style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center", height: plotH }}>
                          <div style={{ fontSize: 12, fontWeight: 800, color: barColor, marginBottom: 4, lineHeight: 1 }}>{t.pct}%</div>
                          <div style={{ width: "70%", maxWidth: 64, height: h, backgroundColor: barColor, borderRadius: "6px 6px 0 0" }} />
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
                  {chartTopics.map((t) => (
                    <div key={t.topic} style={{ flex: 1, minWidth: 0, overflowWrap: "break-word", wordBreak: "break-word", fontSize: 11, fontWeight: 600, color: "#0b1c30", textAlign: "center", lineHeight: 1.3 }}>
                      {t.topic}
                    </div>
                  ))}
                </div>
              </>
            );
          })()}
        </section>
      )}

      {/* 'Need more data' banner removed 2026-07-02 — the Lumi
          greeting already communicates 'With 3 or more papers, I will
          be able to provide deeper personalised insights.' Repeating
          it below the topic chart read as noisy. */}

    </div>
  );
}

type DetailView =
  | { kind: "mistake"; index: number }
  | { kind: "concept"; index: number };

type LazyImage = { diagramImageData: string | null; imageData: string | null; optionImages: string[] | null };
type LazyImages = Record<string, LazyImage>;

function ReadyView({ data, parentId, studentId, prefetchedProgress, prefetchedProgressErr, postGreetingSlot }: { data: Extract<TutorData, { kind: "ready" }>; parentId: string; studentId: string; prefetchedProgress: ProgressData | null; prefetchedProgressErr: boolean; postGreetingSlot?: React.ReactNode }) {
  const [view, setView] = useState<DetailView | null>(null);
  const isOverview = view === null;
  // Lazy-load diagram + image-option blobs when the parent opens a
  // mistake / concept card. loadTutorData omits these from the base
  // payload (saves 400KB-1MB + 100-300ms on every Lumi visit); we hit
  // /api/tutor/[studentId]/diagrams once per card-open and cache the
  // result so a re-open is instant.
  const [lazyImages, setLazyImages] = useState<LazyImages>({});
  useEffect(() => {
    if (!view) return;
    const card = view.kind === "mistake"
      ? data.commonMistakes[view.index]
      : data.conceptualGaps[view.index];
    if (!card) return;
    const needed = card.examples
      .map(ex => ex.questionId)
      .filter((id): id is string => !!id && !lazyImages[id]);
    if (needed.length === 0) return;
    const ctrl = new AbortController();
    fetch(`/api/tutor/${studentId}/diagrams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionIds: needed }),
      signal: ctrl.signal,
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.diagrams) setLazyImages(prev => ({ ...prev, ...d.diagrams }));
      })
      .catch(err => { if (err?.name !== "AbortError") console.warn("[lumi] lazy-diagram fetch failed:", err); });
    return () => ctrl.abort();
  }, [view, data.commonMistakes, data.conceptualGaps, studentId, lazyImages]);
  const stageRef = useRef<HTMLDivElement>(null);
  // Share — html2canvas snapshots the hidden LumiShareable below into a
  // PNG, then either fires navigator.share (mobile) or falls back to a
  // direct download. Mirrors /progress/[studentId]'s share pattern.
  const shareRef = useRef<HTMLDivElement>(null);
  const [sharing, setSharing] = useState(false);
  const handleShare = useCallback(async () => {
    if (!shareRef.current) return;
    setSharing(true);
    // Hard outer timeout — fires no matter where the pipeline stalls
    // (dynamic import, image preload, html2canvas paint, toBlob,
    // navigator.share). Without this, an iOS Safari hang at ANY step
    // leaves the button frozen at "Preparing…" with no exit. 25s is
    // generous; a real render is ~2-4s on modern phones.
    const outerTimeout = setTimeout(() => {
      setSharing(false);
      alert("Sharing took too long and was cancelled. Please try again — if it keeps happening, reload the page first.");
    }, 25000);
    try {
      const html2canvas = (await import("html2canvas")).default;
      // (Image preload removed — the only <img> is the inline base64
      // Lumi data URI, which is rasterised synchronously when set as
      // src. The explicit preload Promise was hanging on iOS Safari
      // because complete/naturalWidth on data: URI imgs sometimes
      // never flips to true.)
      const canvas = await html2canvas(shareRef.current, {
        scale: 1.5, backgroundColor: "#ffffff", useCORS: true,
        logging: false,
        imageTimeout: 5000,
        width: shareRef.current.scrollWidth,
        height: shareRef.current.scrollHeight,
      });
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(b => resolve(b), "image/png"));
      if (!blob) {
        throw new Error("canvas.toBlob returned null — the snapshot couldn't be encoded.");
      }
      const safeName = (data.childFullName ?? "lumi").toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const file = new File([blob], `${safeName}-${data.subject.toLowerCase()}-lumi.png`, { type: "image/png" });
      // Always TRY navigator.share first when present — the canShare()
      // probe is flaky on some iOS Safari builds (returns false for
      // perfectly shareable files), and falling through to the
      // <a download> path on iOS just navigates to the blob URL since
      // Mobile Safari ignores the download attribute. Catch the
      // user-cancel AbortError separately so we don't treat it as a
      // real failure.
      let shareError: unknown = null;
      if (typeof navigator !== "undefined" && navigator.share) {
        try {
          await navigator.share({ title: `${data.childFullName} · Lumi · ${data.subject}`, files: [file] });
          return;
        } catch (e) {
          if ((e as Error)?.name === "AbortError") return; // user dismissed
          shareError = e;
        }
      }
      // Desktop / non-share-API fallback — direct download.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = file.name;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      if (shareError) console.warn("navigator.share failed; fell back to download:", shareError);
    } catch (e) {
      console.error("Lumi share failed:", e);
      const msg = (e as Error)?.message ?? String(e);
      alert(`Couldn't generate the Lumi image: ${msg}`);
    } finally {
      clearTimeout(outerTimeout);
      setSharing(false);
    }
  }, [data]);
  // When the swipe transitions in either direction, scroll the page
  // so the SWIPE STAGE sits right at the top of the viewport — that
  // way the detail panel's own heading ('Common Mistake · …', 'Conceptual
  // Gap · …') lands flush with the top instead of the user staring
  // at the empty top of the Lumi greeting card above. The -4 px nudge
  // accounts for sub-pixel layout so the section's rounded corner
  // doesn't peek above the fold.
  // Auto-scroll to keep the swipe stage flush with the top of the
  // viewport when the parent flips between Common Mistakes /
  // Conceptual Gaps — otherwise they'd land staring at the greeting
  // card while the actual content sits below the fold. Skip the
  // first mount so a fresh Lumi visit doesn't scroll past the
  // banner / greeting — the parent always starts at the top of the
  // page.
  const firstStageMountRef = useRef(true);
  useEffect(() => {
    if (typeof window === "undefined" || !stageRef.current) return;
    if (firstStageMountRef.current) { firstStageMountRef.current = false; return; }
    const top = stageRef.current.getBoundingClientRect().top + window.scrollY - 4;
    window.scrollTo({ top, behavior: "smooth" });
  }, [view]);
  return (
    <>
      {/* Lumi greeting — one continuous card. When a weeklyDelta is
          attached (last-week snapshot exists for this kid × subject),
          we render "Lumi's update this week" INLINE after the greeting
          and before the standing LumiSummary so the parent reads one
          long narrative instead of switching between cards. */}
      {/* Owl + greeting + this-week preface — kept tight so the parent
          can immediately see the "what changed this week" framing
          before scrolling into the analysis. Owl on the left only on
          md+; mobile stacks. The detailed analysis (LumiSummary +
          delta details + priorities + buttons) all lives full-width
          below, where it gets room to breathe. */}
      <section className="bg-white rounded-2xl border border-slate-200 shadow-sm px-6 sm:px-8 py-6 mb-6 flex flex-col items-center gap-4 md:flex-row md:items-start md:gap-6">
        <LumiAvatar />
        <div className="flex-1 w-full">
          <p className="text-[#001e40] text-base leading-relaxed">
            Hi! I&apos;m <strong>Lumi</strong>, your owl assistant <span className="text-[10px] uppercase tracking-wider font-bold text-violet-600 bg-violet-50 px-1.5 py-0.5 rounded">Beta</span>. Let&apos;s review {data.childFirst}&apos;s progress in {data.subject}.
          </p>
          {data.weeklyDelta && (
            <div className="mt-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] uppercase tracking-wider font-bold text-violet-700 bg-violet-100 px-2 py-0.5 rounded">Lumi&apos;s update this week</span>
              </div>
              <p className="text-[#001e40] text-sm leading-relaxed">{data.weeklyDelta.prefaceText}</p>
            </div>
          )}
        </div>
      </section>

      {/* Full-width summary block: standing narrative + the wins / topic-
          progress / new-mistakes detail cards lifted out of the old
          purple delta bar. Reads as one continuous Lumi report. */}
      <section className="bg-white rounded-2xl border border-slate-200 shadow-sm px-6 sm:px-8 py-6 mb-6">
        <LumiSummary data={data} studentId={studentId} parentId={parentId} />
        {data.weeklyDelta && (
          <WeeklyDeltaDetails delta={data.weeklyDelta} childFirst={data.childFirst} studentId={studentId} />
        )}
        {/* Share button sits at the bottom of the full-width summary
            so it lands once the parent has read the whole briefing. */}
        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={handleShare}
            disabled={sharing}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-full bg-[#003366] text-white text-sm font-bold shadow-sm hover:bg-[#001e40] disabled:opacity-60 transition-colors"
            title="Save or forward this Lumi report as an image"
          >
            <span className="material-symbols-outlined text-base">share</span>
            {sharing ? "Preparing…" : "Share Lumi"}
          </button>
        </div>
      </section>

      {postGreetingSlot}

      {/* Swipe stage — flex row holds both panels side-by-side; we
          translate the whole row by -100% to slide overview off
          screen left and bring the detail in from the right. */}
      <div ref={stageRef} className="overflow-hidden scroll-mt-4">
        <div className={`flex transition-transform duration-500 ease-out will-change-transform ${isOverview ? "translate-x-0" : "-translate-x-full"}`}>
          <div className="w-full shrink-0">
            <OverviewPanel data={data} parentId={parentId} studentId={studentId} onSelectMistake={(i) => setView({ kind: "mistake", index: i })} onSelectConcept={(i) => setView({ kind: "concept", index: i })} prefetchedProgress={prefetchedProgress} prefetchedProgressErr={prefetchedProgressErr} />
          </div>
          <div className="w-full shrink-0">
            {view !== null && <DetailPanel data={data} view={view} lazyImages={lazyImages} onBack={() => setView(null)} onGoToFocusedPractice={() => {
              setView(null);
              // Wait one tick for the overview to remount, then scroll
              // to the Topics for Practice section.
              setTimeout(() => {
                const el = document.getElementById("topics-section");
                if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
              }, 50);
            }} />}
          </div>
        </div>
      </div>

      {/* Hidden shareable Lumi report — html2canvas captures this off-
          screen DOM and returns a PNG. Inline styles only (Tailwind
          gets dropped during the html2canvas paint pass). */}
      <div style={{ position: "absolute", left: -9999, top: 0 }} aria-hidden>
        <LumiShareable ref={shareRef} data={data} />
      </div>

    </>
  );
}

// Helpers for inline-bold (**word**) and percent display.
function pctOfSubject(marksLost: number, totalAvailable: number): string {
  if (totalAvailable <= 0) return "";
  return `${Math.round((marksLost / totalAvailable) * 100)}%`;
}

// Soften the tone of cached Gemini text rendered to the parent.
// Older caches were written before the workshop prompt was updated to
// ask for warm, first-name phrasing; this rewrites the harshest stock
// phrases at render time so admins don't see "The student struggles
// to…" or "Ruthie misreads charts" until every kid's cache has been
// regenerated.
function softenTone(text: string, childFirst: string): string {
  if (!text) return text;
  const fn = childFirst.replace(/[^A-Za-z]/g, "");
  // Direct-claim verbs — when these follow the kid's first name without
  // already being qualified ("sometimes"/"often"/"occasionally"), prefix
  // "sometimes" so the line reads as a tendency rather than a label.
  // "Ruthie misreads charts" → "Ruthie sometimes misreads charts".
  const directVerbs = "misreads|misinterprets|misjudges|misapplies|misidentifies|confuses|conflates|ignores|forgets|skips|drops|reverses|stops|fails|loses|writes|gives|uses";
  const directVerbRe = new RegExp(`\\b(${fn})\\s+(?!(?:sometimes|often|occasionally|tends to|usually|may|might)\\b)(${directVerbs})\\b`, "g");
  // Even "often" reads heavier than the parent voice we want — bumped
  // down to "sometimes" specifically when it follows the kid's name
  // ("Kaiyangnggg often reverses…" → "Kaiyangnggg sometimes reverses…").
  const namedOftenRe = new RegExp(`\\b(${fn})\\s+often\\b`, "g");
  const out = text
    .replace(/\bThe student\b/g, fn)
    .replace(/\bthe student\b/g, fn.toLowerCase())
    .replace(directVerbRe, "$1 sometimes $2")
    .replace(namedOftenRe, "$1 sometimes")
    .replace(/\bstruggles to\b/gi, "sometimes finds it tricky to")
    .replace(/\bstruggles with\b/gi, "sometimes finds")
    .replace(/\bfails to\b/gi, "sometimes misses")
    .replace(/\bconsistently\b/gi, "sometimes")
    .replace(/\bcannot\b/gi, "doesn't always");
  // Some workshop patterns drop the subject entirely ("Often understands
  // what is happening…") — they read as floating verbs. Prepend the
  // kid's name when the opening isn't already them or a leading "the".
  // Lowercase the original first character so the joined sentence reads
  // as "Kaiyangnggg often understands…", not "Kaiyangnggg Often…".
  const trimmed = out.trimStart();
  const firstWordMatch = trimmed.match(/^(\S+)/);
  const firstWord = firstWordMatch?.[1] ?? "";
  const needsPrefix = firstWord !== fn && firstWord.toLowerCase() !== "the";
  if (!needsPrefix || trimmed.length === 0) return out;
  return `${fn} ${trimmed.charAt(0).toLowerCase()}${trimmed.slice(1)}`;
}

// Smooth-scroll helper for the (here) anchor links inside Lumi's
// action summary — keeps the URL clean (no #hash sticking around)
// and ensures the section animates into view from the long-scroll
// shell that the AdminProgressView lives in.
function scrollToSection(id: string) {
  return (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (typeof document === "undefined") return;
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };
}

// Lumi's structured action summary — bulleted briefing pulled from
// the cached diagnosis. Each bullet ends with a (here) link that
// jumps to the relevant section further down the page (mistakes /
// concepts / topics) so the admin can act on the headline without
// scrolling around to find the matching card.
// Internal admin-only gate for the personalised-quiz CTA. Limited to
// "Lumi's update this week" — the delta block surfacing wins, topic
// progress, new mistakes, and not-retested items since last Friday's
// snapshot. Renders ABOVE the standard LumiSummary so the parent's
// weekly visit leads with what changed. Driven by data.weeklyDelta
// (populated by loadTutorData when a lastweek snapshot exists).
type DeltaLazyImage = { diagramImageData: string | null; imageData: string | null; optionImages: string[] | null };

// Reusable MCQ-options-or-text renderer for the delta details panel.
// Mirrors the standing-report (commonMistakes) treatment so the parent
// sees a consistent layout: clean text options as a vertical list with
// picked/correct highlighting, image options as a 2×2 grid, OEQ falls
// back to the bare "wrote X" line.
function DeltaExampleBody({ ex, img, childFirst }: {
  ex: {
    isMcq: boolean;
    options: string[];
    studentAnswer: string | null;
    correctAnswer?: string | null;
  };
  img: DeltaLazyImage | undefined;
  childFirst: string;
}) {
  const studentNum = ex.studentAnswer ? (ex.studentAnswer.match(/\d+/)?.[0] ?? null) : null;
  const correctNum = ex.correctAnswer ? (ex.correctAnswer.match(/\d+/)?.[0] ?? null) : null;

  // Clean text-options MCQ — render full options list.
  if (ex.isMcq && ex.options.length > 0) {
    return (
      <div className="mt-2">
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Options</p>
        <div className="space-y-1">
          {ex.options.map((o, k) => {
            const num = String(k + 1);
            const isPicked = num === studentNum;
            const isCorrect = num === correctNum;
            const cls = isCorrect ? "bg-emerald-100 text-emerald-900" : isPicked ? "bg-rose-100 text-rose-900" : "bg-white text-slate-700";
            return (
              <div key={k} className={`px-2 py-1 rounded text-xs ${cls}`}>
                <strong>({num})</strong> {o}
                {isCorrect && <span className="text-[10px] font-bold ml-2">✓ correct</span>}
                {isPicked && !isCorrect && <span className="text-[10px] font-bold ml-2">✗ {childFirst} picked</span>}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Clean option-images MCQ — 2×2 grid with picked/correct rings.
  if (ex.isMcq && img?.optionImages && img.optionImages.length > 0) {
    return (
      <div className="mt-2">
        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1">Options</p>
        <div className="grid grid-cols-2 gap-2">
          {img.optionImages.map((o, k) => {
            if (!o) return null;
            const num = String(k + 1);
            const isPicked = num === studentNum;
            const isCorrect = num === correctNum;
            const ring = isCorrect ? "ring-2 ring-emerald-400 bg-emerald-50" : isPicked ? "ring-2 ring-rose-400 bg-rose-50" : "ring-1 ring-slate-200 bg-white";
            const src = o.startsWith("data:") ? o : `data:image/png;base64,${o}`;
            return (
              <div key={k} className={`p-2 rounded ${ring}`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] font-bold text-slate-700">({num})</span>
                  {isCorrect && <span className="text-[10px] font-bold text-emerald-700">✓</span>}
                  {isPicked && !isCorrect && <span className="text-[10px] font-bold text-rose-700">✗</span>}
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt={`Option ${num}`} className="w-full rounded" />
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // OEQ — fall back to the bare student-answer line.
  if (!ex.studentAnswer) return null;
  return (
    <p className="mt-2 whitespace-pre-wrap text-xs"><strong>{childFirst} wrote:</strong> {ex.studentAnswer.slice(0, 400)}{ex.studentAnswer.length > 400 ? "…" : ""}</p>
  );
}

function WeeklyDeltaDetails({ delta, childFirst, studentId }: { delta: NonNullable<Extract<TutorData, { kind: "ready" }>["weeklyDelta"]>; childFirst: string; studentId: string }) {
  // Lazy-fetched diagram + option images keyed by questionId. The
  // initial Lumi payload omits these blobs (they're 50KB-500KB each);
  // fetched on first "See details" expand via the same endpoint the
  // standing report uses.
  const [lazyImages, setLazyImages] = useState<Record<string, DeltaLazyImage>>({});
  const [openedIds, setOpenedIds] = useState<Set<string>>(() => new Set());
  const onDetailsToggle = useCallback((qid: string) => (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (!e.currentTarget.open) return; // ignore close
    if (openedIds.has(qid) || lazyImages[qid]) return;
    setOpenedIds(prev => { const next = new Set(prev); next.add(qid); return next; });
    fetch(`/api/tutor/${studentId}/diagrams`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questionIds: [qid] }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.diagrams) setLazyImages(prev => ({ ...prev, ...d.diagrams }));
      })
      .catch(err => console.warn("[lumi-delta] lazy diagram fetch failed:", err));
  }, [openedIds, lazyImages, studentId]);
  // Preface badge + prefaceText now live in the owl section above —
  // this component is JUST the structured detail cards (wins / topic
  // progress / new mistakes). Renders nothing when none of those are
  // present so the full-width LumiSummary section above stays tight.
  if (delta.wins.length === 0 && delta.topicProgress.length === 0 && delta.newMistakes.length === 0) {
    return null;
  }
  return (
    <div className="mt-6 pt-4 border-t border-slate-200">
      {delta.wins.length > 0 && (
        <div className="mb-5">
          <h3 className="text-sm font-bold text-emerald-700 mb-2">🎉 Wins this week</h3>
          <p className="text-sm text-emerald-800 mb-2">
            {childFirst} made progress on {delta.wins.length} common mistake{delta.wins.length === 1 ? "" : "s"} he used to make. Great job!
          </p>
          <ul className="space-y-2">
            {delta.wins.map((w, i) => (
              <li key={i} className="bg-emerald-50 border-l-4 border-emerald-500 rounded-r px-3 py-2">
                <div className="font-bold text-emerald-900 text-sm">{w.patternName}</div>
                <div className="text-xs text-slate-700 mt-1">
                  Example: {childFirst} answered Q{w.exampleHit.questionNum} of {w.exampleHit.paperTitle} correctly ({w.exampleHit.aw}/{w.exampleHit.av}).
                </div>
                <details className="mt-1" onToggle={onDetailsToggle(w.exampleHit.questionId)}>
                  <summary className="text-xs text-emerald-700 cursor-pointer font-semibold">See details</summary>
                  <div className="mt-2 bg-white rounded p-3 text-xs leading-relaxed">
                    <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                      {w.exampleHit.paperTitle} · Q{w.exampleHit.questionNum}
                      {w.exampleHit.topic ? ` · ${w.exampleHit.topic}` : ""}
                    </div>
                    <p className="mt-1 whitespace-pre-wrap"><strong>Question:</strong> {w.exampleHit.stem.slice(0, 600)}{w.exampleHit.stem.length > 600 ? "…" : ""}</p>
                    {(() => {
                      const img = lazyImages[w.exampleHit.questionId];
                      const isCleanMcq = w.exampleHit.isMcq && (w.exampleHit.options.length > 0 || !!img?.optionImages?.length);
                      // Clean-extract MCQ with no clean diagram → don't
                      // fall back to imageData (the full row crop). The
                      // clean question text + options list below already
                      // conveys everything; the row image is noise.
                      const diagram = img?.diagramImageData ?? (isCleanMcq ? null : img?.imageData ?? null);
                      return (
                        <>
                          {diagram && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={diagram.startsWith("data:") ? diagram : `data:image/png;base64,${diagram}`} alt="Question diagram" className="mt-2 max-w-full rounded border border-slate-200" />
                          )}
                          <DeltaExampleBody ex={w.exampleHit} img={img} childFirst={childFirst} />
                        </>
                      );
                    })()}
                    <p className="mt-2 text-emerald-700 font-bold">✓ {w.exampleHit.aw}/{w.exampleHit.av} marks</p>
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}

      {delta.topicProgress.length > 0 && (
        <div className="mb-5">
          <h3 className="text-sm font-bold text-emerald-700 mb-2">📈 Topic progress this week</h3>
          <ul className="space-y-2">
            {delta.topicProgress.map((tp, i) => (
              <li key={i} className="bg-emerald-50 border-l-4 border-emerald-500 rounded-r px-3 py-2">
                <div className="font-bold text-emerald-900 text-sm">{tp.topic}</div>
                <div className="text-xs text-slate-700 mt-1">
                  {childFirst} scored <strong>{tp.thisPct}%</strong> this week ({tp.attemptsThisWeek} questions) — up from his prior average of {tp.prevPct}% (<strong>+{tp.delta}pp</strong>). Nice work!
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {delta.newMistakes.length > 0 && (
        <div className="mb-3">
          <h3 className="text-sm font-bold text-orange-700 mb-2">Something new to keep an eye on</h3>
          <ul className="space-y-2">
            {delta.newMistakes.map((m, i) => (
              <li key={i} className="bg-orange-50 border-l-4 border-orange-400 rounded-r px-3 py-2">
                <div className="font-bold text-orange-900 text-sm">{m.patternName}</div>
                {m.patternWhat && <div className="text-xs text-slate-700 mt-1">{m.patternWhat}</div>}
                {m.exampleWrong && (
                  <div className="text-xs text-slate-700 mt-1">
                    Example: {childFirst} lost {m.exampleWrong.av - m.exampleWrong.aw}/{m.exampleWrong.av} marks on Q{m.exampleWrong.questionNum} of {m.exampleWrong.paperTitle}.
                  </div>
                )}
                {m.exampleWrong && (
                  <details className="mt-1" onToggle={onDetailsToggle(m.exampleWrong.questionId)}>
                    <summary className="text-xs text-orange-700 cursor-pointer font-semibold">See details</summary>
                    <div className="mt-2 bg-white rounded p-3 text-xs leading-relaxed">
                      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">
                        {m.exampleWrong.paperTitle} · Q{m.exampleWrong.questionNum}
                        {m.exampleWrong.topic ? ` · ${m.exampleWrong.topic}` : ""}
                      </div>
                      <p className="mt-1 whitespace-pre-wrap"><strong>Question:</strong> {m.exampleWrong.stem.slice(0, 600)}{m.exampleWrong.stem.length > 600 ? "…" : ""}</p>
                      {(() => {
                        const img = lazyImages[m.exampleWrong!.questionId];
                        const isCleanMcq = m.exampleWrong!.isMcq && (m.exampleWrong!.options.length > 0 || !!img?.optionImages?.length);
                        const diagram = img?.diagramImageData ?? (isCleanMcq ? null : img?.imageData ?? null);
                        return (
                          <>
                            {diagram && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={diagram.startsWith("data:") ? diagram : `data:image/png;base64,${diagram}`} alt="Question diagram" className="mt-2 max-w-full rounded border border-slate-200" />
                            )}
                            <DeltaExampleBody ex={m.exampleWrong!} img={img} childFirst={childFirst} />
                          </>
                        );
                      })()}
                      {m.exampleWrong.markingNotes && (
                        <p className="mt-2 text-slate-600 whitespace-pre-wrap"><strong>Marker:</strong> {m.exampleWrong.markingNotes.slice(0, 300)}{m.exampleWrong.markingNotes.length > 300 ? "…" : ""}</p>
                      )}
                      <p className="mt-2 text-rose-700 font-bold">✗ {m.exampleWrong.aw}/{m.exampleWrong.av} marks</p>
                      {m.patternAdvice && (
                        <div className="mt-3 pt-3 border-t border-slate-200">
                          <div className="text-[10px] uppercase tracking-wider text-orange-700 font-bold mb-1">What to look out for</div>
                          <div className="whitespace-pre-wrap text-slate-700">{m.patternAdvice}</div>
                        </div>
                      )}
                    </div>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// David Lim + Mark Lim while we shake down the Lumi-quiz endpoint;
// drop the Set and remove this hardcoding when we're ready to expose
// the CTA to all parents.
const LUMI_QUIZ_TEST_STUDENT_IDS = new Set([
  "cmm5wf91d000ryrxwaddlo6xh",  // David Lim
  "cmmbbyvs30004qa9yinn3drl6",  // Mark Lim (kid; admin@yunateach.com's student)
  "cmqg8upha0000l3ijfr3co6t8",  // student67 (combos cloned from David)
  "cmojzr4fu004gd4vnx8wmz6zk",  // Kaiyangnggg (P6, bespoke combos)
  "cmnk7dkkj006z14p6yf06ohzm",  // JeremiahSy (P5, bespoke combos)
  "cmmfmmnwy00fdbbbfgm7k3wpn",  // Emily lim (P4, bespoke combos)
]);

function LumiSummary({ data, studentId, parentId }: { data: Extract<TutorData, { kind: "ready" }>; studentId: string; parentId: string }) {
  const { childFirst, childFullName, topline, commonMistakes, conceptualGaps, subject } = data;
  const weak = topline.weakTopics[0];
  const m1 = commonMistakes[0];
  const m2 = commonMistakes[1];
  const concept = conceptualGaps[0];
  const avg = topline.avgPct;
  const status = avg >= 75 ? "good" : avg >= 60 ? "steady" : "tough";

  // Empty cache AND avg looks fine → fall back to the gentle note.
  // If avg < 80 with no diagnoses we still want to encourage daily
  // practice, so flow through to the full render below.
  if (!weak && !m1 && !concept && avg >= 80) {
    return (
      <p className="text-[#001e40] text-sm leading-relaxed mt-3">
        Not enough patterns yet — keep assigning practice and check back once {childFirst} has more papers marked.
      </p>
    );
  }

  const link = (id: string, label: string) => (
    <a href={`#${id}`} onClick={scrollToSection(id)} className="text-violet-700 font-semibold underline decoration-violet-300 hover:decoration-violet-700 underline-offset-2">
      {label}
    </a>
  );

  // The "Since the last check on X" banner was removed on 2026-06-17.
  // Parents reported it felt stale and confusing — Lumi should read as
  // a fresh assessment for today, not a delta against an opaque prior
  // run. The cached previousAssessment snapshot is still produced by
  // the workshop and left in the payload for the future weekly-review
  // work; just not rendered today.

  return (
    <div className="text-[#001e40] text-sm leading-relaxed mt-3 space-y-2.5">
      <p>
        {childFirst} is making <strong>{status}</strong> progress in {subject}. A few things to take note:
      </p>
      <ul className="space-y-2 list-disc pl-5">
        {avg < 80 && (
          <li>
            Daily quizzes are a good way to get more practices in a short and fun way for {childFirst}.
            Would you like me to set a 10 min MCQ quiz for {childFirst} the next few days? {link("daily-practices-section", "here")}.
            {(subject === "English" || subject === "Chinese") && <> I&apos;ll rotate the sections for the quiz.</>}
          </li>
        )}
        {weak && (
          <li>
            {childFirst}&apos;s weakest topic is <strong>{weak.topic}</strong> (avg. {weak.pct}%).
            A focused practice on this would help — pick this topic in the bar chart above to assign one,
            or jump to {link("topics-section", "Topics for Practice")} below.
          </li>
        )}
        {m1 && (
          <li>
            There are common trends in the mistakes. The biggest pattern is
            {" "}<strong>&ldquo;{m1.name}&rdquo;</strong> ({pctOfSubject(m1.marksLost, topline.totalAvailable)} pt lost)
            {m2 && <> and <strong>&ldquo;{m2.name}&rdquo;</strong> ({pctOfSubject(m2.marksLost, topline.totalAvailable)} pt lost)</>}.
            Let&apos;s go through these answering techniques with him {link("mistakes-section", "here")}.
          </li>
        )}
        {concept && (
          <li>
            I notice <strong>&ldquo;{concept.name}&rdquo;</strong> is a common conceptual mistake
            — that&apos;s {pctOfSubject(concept.marksLost, topline.totalAvailable)} pt lost on questions involving it.
            I have prepared a short explanation module {link("concepts-section", "here")}.
            We can walk through together, plus take a guided quiz.
          </li>
        )}
        {/* Top three priorities — purple action card. Personalised
            quizzes (combos) only populate for Science kids in the
            test gate; for everyone else the bar still shows with
            just the 3rd button (focused practice on the weakest
            non-overlapping topic, or daily quiz fallback). */}
        {(LUMI_QUIZ_TEST_STUDENT_IDS.has(studentId) && subject === "Science") || topline.weakTopics.length > 0 || m1 || concept ? (
          <li className="!list-none -ml-5 mt-2">
            <LumiQuizCombosCard
              studentId={studentId}
              childFirst={childFirst}
              childFullName={childFullName}
              parentId={parentId}
              totalAvailable={topline.totalAvailable}
              subject={subject}
              weakTopics={topline.weakTopics}
              hasPatterns={!!(m1 || concept)}
            />
          </li>
        ) : null}
      </ul>
    </div>
  );
}

// Renders the two Lumi-recommended combo quizzes for kids in the
// test gate. Each combo card has its label, rationale, and a
// Generate button that POSTs to /api/admin/lumi-quiz with the right
// comboIdx and navigates the parent to the quiz player.
// Below this many subject-wide marks of evidence, Lumi's combo
// rationale is shaky — a single quiz can swing weakest-topic / common-
// mistake rankings. Below the threshold we still offer the combos but
// also nudge the parent toward a daily quiz so Lumi has more signal
// next time. Keep in step with the gate in MEMORY.md
// (feedback_parent_dashboard_data_gates.md) — 100 is the floor we
// already use to suppress sparse-data panels elsewhere.
const LUMI_COMBO_SPARSE_DATA_THRESHOLD = 100;

// Spell-out small integers for the intro sentence — "two" reads
// nicer than "2" when the combo count is in prose.
function numWord(n: number): string {
  return ["zero", "one", "two", "three", "four", "five", "six"][n] ?? String(n);
}

function LumiQuizCombosCard({ studentId, childFirst, childFullName: _childFullName, parentId, totalAvailable, subject, weakTopics, hasPatterns }: { studentId: string; childFirst: string; childFullName: string; parentId: string; totalAvailable: number; subject: string; weakTopics: Array<{ topic: string; pct: number }>; hasPatterns: boolean }) {
  const router = useRouter();
  const [submittingIdx, setSubmittingIdx] = useState<number | null>(null);
  // Per-combo "generated" state — keyed by comboIdx. Stays set after
  // generate so the parent doesn't see the button revert and click
  // twice (each click would generate ANOTHER quiz for the kid).
  // Persisted to localStorage so a page refresh doesn't wipe the
  // state and silently invite a duplicate generate.
  const storageKey = `lumi-priorities:${studentId}:${subject.toLowerCase()}`;
  const [generatedIdxs, setGeneratedIdxs] = useState<Record<number, { paperId: string }>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(`${storageKey}:combos`);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });
  const [err, setErr] = useState<string | null>(null);

  // Persist combo state on every change.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try { window.localStorage.setItem(`${storageKey}:combos`, JSON.stringify(generatedIdxs)); } catch { /* ignore quota errors */ }
  }, [generatedIdxs, storageKey]);
  // Combo source: hand-written (richest) → auto-generated from
  // workshop cache (medium tier) → raw weakTopics derive (coarsest).
  // getDisplayCombosForKid encapsulates the tiered lookup. The "hand-
  // written" slot covers both genuinely hand-written entries AND auto-
  // generated ones from the workshop cache — both have the same shape
  // (LumiQuizCombo or LumiEnglishQuizCombo) and click through to the
  // lumi-quiz picker. The "derived" slot is the no-cache fallback
  // (label = topic name only, click → /api/focused-test).
  const { handwritten: combos, derived: derivedCombos } = getDisplayCombosForKid(
    studentId,
    subject,
    weakTopics,
  );
  const hasCombos = combos.length > 0 || derivedCombos.length > 0;

  // 3rd-button picker — pick the weakest topic NOT already targeted
  // by either combo (hand-written OR derived). Falls back to a daily
  // quiz CTA when every weak topic is already covered.
  const comboTopicSet = new Set([
    ...combos.map(c => c.topic.toLowerCase()),
    ...derivedCombos.map(c => c.topic.toLowerCase()),
  ]);
  const fallbackTopic = weakTopics.find(wt => !comboTopicSet.has(wt.topic.toLowerCase())) ?? null;

  async function handleGenerate(idx: number) {
    setSubmittingIdx(idx);
    setErr(null);
    try {
      // Respect the combo's own count when set — English Synthesis
      // combos request 6 Qs (shorter quiz), Grammar/Vocab MCQ request
      // 10. Science combos don't carry a count field; fall back to 10.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const desiredCount = (combos[idx] as any)?.count ?? 10;
      const r = await fetch("/api/admin/lumi-quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId, subject: subject.toLowerCase(), comboIdx: idx, count: desiredCount }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.paperId) {
        throw new Error(data?.error ?? data?.detail ?? `failed (${r.status})`);
      }
      setGeneratedIdxs(prev => ({ ...prev, [idx]: { paperId: data.paperId } }));
      setSubmittingIdx(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Generate failed");
      setSubmittingIdx(null);
    }
  }

  // Generation in-flight states for the 3rd button. Mirrors the
  // submittingIdx pattern combos use above + persists across
  // refreshes via localStorage.
  const [thirdSubmitting, setThirdSubmitting] = useState(false);
  const [thirdReady, setThirdReady] = useState<{ paperId: string } | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(`${storageKey}:third`);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (thirdReady) window.localStorage.setItem(`${storageKey}:third`, JSON.stringify(thirdReady));
      else window.localStorage.removeItem(`${storageKey}:third`);
    } catch { /* ignore */ }
  }, [thirdReady, storageKey]);

  // Auto-generate the focused practice + navigate the parent straight
  // to the quiz player. Previously this button bounced to the parent
  // home with the modal pre-filled — but the modal was redundant
  // friction; we already know the subject + topic + kid.
  async function handleGenerateFocusedPractice() {
    if (!fallbackTopic || thirdSubmitting) return;
    setThirdSubmitting(true);
    setErr(null);
    try {
      // Math is "Mathematics" in the focused-test API's subject
      // taxonomy; everything else matches as-is.
      const apiSubject = subject === "Math" ? "Mathematics" : subject;
      const r = await fetch("/api/focused-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentId, studentId, subject: apiSubject, topic: fallbackTopic.topic }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.id) throw new Error(j?.error ?? `failed (${r.status})`);
      setThirdReady({ paperId: j.id });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Generate failed");
    } finally {
      setThirdSubmitting(false);
    }
  }

  // Derived combos click the same focused-test API as the 3rd button
  // (kids without hand-written combos don't have lumi-quiz comboIdx to
  // index into). Each combo gets its own slot in generatedIdxs so the
  // state survives refresh + matches the hand-written combo pattern.
  async function handleGenerateDerived(idx: number, topic: string) {
    setSubmittingIdx(idx);
    setErr(null);
    try {
      const apiSubject = subject === "Math" ? "Mathematics" : subject;
      const r = await fetch("/api/focused-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentId, studentId, subject: apiSubject, topic }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.id) throw new Error(j?.error ?? `failed (${r.status})`);
      setGeneratedIdxs(prev => ({ ...prev, [idx]: { paperId: j.id } }));
      setSubmittingIdx(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Generate failed");
      setSubmittingIdx(null);
    }
  }

  // Daily quiz auto-generate — same idea. Math/Science use the
  // simple MCQ body; English/Chinese need section selection so we
  // fall back to scrolling the parent into the existing daily-
  // practices picker for those.
  async function handleGenerateDailyQuiz() {
    if (thirdSubmitting) return;
    const subjLower = subject.toLowerCase();
    if (subjLower === "english" || subjLower === "chinese") {
      const el = document.getElementById("daily-practices-section");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      else router.push(`/home/${parentId}?student=${studentId}`);
      return;
    }
    setThirdSubmitting(true);
    setErr(null);
    try {
      const r = await fetch("/api/daily-quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: parentId, studentId, quizType: "mcq", subject: subjLower }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.id) throw new Error(j?.error ?? `failed (${r.status})`);
      setThirdReady({ paperId: j.id });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Generate failed");
    } finally {
      setThirdSubmitting(false);
    }
  }

  const thirdSentence = fallbackTopic
    ? <>Third, do a <strong>focused practice on {fallbackTopic.topic}</strong> to strengthen {childFirst}&apos;s knowledge on a topic not already covered above.</>
    : <>Third, do a <strong>daily quiz</strong> to refresh {childFirst}&apos;s concepts across topics.</>;

  // For the "personalised quizzes" prose line: pull a friendly topic-
  // area name (e.g. "grammar", "synthesis") + the top sub-topics from
  // the combos. Lets the prose call out specifics — "(grammar and
  // synthesis) ... (pronouns, tag questions, reported speech)" —
  // instead of a generic "where X struggles with a pattern".
  const topicAreaName = (topic: string): string => {
    if (topic === "Grammar MCQ") return "grammar";
    if (topic === "Vocabulary MCQ") return "vocabulary";
    if (topic === "Synthesis / Transformation") return "synthesis";
    return topic.toLowerCase();
  };
  const subTopicFriendly = (sub: string): string => {
    const map: Record<string, string> = {
      "pronouns": "pronouns",
      "tag-questions": "tag questions",
      "countable/uncountable": "countable/uncountable",
      "reported-speech": "reported speech",
      "correlative-preference": "both/either/neither",
      "subordinator": "joining with because/although",
      "noun-phrase": "verb→noun",
      "subject-verb-agreement": "subject-verb",
      "idiomatic-prepositions": "prepositions",
      "verb-forms": "gerund/infinitive",
      "connectors-tenses": "connectors + tenses",
      "food-web-explaining": "food web",
      "adaptation": "adaptation",
      "vision-and-reflection": "vision + reflection",
      "magnetic-properties-and-principles": "magnetism",
      "applying-force-concepts": "applying forces",
      "identifying-and-representing-forces": "naming forces",
      "gravitational-potential-to-kinetic": "PE → KE",
      "heat-transfer-and-materials": "heat transfer",
      "properties-of-matter": "properties of matter",
      "causal-chain": "causal chain",
      "shadow-formation-and-properties": "shadows",
    };
    return map[sub] ?? sub.replace(/-/g, " ");
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const comboTopicAreas = [...new Set(combos.slice(0, 2).map((c: any) => topicAreaName(c.topic)))];
  const topicAreaStr = comboTopicAreas.length === 0 ? ""
    : comboTopicAreas.length === 1 ? comboTopicAreas[0]
    : comboTopicAreas.length === 2 ? `${comboTopicAreas[0]} and ${comboTopicAreas[1]}`
    : `${comboTopicAreas.slice(0, -1).join(", ")} and ${comboTopicAreas.slice(-1)[0]}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const comboSubTopics = [...new Set(combos.slice(0, 2).flatMap((c: any) => Object.keys(c.subTopicWeights ?? {})))]
    .slice(0, 4)
    .map(subTopicFriendly);

  return (
    <div className="rounded-xl border-2 border-purple-200 bg-gradient-to-br from-purple-50 to-white p-4 space-y-3">
      <h3 className="font-bold text-[#001e40] text-base">Top three priorities for this week</h3>
      <div className="text-[#001e40] text-sm leading-relaxed space-y-2.5">
        {hasPatterns && (
          <p>
            First, walk through the <strong>common mistakes and conceptual gaps</strong> with {childFirst} — those are the patterns Lumi keeps seeing.
          </p>
        )}
        {hasCombos && (
          <p>
            Then, take the <strong>two personalised quizzes Lumi has hand-crafted for {childFirst}</strong> below. Each one pairs a <strong>subtopic</strong>
            {topicAreaStr && (
              <> (
                {comboTopicAreas.map((t, i) => (
                  <span key={t}>
                    {i > 0 && (i === comboTopicAreas.length - 1 ? " and " : ", ")}
                    <strong className="text-purple-700">{t}</strong>
                  </span>
                ))}
              )</>
            )}
            {" "}where {childFirst} struggles with a <strong>common-mistakes pattern</strong>
            {comboSubTopics.length > 0 && (
              <> (
                {comboSubTopics.map((s, i) => (
                  <span key={s}>
                    {i > 0 && ", "}
                    <strong className="text-purple-700">{s}</strong>
                  </span>
                ))}
              )</>
            )}
            , and starts with a short guide and some tips.
          </p>
        )}
        <p>{thirdSentence}</p>
      </div>

      {/* Horizontal 3-button row — combos take 2 cols when present,
          3rd button auto-stretches to fill the remaining col(s).
          Dark backgrounds make the actions pop off the purple card
          so the parent's eye lands on them before reading the prose
          above. Personalised = deep purple · Ready = deep emerald ·
          Focused / Daily = deep teal. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {combos.slice(0, 2).map((c, i) => {
          const done = generatedIdxs[i];
          if (done) {
            return (
              <div key={`combo-${i}`} className="relative">
                <a
                  href={`/quiz/${done.paperId}?userId=${studentId}`}
                  className="block rounded-xl bg-emerald-700 hover:bg-emerald-800 px-4 py-3.5 text-center transition-colors shadow-md ring-2 ring-emerald-900/10"
                >
                  <div className="text-[10px] uppercase tracking-wider font-bold text-emerald-200">Quiz {i + 1} ready</div>
                  <div className="text-sm font-bold text-white mt-0.5 line-clamp-2">{c.label}</div>
                  <div className="text-xs text-emerald-200 mt-1 font-semibold">Open quiz →</div>
                </a>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setGeneratedIdxs(prev => { const next = { ...prev }; delete next[i]; return next; }); }}
                  title="Discard this quiz and regenerate"
                  className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-emerald-900/40 hover:bg-emerald-900/60 text-white text-xs font-bold flex items-center justify-center"
                  aria-label="Regenerate"
                >↻</button>
              </div>
            );
          }
          const busy = submittingIdx === i;
          return (
            <button
              key={`combo-${i}`}
              type="button"
              onClick={() => handleGenerate(i)}
              disabled={submittingIdx !== null}
              className="rounded-xl bg-purple-700 hover:bg-purple-800 px-4 py-3.5 text-left transition-colors shadow-md ring-2 ring-purple-900/10 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <div className="text-sm uppercase tracking-wider font-bold text-white">Personalised quiz {i + 1}</div>
              <div className="text-sm font-bold text-white mt-0.5 line-clamp-2">{c.label}</div>
              <div className="text-xs text-purple-200 mt-1 font-semibold flex items-center gap-1.5">
                {busy && (
                  <svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                )}
                {busy ? "Generating…" : "Generate quiz →"}
              </div>
            </button>
          );
        })}
        {/* Derived combos take the same purple slot as hand-written
            combos. Only rendered when no hand-written combos exist
            (the two arrays are mutually exclusive above). Click calls
            /api/focused-test directly so it works without a
            corresponding lumi-quiz hand-written entry. */}
        {derivedCombos.slice(0, 2).map((c, i) => {
          const done = generatedIdxs[i];
          if (done) {
            return (
              <div key={`derived-${i}`} className="relative">
                <a
                  href={`/quiz/${done.paperId}?userId=${studentId}`}
                  className="block rounded-xl bg-emerald-700 hover:bg-emerald-800 px-4 py-3.5 text-center transition-colors shadow-md ring-2 ring-emerald-900/10"
                >
                  <div className="text-[10px] uppercase tracking-wider font-bold text-emerald-200">Quiz {i + 1} ready</div>
                  <div className="text-sm font-bold text-white mt-0.5 line-clamp-2">{c.label}</div>
                  <div className="text-xs text-emerald-200 mt-1 font-semibold">Open quiz →</div>
                </a>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setGeneratedIdxs(prev => { const next = { ...prev }; delete next[i]; return next; }); }}
                  title="Discard this quiz and regenerate"
                  className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-emerald-900/40 hover:bg-emerald-900/60 text-white text-xs font-bold flex items-center justify-center"
                  aria-label="Regenerate"
                >↻</button>
              </div>
            );
          }
          const busy = submittingIdx === i;
          return (
            <button
              key={`derived-${i}`}
              type="button"
              onClick={() => handleGenerateDerived(i, c.topic)}
              disabled={submittingIdx !== null}
              className="rounded-xl bg-purple-700 hover:bg-purple-800 px-4 py-3.5 text-left transition-colors shadow-md ring-2 ring-purple-900/10 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <div className="text-sm uppercase tracking-wider font-bold text-white">Personalised quiz {i + 1}</div>
              <div className="text-sm font-bold text-white mt-0.5 line-clamp-2">{c.topic}</div>
              <div className="text-xs text-purple-200 mt-1 font-semibold flex items-center gap-1.5">
                {busy && (
                  <svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                )}
                {busy ? "Generating…" : "Generate quiz →"}
              </div>
            </button>
          );
        })}
        {thirdReady ? (
          // Already generated — same green "ready" treatment as the
          // combo buttons. Clicking opens the quiz directly.
          <div className={`relative ${hasCombos ? "" : "sm:col-span-3"}`}>
            <a
              href={`/quiz/${thirdReady.paperId}?userId=${studentId}`}
              className="block rounded-xl bg-emerald-700 hover:bg-emerald-800 px-4 py-3.5 text-center transition-colors shadow-md ring-2 ring-emerald-900/10"
            >
              <div className="text-[10px] uppercase tracking-wider font-bold text-emerald-200">{fallbackTopic ? "Focused practice ready" : "Daily quiz ready"}</div>
              <div className="text-sm font-bold text-white mt-0.5 line-clamp-2">{fallbackTopic?.topic ?? "10-min MCQ refresh"}</div>
              <div className="text-xs text-emerald-200 mt-1 font-semibold">Open quiz →</div>
            </a>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setThirdReady(null); }}
              title="Discard this quiz and regenerate"
              className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-emerald-900/40 hover:bg-emerald-900/60 text-white text-xs font-bold flex items-center justify-center"
              aria-label="Regenerate"
            >↻</button>
          </div>
        ) : fallbackTopic ? (
          <button
            type="button"
            onClick={handleGenerateFocusedPractice}
            disabled={thirdSubmitting}
            className={`rounded-xl bg-teal-700 hover:bg-teal-800 px-4 py-3.5 text-left transition-colors shadow-md ring-2 ring-teal-900/10 disabled:opacity-60 disabled:cursor-not-allowed ${hasCombos ? "" : "sm:col-span-3"}`}
          >
            <div className="text-[10px] uppercase tracking-wider font-bold text-teal-200">Focused practice</div>
            <div className="text-sm font-bold text-white mt-0.5 line-clamp-2">{fallbackTopic.topic}</div>
            <div className="text-xs text-teal-200 mt-1 font-semibold flex items-center gap-1.5">
              {thirdSubmitting && (
                <svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              )}
              {thirdSubmitting ? "Generating…" : "Generate quiz →"}
            </div>
          </button>
        ) : (
          <button
            type="button"
            onClick={handleGenerateDailyQuiz}
            disabled={thirdSubmitting}
            className={`rounded-xl bg-teal-700 hover:bg-teal-800 px-4 py-3.5 text-left transition-colors shadow-md ring-2 ring-teal-900/10 disabled:opacity-60 disabled:cursor-not-allowed ${hasCombos ? "" : "sm:col-span-3"}`}
          >
            <div className="text-[10px] uppercase tracking-wider font-bold text-teal-200">Daily quiz</div>
            <div className="text-sm font-bold text-white mt-0.5">A 10-min MCQ refresh</div>
            <div className="text-xs text-teal-200 mt-1 font-semibold flex items-center gap-1.5">
              {thirdSubmitting && (
                <svg className="animate-spin w-3.5 h-3.5" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              )}
              {thirdSubmitting ? "Generating…" : "Generate quiz →"}
            </div>
          </button>
        )}
      </div>

      {hasCombos && totalAvailable < LUMI_COMBO_SPARSE_DATA_THRESHOLD && (
        <p className="text-xs text-[#43474f] leading-relaxed border-t border-purple-100 pt-3">
          <span className="font-bold text-[#001e40]">Light on data so far</span> ({totalAvailable} marks).
          The personalised quizzes use whatever pattern signal Lumi can see — keep the daily quizzes going so Lumi has more to work with next time.
        </p>
      )}
      {err && <p className="text-xs text-red-600">{err}</p>}
    </div>
  );
}
function boldifyHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

// Cached Gemini diagnosis text quotes key science / math terms in
// single or double quotes (e.g. "missed the specific energy keywords:
// 'gravitational potential energy' converting to 'kinetic energy'.").
// The workshop prompt doesn't wrap them in **markdown** explicitly, so
// they reach the renderer as plain quotes — and the parent loses the
// at-a-glance emphasis. Convert any 2+-character quoted phrase to
// **bold** before boldifyHtml. 2-char minimum + closing-quote
// requirement skips contractions (don't, can't) and stray quotes.
function emphasiseQuoted(s: string): string {
  if (!s) return s;
  return s
    .replace(/"([^"]{2,}?)"/g, "**$1**")
    // Single-quote variant: opening ' must be preceded by start-of-string
    // or whitespace (not by a letter — otherwise we'd match the apostrophe
    // inside "doesn't" / "She's" / "won't"). Closing ' must be followed
    // by whitespace, punctuation, or end-of-string (lookahead, so we don't
    // consume the trailing character). Pre-2026-06-17 the bare regex
    // mangled passages with multiple contractions — e.g. David's English
    // pattern 4 advice rendered "doesn**t she" because the regex was
    // matching across "doesn't she".
    .replace(/(^|\s)'([^'\n]{2,}?)'(?=\s|[.,!?;:)]|$)/g, "$1**$2**");
}

// A4-portrait Lumi report for offscreen html2canvas capture. Inline
// styles only — Tailwind classes are dropped during the html2canvas
// paint pass. Contains everything the parent needs to save / forward
// the diagnosis as a single image: Lumi photo top-left, child + subject
// banner, summary, topic column chart with the kid's average line,
// common mistakes and conceptual gaps cards (each with Lumi's advice
// or explanation), markforyou.com brand strip. NO action buttons —
// purely a static snapshot.
const LumiShareable = forwardRef<HTMLDivElement, { data: Extract<TutorData, { kind: "ready" }> }>(
  function LumiShareable({ data }, ref) {
    const { childFullName, childFirst, subject, topline, commonMistakes, conceptualGaps } = data;
    const status = topline.avgPct >= 75 ? "good" : topline.avgPct >= 60 ? "steady" : "tough";
    const statusColor = topline.avgPct >= 75 ? "#006c49" : topline.avgPct >= 60 ? "#d58d00" : "#ba1a1a";
    const sectionTitleStyle = { fontSize: 13, fontWeight: 800, color: "#7c3aed", textTransform: "uppercase" as const, letterSpacing: 1, marginBottom: 12 };

    // Column-chart topic list — prefer the full allTopics array so
    // the share image carries every topic the kid has ≥3 attempts
    // on, matching the on-screen progress chart. Falls back to the
    // strong+weak+practice merge for cached payloads from before
    // allTopics shipped.
    const chartTopics = (() => {
      if (topline.allTopics && topline.allTopics.length > 0) {
        return topline.allTopics.map(t => ({ topic: t.topic, pct: t.pct }));
      }
      const seen = new Map<string, number>();
      for (const t of topline.strongTopics) seen.set(t.topic, t.pct);
      for (const t of topline.weakTopics) seen.set(t.topic, t.pct);
      for (const t of data.topicsForPractice) if (!seen.has(t.topic)) seen.set(t.topic, t.pct);
      return [...seen.entries()].map(([topic, pct]) => ({ topic, pct })).sort((a, b) => b.pct - a.pct);
    })();

    return (
      <div ref={ref} style={{ width: 900, padding: 48, fontFamily: "'Inter', system-ui, sans-serif", backgroundColor: "#ffffff", color: "#1e293b" }}>
        {/* Header: Lumi photo top-left + name/subject right + brand. */}
        <div style={{ display: "flex", alignItems: "center", gap: 20, marginBottom: 28, paddingBottom: 20, borderBottom: "3px solid #001e40" }}>
          {/* Lumi photo as an inline base64 data URI (see
              src/lib/lumi-data-uri.ts). /avatars/* is 308-redirected
              to R2 in prod and the bucket either lacks the file or
              doesn't return CORS headers — html2canvas then rendered
              a blank disc. Embedding bypasses redirect + CORS in one
              go and is small enough (~84 KB base64) to ship in code. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={LUMI_DATA_URI}
            alt="Lumi"
            width={96}
            height={96}
            // No border / background — lumi1.png already has a circle
            // baked in, so a second outline rendered a double-ring.
            style={{ width: 96, height: 96, objectFit: "cover", flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "#7c3aed", textTransform: "uppercase", letterSpacing: 1.5 }}>Lumi</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: "#001e40", marginTop: 4, lineHeight: 1.2 }}>{childFullName}&rsquo;s {subject} Progress</div>
            <div style={{ fontSize: 13, color: "#737780", marginTop: 6 }}>
              Generated {new Date().toLocaleDateString("en-SG", { day: "numeric", month: "long", year: "numeric" })} · <strong style={{ color: "#001e40" }}>www.markforyou.com</strong>
            </div>
          </div>
        </div>

        {/* Summary */}
        <div style={{ marginBottom: 28 }}>
          <div style={sectionTitleStyle}>Summary</div>
          <div style={{ fontSize: 16, color: "#0b1c30", lineHeight: 1.65 }}>
            {childFirst} is making <strong style={{ color: statusColor }}>{status}</strong> progress in {subject}.
            {" "}Average <strong>{topline.avgPct}%</strong> across <strong>{topline.paperCount}</strong> paper{topline.paperCount === 1 ? "" : "s"} ({topline.totalAwarded}/{topline.totalAvailable} marks).
          </div>
          {topline.strongTopics.length > 0 && (
            <div style={{ fontSize: 14, color: "#0b1c30", lineHeight: 1.6, marginTop: 8 }}>
              <span style={{ fontWeight: 700, color: "#006c49" }}>Strong in: </span>
              {topline.strongTopics.map(t => `${t.topic} (avg. ${t.pct}%)`).join(", ")}
            </div>
          )}
          {topline.weakTopics.length > 0 && (
            <div style={{ fontSize: 14, color: "#0b1c30", lineHeight: 1.6, marginTop: 4 }}>
              <span style={{ fontWeight: 700, color: "#ba1a1a" }}>Watch areas: </span>
              {topline.weakTopics.map(t => `${t.topic} (avg. ${t.pct}%)`).join(", ")}
            </div>
          )}
        </div>

        {/* Column chart with average line drawn as a single overlay
            strip spanning the full plot area. Plot height = 220 px,
            label band on top + topic labels below, leaving the
            average line free to land at the exact avg% mark across
            every column at once. */}
        {chartTopics.length > 0 && (() => {
          const plotH = 220;
          // Scale columns against 110 instead of 100 so a 100% topic
          // still leaves ~10% headroom for its "100%" label — without
          // this the label collided with (or overflowed above) the
          // plot's top edge.
          const colMax = 110;
          // y from top where the avg line sits (CSS top:)
          const avgTopPx = plotH - (topline.avgPct / colMax) * plotH;
          return (
            <div style={{ marginBottom: 28 }}>
              <div style={sectionTitleStyle}>Topic Accuracy · child&rsquo;s average {topline.avgPct}%</div>
              {/* Plot area — relative container so the avg line can
                  span all columns. Columns are a flex row inside. */}
              <div style={{ position: "relative", height: plotH, borderBottom: "2px solid #0b1c30" }}>
                {/* Average horizontal line + label pill */}
                <div style={{ position: "absolute", left: 0, right: 0, top: avgTopPx, borderTop: "2px dashed #003366", zIndex: 2 }} />
                <div style={{ position: "absolute", left: 0, top: Math.max(0, avgTopPx - 22), fontSize: 11, fontWeight: 800, color: "#003366", backgroundColor: "#eff4ff", padding: "2px 6px", borderRadius: 4, zIndex: 3 }}>
                  Avg {topline.avgPct}%
                </div>
                {/* Columns row */}
                <div style={{ display: "flex", height: plotH, gap: 16 }}>
                  {chartTopics.map(t => {
                    const h = Math.max(2, (t.pct / colMax) * plotH);
                    // Below the kid's own average → yellow (attention).
                    // At or above the average → green (doing well).
                    // Anchoring on avgPct rather than fixed 75 / 40
                    // thresholds keeps the chart calibrated to THIS kid:
                    // a strong kid's "below avg" still reads as weak,
                    // a struggling kid's "above avg" still reads as strong.
                    const barColor = t.pct < topline.avgPct ? "#ffb952" : "#006c49";
                    return (
                      // minWidth: 0 — see the on-screen chart above for the
                      // explanation. Without this, long topic names in the
                      // label row push their cells past their flex share,
                      // so the labels drift right of the columns they're
                      // supposed to belong to (Science kids hit ~18 topics).
                      <div key={t.topic} style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center", height: plotH }}>
                        <div style={{ fontSize: 12, fontWeight: 800, color: barColor, marginBottom: 12, lineHeight: 1 }}>{t.pct}%</div>
                        <div style={{ width: "70%", maxWidth: 72, height: h, backgroundColor: barColor, borderRadius: "6px 6px 0 0" }} />
                      </div>
                    );
                  })}
                </div>
              </div>
              {/* Topic labels — separate row below the plot so they
                  don't compete with the bar / pct positioning.
                  Science gets vertical labels (read bottom-to-top, CCW)
                  because Science kids surface up to ~18 topics with
                  long names like "Interaction of forces (Frictional…)" —
                  horizontal labels at 1/18 column width wrap to 5-6 tiny
                  lines and become unreadable. Other subjects keep the
                  horizontal layout. */}
              {(() => {
                const isScience = subject.toLowerCase() === "science";
                if (isScience) {
                  // Pre-rotation text width budget: 160px at fontSize 9
                  // gives ~32 chars per line, so a 60-65 char topic wraps
                  // to 2 lines and an 80-char one wraps to 3. Whatever
                  // the line count, the rotated VISUAL height is bounded
                  // by this budget (the longest line) — so we set the
                  // label band height to match and reserve a tiny extra
                  // for padding.
                  const PRE_ROTATE_WIDTH = 160;
                  const labelBandH = PRE_ROTATE_WIDTH + 8;
                  return (
                    <div style={{ display: "flex", gap: 16, marginTop: 8, height: labelBandH }}>
                      {chartTopics.map(t => (
                        <div key={t.topic} style={{ flex: 1, minWidth: 0, position: "relative" }}>
                          {/* Rotate around bottom-centre so the original
                              RIGHT edge of the text (text-align: right)
                              ends up at the TOP after rotate(-90deg) —
                              i.e. anchored to the x-axis line, not
                              floating in the middle of the band.
                              Multi-line wrap allowed via whiteSpace
                              normal + a fixed pre-rotation width budget. */}
                          <div style={{
                            position: "absolute",
                            top: 0,
                            left: 0,
                            right: 0,
                            display: "flex",
                            justifyContent: "center",
                          }}>
                            <div style={{
                              width: PRE_ROTATE_WIDTH,
                              transform: "rotate(-90deg)",
                              transformOrigin: "50% 0%",
                              whiteSpace: "normal",
                              overflowWrap: "break-word",
                              fontSize: 9,
                              lineHeight: 1.15,
                              fontWeight: 600,
                              color: "#0b1c30",
                              textAlign: "right",
                            }}>
                              {t.topic}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                }
                return (
                  <div style={{ display: "flex", gap: 16, marginTop: 8 }}>
                    {chartTopics.map(t => (
                      <div key={t.topic} style={{ flex: 1, minWidth: 0, overflowWrap: "break-word", wordBreak: "break-word", fontSize: 11, fontWeight: 600, color: "#0b1c30", textAlign: "center", lineHeight: 1.3 }}>
                        {t.topic}
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
          );
        })()}

        {/* Common Mistakes */}
        {commonMistakes.length > 0 && (
          <div style={{ marginBottom: 28 }}>
            <div style={sectionTitleStyle}>Common Mistakes</div>
            {commonMistakes.map((m, i) => (
              <div key={i} style={{ border: "1px solid #ede9fe", borderRadius: 12, padding: 18, marginBottom: 14, backgroundColor: "#fbfaff" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                  <div style={{ fontSize: 17, fontWeight: 800, color: "#001e40" }}>{m.name}</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#7c3aed" }}>
                    {m.marksLost} marks lost{(() => { const p = pctOfSubject(m.marksLost, topline.totalAvailable); return p ? ` (${p} pt lost)` : ""; })()}
                  </div>
                </div>
                <div
                  style={{ fontSize: 14, color: "#1e293b", lineHeight: 1.6, marginBottom: 12 }}
                  dangerouslySetInnerHTML={{ __html: boldifyHtml(emphasiseQuoted(softenTone(m.what, childFirst))) }}
                />
                <div style={{ backgroundColor: "#ecfdf5", border: "1px solid #d1fae5", borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "#065f46", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Lumi&rsquo;s Advice</div>
                  <div
                    style={{ fontSize: 13, color: "#064e3b", lineHeight: 1.6 }}
                    dangerouslySetInnerHTML={{ __html: boldifyHtml(emphasiseQuoted(softenTone(m.advice, childFirst))) }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Conceptual Gaps */}
        {conceptualGaps.length > 0 && (
          <div style={{ marginBottom: 28 }}>
            <div style={{ ...sectionTitleStyle, color: "#ea580c" }}>Conceptual Gaps</div>
            {conceptualGaps.map((c, i) => (
              <div key={i} style={{ border: "1px solid #fed7aa", borderRadius: 12, padding: 18, marginBottom: 14, backgroundColor: "#fffbf5" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                  <div style={{ fontSize: 17, fontWeight: 800, color: "#001e40" }}>{c.name}</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#ea580c" }}>
                    {c.marksLost} marks lost{(() => { const p = pctOfSubject(c.marksLost, topline.totalAvailable); return p ? ` (${p} pt lost)` : ""; })()}
                  </div>
                </div>
                <div
                  style={{ fontSize: 14, color: "#1e293b", lineHeight: 1.6, marginBottom: 12 }}
                  dangerouslySetInnerHTML={{ __html: boldifyHtml(emphasiseQuoted(softenTone(c.what, childFirst))) }}
                />
                <div style={{ backgroundColor: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "#9a3412", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Lumi&rsquo;s Explanation</div>
                  <div
                    style={{ fontSize: 13, color: "#7c2d12", lineHeight: 1.6 }}
                    dangerouslySetInnerHTML={{ __html: boldifyHtml(emphasiseQuoted(softenTone(c.advice, childFirst))) }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Footer */}
        <div style={{ paddingTop: 24, borderTop: "2px solid #e5eeff", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 20, fontWeight: 800, color: "#001e40" }}>MarkForYou.com</div>
          <div style={{ fontSize: 11, color: "#737780" }}>AI-powered marking · Lumi the Owl Tutor</div>
        </div>
      </div>
    );
  }
);
LumiShareable.displayName = "LumiShareable";

function OverviewPanel({ data, parentId, studentId, onSelectMistake, onSelectConcept, prefetchedProgress, prefetchedProgressErr }: { data: Extract<TutorData, { kind: "ready" }>; parentId: string; studentId: string; onSelectMistake: (i: number) => void; onSelectConcept: (i: number) => void; prefetchedProgress: ProgressData | null; prefetchedProgressErr: boolean }) {
  const t = data.topline;
  // Inline (no modal) assign flow — clicking the topic button POSTs
  // straight to /api/focused-test. `creatingTopic` is the topic whose
  // request is in flight so we can spinner that row only.
  const [creatingTopic, setCreatingTopic] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Look up existing focused-practice papers per topic so we can
  // surface a "Revise here" link before the Assign button when the
  // kid has already attempted one on this topic.
  const [existingByTopic, setExistingByTopic] = useState<Record<string, { id: string; completed: boolean }>>({});
  useEffect(() => {
    fetch(`/api/exam?userId=${studentId}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const papers = (d?.papers ?? []) as Array<{ id: string; title: string; paperType: string | null; subject: string | null; completedAt: string | null }>;
        const subjLc = data.subject.toLowerCase();
        const map: Record<string, { id: string; completed: boolean }> = {};
        for (const p of papers) {
          if (p.paperType !== "focused") continue;
          const pSubj = (p.subject ?? "").toLowerCase();
          if (subjLc === "math" && !pSubj.includes("math")) continue;
          if (subjLc === "science" && !pSubj.includes("science")) continue;
          if (subjLc === "english" && !pSubj.includes("english")) continue;
          if (subjLc === "chinese" && !pSubj.includes("chinese") && !pSubj.includes("华") && !pSubj.includes("中")) continue;
          // Title-contains match against each topic in the Topics-for-
          // Practice list. Take the most recent matching paper per
          // topic (papers are returned createdAt desc already).
          for (const tc of data.topicsForPractice) {
            const titleLc = p.title.toLowerCase();
            const topicLc = tc.topic.toLowerCase();
            if (titleLc.includes(topicLc) && !map[tc.topic]) {
              map[tc.topic] = { id: p.id, completed: !!p.completedAt };
            }
          }
        }
        setExistingByTopic(map);
      })
      .catch(() => { /* best-effort — no link shown */ });
  }, [studentId, data.subject, data.topicsForPractice]);

  // Daily Practices: schedule N MCQ daily quizzes for the next N days.
  // For English/Chinese, rotate through 2 sections per day, with
  // Comprehension OEQ taking a full day to itself (every 3rd slot).
  const [schedulingDays, setSchedulingDays] = useState<number | null>(null);
  const ENGLISH_ROTATION = ["grammar-mcq", "vocab-mcq", "vocab-cloze", "visual-text", "grammar-cloze", "editing", "comprehension-cloze", "synthesis"];
  const ENGLISH_OEQ = "comprehension-oeq";
  // The label strings here MUST match the master paper's
  // metadata.chineseSections label field so the API can find them.
  const CHINESE_ROTATION = ["语文应用 MCQ", "短文填空", "阅读理解 MCQ", "完成对话", "阅读理解 A"];
  const CHINESE_OEQ = "阅读理解 B OEQ";
  function planSections(subj: string, dayIdx: number): string[] | null {
    const isEng = subj.toLowerCase().includes("english");
    const isChn = subj.toLowerCase().includes("chinese");
    if (!isEng && !isChn) return null;
    // OEQ day every 3rd day (days 3, 6, 9, …) so it gets a fair slice.
    if ((dayIdx + 1) % 3 === 0) return [isEng ? ENGLISH_OEQ : CHINESE_OEQ];
    const pool = isEng ? ENGLISH_ROTATION : CHINESE_ROTATION;
    // Number of non-OEQ days that have come before dayIdx — each took
    // 2 sections, so the next pair starts at 2 * (non-OEQ days so far).
    const nonOeqDayCount = dayIdx - Math.floor((dayIdx + 1) / 3);
    const a = pool[(2 * nonOeqDayCount) % pool.length];
    const b = pool[(2 * nonOeqDayCount + 1) % pool.length];
    return [a, b];
  }
  async function scheduleDailyPractices(numDays: number) {
    if (schedulingDays) return;
    setSchedulingDays(numDays);
    try {
      const subjLc = data.subject.toLowerCase();
      let okDays = 0;
      for (let i = 0; i < numDays; i++) {
        const d = new Date();
        d.setDate(d.getDate() + i + 1);
        d.setHours(8, 0, 0, 0); // 8am the scheduled day
        const scheduledFor = d.toISOString();
        const sections = planSections(data.subject, i);
        const body: Record<string, unknown> = {
          quizType: "mcq",
          subject: subjLc.includes("math") ? "math" : subjLc.includes("science") ? "science" : subjLc.includes("english") ? "english" : subjLc.includes("chinese") ? "chinese" : data.subject,
          scheduledFor,
        };
        if (subjLc.includes("chinese")) {
          // Chinese gating: actor (admin) is userId, child is studentId.
          body.userId = parentId;
          body.studentId = studentId;
          if (sections) body.chineseSections = sections;
        } else {
          body.userId = studentId;
          if (subjLc.includes("english") && sections) body.englishSections = sections;
        }
        const res = await fetch("/api/daily-quiz", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) okDays++;
        else {
          const j = await res.json().catch(() => ({}));
          alert(`Failed on day ${i + 1}: ${j.error ?? `HTTP ${res.status}`}`);
          break;
        }
      }
      if (okDays > 0) {
        setToast(`${okDays} daily quiz${okDays === 1 ? "" : "zes"} scheduled for ${data.childFirst}.`);
        setTimeout(() => setToast(null), 3000);
        // Tell the parent dashboard to re-pull its papers list — see
        // assignTopic for rationale.
        window.dispatchEvent(new CustomEvent("lumi-paper-assigned"));
      }
    } finally {
      setSchedulingDays(null);
    }
  }

  async function assignTopic(topic: string) {
    if (creatingTopic) return;
    setCreatingTopic(topic);
    try {
      const subjLc = data.subject.toLowerCase();
      const subjectArg = subjLc.includes("math") ? "Mathematics" : subjLc.includes("science") ? "Science" : data.subject;
      const res = await fetch("/api/focused-test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentId, studentId, subject: subjectArg, topic }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { alert(j.error || "Failed to create focused practice"); return; }
      setToast(`Focused practice assigned: ${topic}`);
      setTimeout(() => setToast(null), 2800);
      // Notify the parent dashboard so its paper list re-fetches and
      // the new focused practice shows up immediately when the parent
      // switches back to Home (otherwise refreshPapers only runs on
      // mount + tab focus, and an in-page view switch missed it).
      window.dispatchEvent(new CustomEvent("lumi-paper-assigned"));
    } finally {
      setCreatingTopic(null);
    }
  }

  return (
    <>
      {/* Assigned toast (top-centre, fades after ~3s). */}
      {toast && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[110] bg-emerald-600 text-white px-5 py-3 rounded-2xl shadow-lg flex items-center gap-2">
          <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
          <span className="font-bold text-sm">{toast}</span>
        </div>
      )}
      {/* Topline — small headline strip; the chart below is the
          primary signal now, so this is just the avg-% summary line. */}
      <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 mb-6">
        <div className="flex items-baseline justify-between">
          <div>
            <h2 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1">{data.subject} overview</h2>
            <div className="flex items-baseline gap-3">
              <span className="text-4xl font-headline font-black text-[#001e40]">{t.avgPct}%</span>
              <span className="text-sm text-slate-500">avg ({t.totalAwarded}/{t.totalAvailable} marks · {t.paperCount} paper{t.paperCount === 1 ? "" : "s"})</span>
            </div>
          </div>
        </div>
        {t.nudge && (
          <div className="mt-4 bg-amber-50 border border-amber-100 rounded-xl px-4 py-3">
            <p className="text-sm text-amber-900 leading-relaxed">💛 {t.nudge}</p>
          </div>
        )}
      </section>

      {/* English fluency table — rule-family breakdown reads FIRST
          for English parents, so we render it above the flat topic
          bar chart. GrammarRadar no-ops on non-English + hides itself
          until data loads, so a plain white card here is safe. */}
      {data.subject.toLowerCase().includes("english") && (
        <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 mb-6">
          <GrammarRadar studentId={studentId} subject={data.subject} childFirst={data.childFirst} />
        </section>
      )}

      {/* Bar chart upfront — clickable bars surface a topic detail
          panel + Assign Focus Practice CTA without needing the user
          to swipe to a separate "Full Progress" view. */}
      <FullProgressEmbed studentId={studentId} parentId={parentId} subject={data.subject} childFirst={data.childFirst} prefetchedProgress={prefetchedProgress} prefetchedProgressErr={prefetchedProgressErr} />

      {/* Common Mistakes */}
      {data.commonMistakes.length > 0 && (
        <section id="mistakes-section" className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 mb-6 scroll-mt-20">
          <h2 className="font-headline text-xl font-extrabold text-[#006c49] mb-2">Common Mistakes</h2>
          <p className="text-sm text-slate-500 mb-5">Answering techniques where {data.childFirst} keeps losing marks. Let&apos;s go through these and get some practices to fix these mistakes.</p>
          <div className="space-y-3">
            {data.commonMistakes.map((m, i) => (
              <button key={m.bucket} onClick={() => onSelectMistake(i)} className="w-full text-left border border-slate-100 rounded-xl p-5 flex flex-col md:flex-row md:justify-between md:items-center gap-2 bg-slate-50/50 hover:bg-violet-50/40 hover:border-violet-200 transition-colors group">
                <div>
                  <p className="text-xs font-bold text-violet-600 mb-1">Mistake {i + 1} · {m.marksLost} marks lost{(() => { const p = pctOfSubject(m.marksLost, t.totalAvailable); return p ? ` (${p} pt lost)` : ""; })()}</p>
                  <h3 className="font-headline font-extrabold text-lg text-[#001e40] mb-1">{m.name}</h3>
                  <p className="text-sm text-slate-600 max-w-2xl" dangerouslySetInnerHTML={{ __html: boldifyHtml(emphasiseQuoted(softenTone(m.what, data.childFirst))) }} />
                </div>
                <span className="shrink-0 text-sm font-semibold text-[#003366] group-hover:text-violet-600 md:ml-4 whitespace-nowrap">
                  Tell me more →
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Conceptual Gaps */}
      {data.conceptualGaps.length > 0 && (
        <section id="concepts-section" className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 mb-6 scroll-mt-20">
          <h2 className="font-headline text-xl font-extrabold text-[#006c49] mb-2">Conceptual Gaps</h2>
          <p className="text-sm text-slate-500 mb-5">Concepts {data.childFirst} consistently mixes up — worth explaining and quizzing on.</p>
          <div className="space-y-3">
            {data.conceptualGaps.map((c, i) => (
              <button key={c.bucket} onClick={() => onSelectConcept(i)} className="w-full text-left border border-slate-100 rounded-xl p-5 flex flex-col md:flex-row md:justify-between md:items-center gap-2 bg-slate-50/50 hover:bg-orange-50/40 hover:border-orange-200 transition-colors group">
                <div>
                  <p className="text-xs font-bold text-orange-600 mb-1">Concept · {c.marksLost} marks lost{(() => { const p = pctOfSubject(c.marksLost, t.totalAvailable); return p ? ` (${p} pt lost)` : ""; })()}</p>
                  <h3 className="font-headline font-extrabold text-lg text-[#001e40] mb-1">{c.name}</h3>
                  <p className="text-sm text-slate-600 max-w-2xl" dangerouslySetInnerHTML={{ __html: boldifyHtml(emphasiseQuoted(softenTone(c.what, data.childFirst))) }} />
                </div>
                <span className="shrink-0 text-sm font-semibold text-[#003366] group-hover:text-orange-600 md:ml-4 whitespace-nowrap">
                  Explain →
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Topics for Practice */}
      {data.topicsForPractice.length > 0 && (
        <section id="topics-section" className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 mb-6 scroll-mt-20">
          <h2 className="font-headline text-xl font-extrabold text-[#006c49] mb-2">Topics for Practice</h2>
          <p className="text-sm text-slate-500 mb-5">Below average — a Focused Practice on each will lift the score.</p>
          <div className="divide-y divide-slate-100 border border-slate-100 rounded-xl bg-slate-50/50">
            {data.topicsForPractice.map(t => {
              const existing = existingByTopic[t.topic];
              const reviseHref = existing
                ? (existing.completed
                    ? `/exam/${existing.id}/review?userId=${parentId || studentId}`
                    : `/quiz/${existing.id}?userId=${studentId}`)
                : null;
              return (
                <div key={t.topic} className="flex justify-between items-center gap-3 p-5 flex-wrap">
                  <div>
                    <p className="font-semibold text-[#001e40] text-base">{t.topic}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{t.attempts} attempts · {t.pct}% avg</p>
                    {existing && (
                      <p className="text-xs text-amber-700 mt-1.5">
                        💡 {data.childFirst} already has a focused practice on this — review it (<a href={reviseHref ?? "#"} target="_blank" rel="noopener" className="underline font-semibold text-amber-800 hover:text-amber-900">here</a>) with him before assigning another.
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => assignTopic(t.topic)}
                    disabled={creatingTopic === t.topic}
                    // ml-auto keeps the button right-aligned even when
                    // the row wraps (the "already has a focused
                    // practice" tip on the left can be long enough to
                    // push the button to a new line, where
                    // justify-between would leave it on the LEFT).
                    className="shrink-0 ml-auto inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#003366] text-white text-sm font-bold shadow-sm hover:bg-[#001e40] active:scale-[0.98] transition disabled:opacity-60 whitespace-nowrap"
                  >
                    {creatingTopic === t.topic
                      ? <><span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />Assigning…</>
                      : <><span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>target</span>{existing ? "Assign Another" : "Assign Focused Practice"}</>}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Daily Practices — bottom of the page, the "(here)" link in
          the Lumi summary scrolls down to this section. */}
      <section id="daily-practices-section" className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 mb-6 scroll-mt-20">
        <h2 className="font-headline text-xl font-extrabold text-[#006c49] mb-2">Daily Practices</h2>
        <p className="text-sm text-slate-500 mb-2">Daily bite-sized practices are a good way to level up in a short and fun way.{(data.subject === "English" || data.subject === "Chinese") && " I'll rotate the sections each day so " + data.childFirst + " covers the whole subject."}</p>
        <p className="text-xs text-amber-700 mb-5 flex items-center gap-1">
          <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>schedule</span>
          Heads up: this may take a minute or so — I build each day&apos;s quiz one at a time.
        </p>
        <div className="flex gap-3 flex-wrap">
          {[3, 5, 7].map(n => (
            <button
              key={n}
              type="button"
              onClick={() => scheduleDailyPractices(n)}
              disabled={schedulingDays !== null}
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-[#003366] text-white text-sm font-bold shadow-sm hover:bg-[#001e40] active:scale-[0.98] transition disabled:opacity-60"
            >
              {schedulingDays === n
                ? <><span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />Scheduling {n} day{n === 1 ? "" : "s"}…</>
                : <><span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>calendar_month</span>{n} day{n === 1 ? "" : "s"} of daily quizzes</>}
            </button>
          ))}
        </div>
        {schedulingDays !== null && (
          <p className="text-xs text-[#003366] mt-3 flex items-center gap-2 animate-pulse">
            <span className="w-3 h-3 border-2 border-[#003366]/30 border-t-[#003366] rounded-full animate-spin" />
            Building {schedulingDays} quiz{schedulingDays === 1 ? "" : "zes"} for {data.childFirst} — please don&apos;t close this tab.
          </p>
        )}
        <p className="text-xs text-slate-500 mt-4 italic">After I assign, you can move these around in the weekly calendar at your homepage.</p>
      </section>
    </>
  );
}

function DetailPanel({ data, view, lazyImages, onBack, onGoToFocusedPractice }: { data: Extract<TutorData, { kind: "ready" }>; view: DetailView; lazyImages: LazyImages; onBack: () => void; onGoToFocusedPractice: () => void }) {
  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-2 text-sm font-semibold text-slate-600 hover:text-[#003366] mb-4">
        <span className="material-symbols-outlined text-base">arrow_back</span>
        Back to overview
      </button>
      {view.kind === "mistake" && data.commonMistakes[view.index] && (
        <MistakeDetail card={data.commonMistakes[view.index]} childFirst={data.childFirst} totalAvailable={data.topline.totalAvailable} lazyImages={lazyImages} onGoToFocusedPractice={onGoToFocusedPractice} />
      )}
      {view.kind === "concept" && data.conceptualGaps[view.index] && (
        <ConceptDetail card={data.conceptualGaps[view.index]} childFirst={data.childFirst} totalAvailable={data.topline.totalAvailable} lazyImages={lazyImages} onGoToFocusedPractice={onGoToFocusedPractice} />
      )}
    </div>
  );
}

// If a clear majority (≥60%) of a pattern's examples come from the
// same syllabus topic, return that topic name so the UI can suggest
// a focused practice on it. Returns null when the spread is too even
// or topic data is missing.
function dominantExampleTopic(examples: { topic?: string | null }[]): string | null {
  const tally: Record<string, number> = {};
  let total = 0;
  for (const ex of examples) {
    const t = (ex.topic ?? "").trim();
    if (!t || t === "Untagged") continue;
    tally[t] = (tally[t] ?? 0) + 1;
    total++;
  }
  if (total < 2) return null;
  let topTopic: string | null = null;
  let topCount = 0;
  for (const [t, n] of Object.entries(tally)) {
    if (n > topCount) { topCount = n; topTopic = t; }
  }
  if (topTopic === null) return null;
  return topCount / total >= 0.6 ? topTopic : null;
}

function MistakeDetail({ card, childFirst, totalAvailable, lazyImages, onGoToFocusedPractice }: { card: Extract<TutorData, { kind: "ready" }>["commonMistakes"][number]; childFirst: string; totalAvailable: number; lazyImages: LazyImages; onGoToFocusedPractice: () => void }) {
  // MathText (instead of boldifyHtml) so $...$ LaTeX renders as math
  // in Lumi's advice + the headline "what went wrong" copy. Bold and
  // underline markers still work — MathText handles them natively.
  const adviceText = emphasiseQuoted(softenTone(card.advice, childFirst));
  const pct = pctOfSubject(card.marksLost, totalAvailable);
  const dominantTopic = dominantExampleTopic(card.examples);
  return (
    <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8">
      <p className="text-xs font-bold text-violet-600 uppercase tracking-wider mb-2">Common Mistake · {card.marksLost} marks lost{pct ? ` (${pct} pt lost)` : ""}</p>
      <h2 className="font-headline text-2xl font-extrabold text-[#001e40] mb-2">{card.name}</h2>
      <p className="text-base text-slate-600 leading-relaxed mb-6"><MathText text={emphasiseQuoted(softenTone(card.what, childFirst))} /></p>

      <div className="bg-emerald-50 border border-emerald-100 rounded-xl px-5 py-4 mb-6">
        <p className="text-xs font-bold text-emerald-700 uppercase tracking-wider mb-2">Lumi&apos;s Advice</p>
        {dominantTopic && (
          <p className="text-sm font-bold text-emerald-900 leading-relaxed mb-3">
            Most of these mistakes are in <strong>{dominantTopic}</strong> — a focused practice on this topic can help.{" "}
            <button type="button" onClick={onGoToFocusedPractice} className="text-emerald-700 underline decoration-emerald-400 hover:decoration-emerald-700 underline-offset-2 font-semibold">
              (here)
            </button>
          </p>
        )}
        <p className="text-sm text-emerald-900 leading-relaxed"><MathText text={adviceText} /></p>
        {card.triggerKeywords.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="text-xs font-bold text-emerald-700">Watch for:</span>
            {card.triggerKeywords.map(k => (
              <span key={k} className="bg-emerald-100 text-emerald-800 text-xs font-semibold px-2 py-0.5 rounded">{k}</span>
            ))}
          </div>
        )}
      </div>

      {card.examples.length > 0 && (
        <div className="mb-6">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Examples from {childFirst}&apos;s work</p>
          <div className="space-y-3">
            {card.examples.map((ex, i) => (
              <ExpandableExample key={i} ex={ex} index={i} accent="violet" childFirst={childFirst} lazyImages={lazyImages} />
            ))}
          </div>
        </div>
      )}

      {/* Personal Quiz with Guidance CTA parked — needs more workshop
          on what the personalised quiz should actually look like
          (mistake-targeted item pool? Lumi inline coaching between
          questions? worked-example warmup?). Bring this button back
          once the generator + UX flow ship. */}
    </section>
  );
}

function ConceptDetail({ card, childFirst, totalAvailable, lazyImages, onGoToFocusedPractice }: { card: Extract<TutorData, { kind: "ready" }>["conceptualGaps"][number]; childFirst: string; totalAvailable: number; lazyImages: LazyImages; onGoToFocusedPractice: () => void }) {
  const adviceText = emphasiseQuoted(softenTone(card.advice, childFirst));
  const pct = pctOfSubject(card.marksLost, totalAvailable);
  const dominantTopic = dominantExampleTopic(card.examples);
  return (
    <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8">
      <p className="text-xs font-bold text-orange-600 uppercase tracking-wider mb-2">Conceptual Gap · {card.marksLost} marks lost{pct ? ` (${pct} pt lost)` : ""}</p>
      <h2 className="font-headline text-2xl font-extrabold text-[#001e40] mb-2">{card.name}</h2>
      <p className="text-base text-slate-600 leading-relaxed mb-6"><MathText text={emphasiseQuoted(softenTone(card.what, childFirst))} /></p>

      <div className="bg-orange-50 border border-orange-100 rounded-xl px-5 py-4 mb-6">
        <p className="text-xs font-bold text-orange-700 uppercase tracking-wider mb-2">Lumi&apos;s Explanation</p>
        {dominantTopic && (
          <p className="text-sm font-bold text-orange-900 leading-relaxed mb-3">
            Most of these mistakes are in <strong>{dominantTopic}</strong> — a focused practice on this topic can help.{" "}
            <button type="button" onClick={onGoToFocusedPractice} className="text-orange-700 underline decoration-orange-400 hover:decoration-orange-700 underline-offset-2 font-semibold">
              (here)
            </button>
          </p>
        )}
        <p className="text-sm text-orange-900 leading-relaxed"><MathText text={adviceText} /></p>
      </div>

      {card.examples.length > 0 && (
        <div className="mb-6">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Where {childFirst} got mixed up</p>
          <div className="space-y-3">
            {card.examples.map((ex, i) => (
              <ExpandableExample key={i} ex={ex} index={i} accent="orange" childFirst={childFirst} lazyImages={lazyImages} />
            ))}
          </div>
        </div>
      )}

      {/* Concept Quiz CTA parked — the concept-pair quiz generator
          (per the workshop discussion: real master questions that
          test BOTH concepts the kid confuses) isn't built yet. Bring
          this button back once the generator ships. */}
    </section>
  );
}

// Lumi — the Tutor mascot. Cycles through 3 short owl clips. Source
// material is owl[1-3].mp4 but we serve animated WebP versions
// instead — <video> autoplay on Safari iPad refused to render even
// with muted + playsInline + autoplay (see commits b7af32ee, fa55ac56),
// while <img>-served animated images have no autoplay gating at all.
// 256×256 animations at ~600 KB each, fits 4 s of looped motion.
// Cycling: every ~4 s we bump cur; the unused two stay mounted in a
// `hidden` div so the browser keeps them decoded and the swap is
// instant.
function LumiAvatar() {
  const clips = ["/avatars/owl1.webp", "/avatars/owl2.webp", "/avatars/owl3.webp"];
  const [cur, setCur] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setCur(p => (p + 1) % clips.length), 4000);
    return () => window.clearInterval(id);
  }, [clips.length]);
  return (
    <div className="relative shrink-0 w-32 h-32 rounded-full border-2 border-violet-300 overflow-hidden bg-white shadow-sm">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        key={clips[cur]}
        src={clips[cur]}
        alt="Lumi the owl"
        className="absolute inset-0 w-full h-full object-cover pointer-events-none"
      />
      {/* Keep the other two decoded so the swap is instant. */}
      <div className="hidden">
        {clips.filter((_, i) => i !== cur).map(src => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={`pre-${src}`} src={src} alt="" />
        ))}
      </div>
    </div>
  );
}

function FullProgressEmbed({ studentId, parentId, subject, childFirst, prefetchedProgress, prefetchedProgressErr }: { studentId: string; parentId: string; subject: string; childFirst: string; prefetchedProgress: ProgressData | null; prefetchedProgressErr: boolean }) {
  // Progress data is prefetched by the parent TutorBodyForStudent in
  // parallel with the tutor fetch, so the chart can render as soon as
  // either of the two completes — no waterfall.
  const progress = prefetchedProgress;
  const progressErr = prefetchedProgressErr;
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [assignedToast, setAssignedToast] = useState<string | null>(null);

  // Match Tutor's subject label to the keys used by /api/student-progress
  // ("Science", "Mathematics", "English", "Chinese") — same fallback as
  // the progress page.
  const subjectKey = (() => {
    if (!progress) return null;
    const keys = Object.keys(progress.subjects);
    const t = subject.toLowerCase();
    if (t === "math") return keys.find(k => k.toLowerCase().includes("math")) ?? null;
    return keys.find(k => k.toLowerCase().includes(t)) ?? null;
  })();
  const subjectData = subjectKey ? progress?.subjects[subjectKey] : undefined;
  const timeline = subjectKey ? progress?.timeline[subjectKey] : undefined;

  const ENGLISH_TOPIC_TO_SECTION: Record<string, string> = {
    "Grammar MCQ": "grammar-mcq", "Vocabulary MCQ": "vocab-mcq", "Vocabulary Cloze MCQ": "vocab-cloze",
    "Visual Text Comprehension MCQ": "visual-text", "Grammar Cloze": "grammar-cloze",
    "Editing (Spelling & Grammar)": "editing", "Comprehension Cloze": "comprehension-cloze",
    "Synthesis & Transformation": "synthesis", "Synthesis / Transformation": "synthesis",
    "Comprehension (Open-ended)": "comprehension-oeq", "Comprehension Open Ended": "comprehension-oeq",
  };
  async function assignFocus(topic: string) {
    if (!subjectKey) return;
    setCreating(topic);
    try {
      const isEnglish = subjectKey.toLowerCase().includes("english");
      const englishSection = isEnglish ? ENGLISH_TOPIC_TO_SECTION[topic] : undefined;
      const res = englishSection
        ? await fetch("/api/daily-quiz", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: studentId, quizType: "mcq", subject: "english", englishSections: [englishSection], focused: true }),
          })
        : await fetch("/api/focused-test", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              parentId, studentId,
              subject: subjectKey.toLowerCase().includes("math") ? "Mathematics" : subjectKey.toLowerCase().includes("science") ? "Science" : subjectKey,
              topic,
            }),
          });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { alert(j.error || "Failed to create test"); return; }
      setAssignedToast(topic);
      setTimeout(() => setAssignedToast(null), 2500);
      // Tell the parent dashboard to re-pull its papers list — see
      // assignTopic above for the same pattern + rationale.
      window.dispatchEvent(new CustomEvent("lumi-paper-assigned"));
    } finally {
      setCreating(null);
    }
  }

  return (
    <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8">
      <h2 className="font-headline text-xl font-extrabold text-[#006c49] mb-2">Full Progress Report</h2>
      <p className="text-sm text-slate-600 leading-relaxed mb-6">{childFirst}&apos;s per-topic accuracy with the clickable bar chart. Tap any bar to see history + assign focused practice.</p>
      {assignedToast && (
        <div className="mb-4 bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-2 rounded-lg text-sm font-semibold">
          Focus practice assigned: {assignedToast}
        </div>
      )}
      {!progress && !progressErr && (
        <div className="flex justify-center py-16">
          <div className="w-10 h-10 rounded-full border-4 border-slate-100 border-t-[#003366] animate-spin" />
        </div>
      )}
      {progressErr && <p className="text-sm text-rose-600">Couldn&apos;t load progress data.</p>}
      {progress && !subjectData && (
        <p className="text-sm text-slate-500 italic">No {subject} data yet for {childFirst}.</p>
      )}
      {progress && subjectKey && subjectData && (
        <AdminTopicChart
          subject={subjectKey}
          subjectData={subjectData}
          timeline={Array.isArray(timeline) ? timeline : []}
          studentName={progress.student?.name ?? childFirst}
          selectedTopic={selectedTopic}
          onSelectTopic={setSelectedTopic}
          onAssignFocus={assignFocus}
          creating={creating}
        />
      )}
    </section>
  );
}

// English Grammar + Synthesis fluency radars. Gated to a small set
// of kids with enough sub-topic-tagged attempts. Pulls combined
// payload from /api/tutor/[id]/grammar-fluency.
// Fluency Radar/Table opened to every student on 2026-07-02 — the
// per-kid allowlist that used to live here is retired.
type FluencyRow = { id: string; label: string; awarded: number; available: number; questions?: number; pct: number | null };
type FluencyBundle = { subTopics: FluencyRow[]; overall: number | null; totalAwarded: number; totalAvailable: number };

// Single radar SVG — accepts axes + per-axis percentages. Re-used
// for grammar (7 rules) and synthesis (6 tricks). Zone thresholds:
// green ≥ 75% (raised from 80% to give a slightly wider safe band),
// yellow 50–75%, red < 50%.
function RadarSvg({ title, subTopics, overall, totalAwarded, totalAvailable }: {
  title: string;
  subTopics: FluencyRow[];
  overall: number | null;
  totalAwarded: number;
  totalAvailable: number;
}) {
  const W = 320, H = 320, CX = W / 2, CY = H / 2, R = 115;
  const subs = subTopics;
  const angles = subs.map((_, i) => (i / Math.max(subs.length, 1)) * 2 * Math.PI - Math.PI / 2);
  const point = (angle: number, pct: number): [number, number] => {
    const r = (pct / 100) * R;
    return [CX + r * Math.cos(angle), CY + r * Math.sin(angle)];
  };
  const ringPath = (pctOuter: number, pctInner: number, segments = 60): string => {
    const ro = (pctOuter / 100) * R;
    const ri = (pctInner / 100) * R;
    let p = "";
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * 2 * Math.PI - Math.PI / 2;
      const x = CX + ro * Math.cos(a), y = CY + ro * Math.sin(a);
      p += (i === 0 ? "M" : "L") + x.toFixed(2) + "," + y.toFixed(2) + " ";
    }
    for (let i = segments; i >= 0; i--) {
      const a = (i / segments) * 2 * Math.PI - Math.PI / 2;
      const x = CX + ri * Math.cos(a), y = CY + ri * Math.sin(a);
      p += "L" + x.toFixed(2) + "," + y.toFixed(2) + " ";
    }
    return p + "Z";
  };
  const polygonPts = subs.map((s, i) => point(angles[i], s.pct ?? 0).join(",")).join(" ");
  return (
    <div className="flex flex-col items-center">
      <h4 className="text-sm font-bold text-[#001e40] text-center">{title}</h4>
      <p className="text-[11px] text-[#666] mb-2 text-center">
        {totalAvailable > 0 ? (
          <>Overall <strong className="text-[#001e40]">{overall ?? 0}%</strong> ({totalAwarded}/{totalAvailable} marks)</>
        ) : (
          <span className="italic">No attempts yet</span>
        )}
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[320px]">
        <path d={ringPath(100, 75)} fill="#bbf7d0" opacity="0.55" />
        <path d={ringPath(75, 50)} fill="#fde68a" opacity="0.55" />
        <path d={ringPath(50, 0)} fill="#fecaca" opacity="0.4" />
        {[20, 40, 60, 80, 100].map(p => (
          <circle key={p} cx={CX} cy={CY} r={(p / 100) * R} fill="none" stroke="#cccccc" strokeWidth={0.8} />
        ))}
        {subs.map((s, i) => {
          const [ax, ay] = point(angles[i], 100);
          const [lx, ly] = point(angles[i], 116);
          return (
            <g key={s.id}>
              <line x1={CX} y1={CY} x2={ax} y2={ay} stroke="#cccccc" strokeWidth={0.8} />
              <text x={lx} y={ly} fontSize={9.5} textAnchor="middle" dominantBaseline="middle" fill="#001e40" fontWeight={600}>
                {s.label.split("\n").map((w, j) => (
                  <tspan key={j} x={lx} dy={j === 0 ? 0 : 11}>{w}</tspan>
                ))}
              </text>
            </g>
          );
        })}
        <polygon points={polygonPts} fill="#3b82f6" fillOpacity={0.3} stroke="#1e40af" strokeWidth={2} />
        {subs.map((s, i) => {
          const [x, y] = point(angles[i], s.pct ?? 0);
          const colour = s.pct === null ? "#999" : s.pct >= 75 ? "#16a34a" : s.pct >= 50 ? "#ca8a04" : "#dc2626";
          return (
            <g key={`pt-${s.id}`}>
              <circle cx={x} cy={y} r={4.5} fill={colour} stroke="white" strokeWidth={1.5} />
              {s.pct !== null && (
                <text x={x} y={y - 9} fontSize={10} textAnchor="middle" fill="#001e40" fontWeight={700}>
                  {s.pct}%
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// Table variant of the fluency view — mirrors the parent-facing email
// (rows ≥80% light green, <80% light yellow, no-data dimmed). Sorted
// strongest → weakest so the eye lands on green first. Used as the
// alternate view inside GrammarRadar's Radar / Table toggle.
// PSLE Grammar MCQ weightage per sub-topic — from the 12-year audit
// of PSLE English 2014-2025 (n=122). Used to show "how often does
// this rule show up in PSLE" alongside the fluency %, so parents can
// see which rules are worth prioritising.
const PSLE_GRAMMAR_WEIGHTAGE: Record<string, number> = {
  "connectors-tenses":       26,
  "verb-forms":              21,
  "idiomatic-prepositions":  18,
  "tag-questions":           12,
  "countable/uncountable":    9,
  "subject-verb-agreement":   7,
  "pronouns":                 6,
};
// PSLE Synthesis weightage — approximate from the historical spread
// (Synthesis is a smaller, 5-per-paper section so precision matters
// less; these numbers are directional).
const PSLE_SYNTHESIS_WEIGHTAGE: Record<string, number> = {
  "reported-speech":         25,
  "correlative-preference":  20,
  "subordinator":            18,
  "noun-phrase":             15,
  "participle-clauses":      12,
  "substitution-inversion":  10,
};
function FluencyTable({ title, bundle, weightageMap }: { title: string; bundle: FluencyBundle; weightageMap?: Record<string, number> }) {
  const sorted = [...bundle.subTopics].sort((a, b) => {
    if (a.pct === null && b.pct === null) return 0;
    if (a.pct === null) return 1;
    if (b.pct === null) return -1;
    return b.pct - a.pct;
  });
  return (
    <div className="flex flex-col">
      <h4 className="text-sm font-bold text-[#001e40]">{title}</h4>
      <p className="text-[11px] text-[#666] mb-2">
        {bundle.totalAvailable > 0 ? (
          <>Overall <strong className="text-[#001e40]">{bundle.overall ?? 0}%</strong> ({bundle.totalAwarded}/{bundle.totalAvailable} marks)</>
        ) : (
          <span className="italic">No attempts yet</span>
        )}
      </p>
      <table className="w-full border border-slate-200 rounded-md overflow-hidden text-[12px]">
        <thead>
          <tr className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
            <th className="text-left px-2 py-1 font-bold">Sub-topic</th>
            <th className="text-right px-2 py-1 font-bold">Score</th>
            <th className="text-right px-2 py-1 font-bold">Attempts</th>
            {weightageMap && <th className="text-right px-2 py-1 font-bold" title="Share of the PSLE section this rule typically covers">PSLE weight</th>}
          </tr>
        </thead>
        <tbody>
          {sorted.map(s => {
            const noData = s.pct === null;
            const bg = noData ? "bg-slate-50" : (s.pct! >= 80 ? "bg-green-100" : "bg-yellow-100");
            const labelText = s.label.replace(/\n/g, " ");
            const weight = weightageMap?.[s.id];
            return (
              <tr key={s.id} className={`${bg} border-t border-slate-100`}>
                <td className={`px-2 py-1.5 ${noData ? "text-slate-400" : "text-slate-900"}`}>{labelText}</td>
                <td className={`px-2 py-1.5 text-right whitespace-nowrap ${noData ? "text-slate-400" : "text-slate-900 font-bold"}`}>
                  {noData ? "—" : `${s.pct}%`}
                </td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap text-slate-500 text-[11px]">
                  {noData ? "no data" : `n=${s.questions ?? s.available}`}
                </td>
                {weightageMap && (
                  <td className="px-2 py-1.5 text-right whitespace-nowrap text-slate-600 text-[11px] font-semibold">
                    {typeof weight === "number" ? `${weight}%` : "—"}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function GrammarRadar({ studentId, subject, childFirst }: { studentId: string; subject: string; childFirst: string }) {
  const [data, setData] = useState<{ grammar: FluencyBundle; synthesis: FluencyBundle } | null>(null);
  // Default to Table view during first-time onboarding (?onboarding=1)
  // so the parent lands on the PSLE-weightage-annotated table right
  // away instead of the radar. Everyone else keeps radar as default.
  const initialView: "radar" | "table" = (() => {
    if (typeof window === "undefined") return "radar";
    const qs = new URLSearchParams(window.location.search);
    return qs.get("onboarding") === "1" ? "table" : "radar";
  })();
  const [view, setView] = useState<"radar" | "table">(initialView);
  // Open to every student on English — the fluency-fetch endpoint
  // handles the empty-data case gracefully (returns zeroed buckets)
  // and the render below hides itself when `data` is still null.
  // Accept any English variant — 'English', 'English Language', or
  // whatever the paper subject happened to be. The strict === "English"
  // check was silently dropping the fluency table when the review-page
  // handoff URL carried subject=English%20Language.
  const isEnglish = subject.toLowerCase().includes("english");
  useEffect(() => {
    if (!isEnglish) return;
    let cancelled = false;
    fetch(`/api/tutor/${studentId}/grammar-fluency`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (!cancelled && d) setData(d); })
      .catch(() => { /* silent */ });
    return () => { cancelled = true; };
  }, [studentId, isEnglish]);
  if (!isEnglish || !data) return null;

  const helpText = view === "radar"
    ? `${childFirst}'s accuracy on each rule family. Green zone ≥ 75%, yellow 50–75%, red < 50%.`
    : `${childFirst}'s accuracy on each rule family. Green ≥ 80%, yellow < 80%.`;

  return (
    <div className="mt-8 pt-6 border-t border-slate-200">
      <div className="flex items-start justify-between mb-1 gap-3">
        <h3 className="text-sm font-bold text-[#001e40]">English Fluency · sub-topic {view === "radar" ? "radar" : "table"}</h3>
        <div className="inline-flex rounded-lg bg-[#eff4ff] p-1 text-[11px] font-bold uppercase tracking-wider">
          <button
            type="button"
            onClick={() => setView("radar")}
            className={`px-3 py-1 rounded-md transition-colors ${view === "radar" ? "bg-[#003366] text-white shadow-sm" : "text-[#001e40] hover:text-[#003366]"}`}
          >
            Radar
          </button>
          <button
            type="button"
            onClick={() => setView("table")}
            className={`px-3 py-1 rounded-md transition-colors ${view === "table" ? "bg-[#003366] text-white shadow-sm" : "text-[#001e40] hover:text-[#003366]"}`}
          >
            Table
          </button>
        </div>
      </div>
      <p className="text-xs text-[#666] mb-4">{helpText}</p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {view === "radar" ? (
          <>
            <RadarSvg
              title="Grammar (MCQ + Cloze)"
              subTopics={data.grammar.subTopics}
              overall={data.grammar.overall}
              totalAwarded={data.grammar.totalAwarded}
              totalAvailable={data.grammar.totalAvailable}
            />
            <RadarSvg
              title="Synthesis & Transformation"
              subTopics={data.synthesis.subTopics}
              overall={data.synthesis.overall}
              totalAwarded={data.synthesis.totalAwarded}
              totalAvailable={data.synthesis.totalAvailable}
            />
          </>
        ) : (
          <>
            <FluencyTable title="Grammar (MCQ + Cloze)" bundle={data.grammar} weightageMap={PSLE_GRAMMAR_WEIGHTAGE} />
            <FluencyTable title="Synthesis & Transformation" bundle={data.synthesis} weightageMap={PSLE_SYNTHESIS_WEIGHTAGE} />
          </>
        )}
      </div>
    </div>
  );
}

// Render markdown emphasis markers — **bold**, __underline__,
// **__both__** — to React nodes. Used by renderQuestionText so the
// English extraction's emphasis (e.g. tested word in Grammar MCQ,
// **(16) __observed__**) reads as bold + underline instead of literal
// asterisks and underscores. Plain text segments pass through.
function renderMarkdownInline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  // Order matters: BOTH (**__x__**) first, then bare bold, then bare
  // underline. Greedy capture inside; non-greedy across so adjacent
  // markers don't collapse.
  const re = /\*\*__([^_*][^*]*?)__\*\*|\*\*([^*]+?)\*\*|__([^_]+?)__/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const both = m[1];
    const bold = m[2];
    const under = m[3];
    if (both !== undefined) {
      out.push(<strong key={`b-${key++}`} className="underline decoration-2">{both}</strong>);
    } else if (bold !== undefined) {
      out.push(<strong key={`b-${key++}`}>{bold}</strong>);
    } else if (under !== undefined) {
      out.push(<u key={`u-${key++}`} className="decoration-2 underline-offset-2">{under}</u>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Render question text that may include markdown-style pipe tables —
// Comprehension OEQ stems frequently have a "Character's feelings |
// Evidence from text" table that's unreadable when shown as raw
// pipe-bar text. Parses contiguous `|`-prefixed line blocks into HTML
// tables; non-table paragraphs render as plain text. Inline markdown
// emphasis (**bold**, __underline__) is parsed via renderMarkdownInline
// so Grammar MCQ stems show their tested word bolded + underlined
// instead of literal asterisks.
function renderQuestionText(text: string): React.ReactNode {
  const blocks: Array<React.ReactNode> = [];
  const lines = text.split(/\r?\n/);
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("|") && line.includes("|")) {
      // Collect contiguous table lines.
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      const parsed = tableLines.map(l => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim()));
      // Detect the markdown separator row (e.g. `|---|---|`). Drop it.
      const sepIdx = parsed.findIndex(row => row.every(c => /^:?-{2,}:?$/.test(c)));
      const hasHeader = sepIdx === 1;
      const headerCells = hasHeader ? parsed[0] : null;
      const bodyRows = hasHeader ? parsed.slice(sepIdx + 1) : parsed.filter((_, idx) => idx !== sepIdx);
      blocks.push(
        <table key={`tbl-${key++}`} className="border-collapse my-2 text-sm">
          {headerCells && (
            <thead>
              <tr>{headerCells.map((c, j) => <th key={j} className="border border-slate-300 bg-slate-100 px-3 py-1.5 text-left font-semibold"><MathText text={c} /></th>)}</tr>
            </thead>
          )}
          <tbody>
            {bodyRows.map((row, r) => (
              <tr key={r}>
                {row.map((c, j) => <td key={j} className="border border-slate-300 px-3 py-1.5 align-top"><MathText text={c} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      );
    } else {
      // Collect contiguous non-table lines into one paragraph.
      const para: string[] = [];
      while (i < lines.length && !lines[i].trim().startsWith("|")) {
        para.push(lines[i]);
        i++;
      }
      const txt = para.join("\n").trim();
      if (txt) blocks.push(<p key={`p-${key++}`}><MathText text={txt} /></p>);
    }
  }
  return <div className="space-y-2">{blocks}</div>;
}

// Reformat the structured student-answer JSON the OEQ marker stores
// into readable text. Two shapes are common:
//   - `{"r1c1":"…","r2c1":"…"}`  — labelled-table answers, mapped to
//     `(a) … (b) …` matching the question's labelled rows.
//   - `{"line0":"…","line1":"…"}` — multi-line writing-pad answers,
//     joined back into the original line breaks the kid wrote.
// Falls back to raw text on anything else so we never hide an answer.
function formatStudentAnswer(raw: string): React.ReactNode {
  const txt = raw.trim();
  if (!(txt.startsWith("{") && txt.endsWith("}"))) return <span className="whitespace-pre-line">{raw}</span>;
  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(txt) as Record<string, string>;
  } catch {
    return <span className="whitespace-pre-line">{raw}</span>;
  }

  // line0 / line1 / line2 — multi-line OEQ writing pad. Sort by index
  // and join with line breaks so the parent reads it as the kid wrote
  // it (one thought per row).
  const lineEntries = Object.entries(parsed)
    .map(([k, v]) => {
      const m = k.match(/^line(\d+)$/i);
      return m ? { idx: parseInt(m[1], 10), value: String(v ?? "") } : null;
    })
    .filter((e): e is { idx: number; value: string } => e !== null)
    .sort((a, b) => a.idx - b.idx);
  if (lineEntries.length > 0) {
    const joined = lineEntries.map(e => e.value.trim()).filter(Boolean).join("\n");
    if (joined.length === 0) return <span className="italic text-rose-500/80">left blank</span>;
    return <span className="whitespace-pre-line">{joined}</span>;
  }

  try {
    const entries = Object.entries(parsed)
      .map(([k, v]) => {
        const m = k.match(/^r(\d+)c(\d+)$/i);
        return m ? { row: parseInt(m[1], 10), col: parseInt(m[2], 10), value: String(v ?? "") } : null;
      })
      .filter((e): e is { row: number; col: number; value: string } => e !== null)
      .sort((a, b) => a.row - b.row || a.col - b.col);
    if (entries.length === 0) return <span className="whitespace-pre-line">{raw}</span>;
    // Group by row → (a) row 1, (b) row 2, etc.
    const byRow = new Map<number, string[]>();
    for (const e of entries) {
      if (!byRow.has(e.row)) byRow.set(e.row, []);
      byRow.get(e.row)!.push(e.value);
    }
    const rows = [...byRow.entries()].sort((a, b) => a[0] - b[0]);
    return (
      <div className="space-y-1">
        {rows.map(([r, vals]) => {
          const label = String.fromCharCode(96 + r);          // 1 → "a", 2 → "b"
          // An empty cell means the kid wrote the OTHER row but left
          // this one blank. Surface that explicitly so the parent
          // doesn't read "(a)" with nothing after it and wonder if
          // the page broke.
          const joined = vals.map(v => v.trim()).filter(Boolean).join(" / ");
          const isEmpty = joined.length === 0;
          return (
            <div key={r}>
              <span className="font-semibold">({label})</span>{" "}
              {isEmpty
                ? <span className="italic text-rose-500/80">left blank</span>
                : joined}
            </div>
          );
        })}
      </div>
    );
  } catch {
    return <span className="whitespace-pre-line">{raw}</span>;
  }
}

function ExpandableExample({ ex, index, accent, childFirst, lazyImages }: { ex: MistakeExample; index: number; accent: "violet" | "orange"; childFirst: string; lazyImages: LazyImages }) {
  const [open, setOpen] = useState(false);
  const accentClass = accent === "violet" ? "text-violet-600" : "text-orange-600";
  const accentBg = accent === "violet" ? "bg-violet-50 border-violet-200" : "bg-orange-50 border-orange-200";
  // Use MathText (not boldifyHtml) so $...$ LaTeX in the workshop's
  // diagnosis text renders as math instead of literal "$\frac{1}{12}$".
  // MathText handles **bold** and __underline__ natively so we drop
  // boldifyHtml from the chain.
  const diagnosisText = emphasiseQuoted(softenTone(ex.whatWentWrong, childFirst));
  // hasFullData controls whether the expander button shows. Cloze
  // questions have an empty transcribedStem (the passage lives in a
  // `_passage` subpart we intentionally strip) — but they STILL have
  // useful MCQ options and / or a student-typed answer worth surfacing.
  // So we open the expander when ANY detail field is non-empty, and
  // render each section conditionally below.
  const hasQuestionText = !!(ex.questionText && ex.questionText.trim().length > 0);
  const hasOptions = ex.isMcq && ex.options.length > 0;
  const hasAnswerText = !!(ex.studentAnswer && ex.studentAnswer.trim().length > 0);
  const hasMarkingNotes = !!(ex.markingNotes && ex.markingNotes.trim().length > 0);
  const hasFullData = hasQuestionText || hasOptions || hasAnswerText || hasMarkingNotes;
  // Lazy-image resolution. The base /api/tutor response ships every
  // diagram + optionImages as null; we mirror the server's old
  // hydration rules here so the card-expand fetch populates them on
  // demand. ex.diagramImageData / ex.optionImages survive only if a
  // server-side path still ships them (none today, kept as a safety
  // belt). The fallback chain matches loadTutorData's pre-lazy logic:
  // diagramImageData wins; imageData is the fallback ONLY when the
  // clean transcribed text is missing (i.e. Math/Sci OEQ with stem
  // baked into the whole-question crop). MCQs with clean text + a
  // redundant imageData should NOT show the raw scan.
  const lazy = ex.questionId ? lazyImages[ex.questionId] : null;
  const resolvedDiagram = ex.diagramImageData
    ?? lazy?.diagramImageData
    ?? (!hasQuestionText ? (lazy?.imageData ?? null) : null);
  const resolvedOptionImages: string[] | null = (Array.isArray(ex.optionImages) && ex.optionImages.length > 0)
    ? ex.optionImages
    : (lazy?.optionImages ?? null);
  const imgSrc = resolvedDiagram
    ? (resolvedDiagram.startsWith("data:") ? resolvedDiagram : `data:image/jpeg;base64,${resolvedDiagram}`)
    : null;
  return (
    <div className="border border-slate-200 rounded-xl bg-white">
      <div className="p-4">
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <p className={`text-xs font-bold ${accentClass}`}>
            Example {index + 1}
            {ex.questionNum ? ` · Q${ex.questionNum}` : ""}
            {ex.paperTitle ? ` · ${ex.paperTitle}` : ""}
          </p>
          {hasFullData && (
            <button onClick={() => setOpen(o => !o)} className="text-xs font-semibold text-[#003366] hover:opacity-75 whitespace-nowrap">
              {open ? "Hide question ↑" : "See full question ↓"}
            </button>
          )}
        </div>
        <p className="text-sm text-slate-700 leading-relaxed"><MathText text={diagnosisText} /></p>
      </div>
      {open && hasFullData && (
        <div className={`border-t border-slate-200 p-4 ${accentBg} rounded-b-xl space-y-3`}>
          {hasQuestionText && (
            <div>
              <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">Question</p>
              <div className="text-sm text-[#001e40] leading-relaxed">{renderQuestionText(ex.questionText ?? "")}</div>
            </div>
          )}
          {imgSrc && (
            <div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imgSrc} alt="Question diagram" className="max-w-full rounded-lg border border-slate-200" />
            </div>
          )}
          {ex.isMcq && ex.options.length > 0 && (
            <div>
              <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">Options</p>
              <div className="space-y-1">
                {ex.options.map((o, k) => {
                  const num = String(k + 1);
                  const isPicked = !!ex.picked && ex.picked.includes(num);
                  const isCorrect = !!ex.correct && ex.correct.includes(num);
                  const bg = isCorrect ? "bg-emerald-100 text-emerald-900" : isPicked ? "bg-rose-100 text-rose-900" : "bg-white text-slate-700";
                  return (
                    <div key={k} className={`px-3 py-1.5 rounded text-sm ${bg}`}>
                      <strong>({num})</strong> <MathText text={o} />
                      {isCorrect && <span className="text-xs font-bold ml-2">✓ correct</span>}
                      {isPicked && !isCorrect && <span className="text-xs font-bold ml-2">✗ {childFirst} picked</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {/* Image-option MCQs (Sci circuits, Math figures). Render as a
              2×2 grid with the same picked/correct highlight scheme so
              parents can see which picture the kid chose vs. the right
              one. Falls through to the chips fallback below only when
              even option images are absent. */}
          {ex.isMcq && ex.options.length === 0 && resolvedOptionImages && resolvedOptionImages.length > 0 && (
            <div>
              <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">Options</p>
              <div className="grid grid-cols-2 gap-2">
                {resolvedOptionImages.map((img, k) => {
                  const num = String(k + 1);
                  const isPicked = !!ex.picked && ex.picked.includes(num);
                  const isCorrect = !!ex.correct && ex.correct.includes(num);
                  const ring = isCorrect
                    ? "ring-2 ring-emerald-400 bg-emerald-50"
                    : isPicked ? "ring-2 ring-rose-400 bg-rose-50" : "ring-1 ring-slate-200 bg-white";
                  const src = img.startsWith("data:") ? img : `data:image/jpeg;base64,${img}`;
                  return (
                    <div key={k} className={`p-2 rounded-lg ${ring}`}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-bold text-slate-700">({num})</span>
                        {isCorrect && <span className="text-[10px] font-bold text-emerald-700">✓ correct</span>}
                        {isPicked && !isCorrect && <span className="text-[10px] font-bold text-rose-700">✗ {childFirst} picked</span>}
                      </div>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={src} alt={`Option ${num}`} className="w-full rounded" />
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {/* Fallback for MCQ examples where the workshop wrongs record
              didn't capture the full options list (older papers, or
              options that lived in a diagram image). Still surface what
              picks are known so the parent can see the wrong/right
              choice numbers — better than rendering nothing. */}
          {ex.isMcq && ex.options.length === 0 && (!ex.optionImages || ex.optionImages.length === 0) && (ex.picked || ex.correct) && (
            <div>
              <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">Answer</p>
              <div className="flex gap-3 text-sm">
                {ex.picked && (
                  <span className="px-3 py-1.5 rounded bg-rose-100 text-rose-900">
                    <span className="font-bold">{childFirst} picked:</span> ({ex.picked})
                  </span>
                )}
                {ex.correct && (
                  <span className="px-3 py-1.5 rounded bg-emerald-100 text-emerald-900">
                    <span className="font-bold">Correct:</span> ({ex.correct})
                  </span>
                )}
              </div>
            </div>
          )}
          {!ex.isMcq && ex.studentAnswer && (
            <div>
              <p className="text-[11px] font-bold text-rose-600 uppercase tracking-wider mb-1">{childFirst} wrote</p>
              <div className="text-sm text-rose-900 leading-relaxed">{formatStudentAnswer(ex.studentAnswer)}</div>
            </div>
          )}
          {/* For OEQs where the kid drew / wrote on a canvas, also show
              the actual composite JPEG saved at submission time. The
              transcribed text above is what the marker read; this is
              what the kid actually put down — useful when the parent
              wants to see handwriting, working steps, or a circuit
              drawing. Endpoint enforces the same parent-of-student auth
              as the rest of the dashboard. */}
          {!ex.isMcq && ex.answerImagePaperId && ex.answerImagePageIndex !== null && (
            <div>
              <p className="text-[11px] font-bold text-rose-600 uppercase tracking-wider mb-1">{childFirst}&apos;s working</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/exam/${ex.answerImagePaperId}/submission?page=${ex.answerImagePageIndex}`}
                alt={`${childFirst}'s drawn answer`}
                className="max-w-full rounded-lg border border-slate-200 bg-white"
              />
            </div>
          )}
          {!ex.isMcq && ex.correct && (
            <div>
              <p className="text-[11px] font-bold text-emerald-700 uppercase tracking-wider mb-1">Correct answer</p>
              <div className="text-sm text-emerald-900 leading-relaxed"><MathText text={ex.correct} /></div>
            </div>
          )}
          {ex.markingNotes && (
            <div>
              <p className="text-[11px] font-bold text-emerald-700 uppercase tracking-wider mb-1">What {childFirst} missed</p>
              <p className="text-sm text-emerald-900 leading-relaxed"><MathText text={emphasiseQuoted(ex.markingNotes)} /></p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
