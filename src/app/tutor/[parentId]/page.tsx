"use client";

import { Suspense, useEffect, useRef, useState, use } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { AdminTopicChart, type SubjectData, type TimelineEntry } from "../../progress/[studentId]/page";
import MathText from "@/components/MathText";

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
  isMcq: boolean;
  options: string[];
  picked: string | null;
  correct: string | null;
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
type TutorData =
  | { kind: "ineligible"; reason: string; paperCount: number }
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
export function TutorBodyForStudent({ studentId, parentId, subject, currentChildName }: {
  studentId: string;
  parentId: string;
  subject: string;
  currentChildName?: string;
}) {
  const [data, setData] = useState<TutorData | null>(null);
  const [loading, setLoading] = useState(false);
  // Current paper count from the cheap /count endpoint. When it's
  // larger than data.topline.paperCount we surface a caveat banner so
  // the parent knows the cached diagnosis is from before the latest
  // quizzes were completed.
  const [currentPaperCount, setCurrentPaperCount] = useState<number | null>(null);

  useEffect(() => {
    // Don't wipe `data` immediately — when switching students, that
    // would flash a spinner for every nav. Instead set loading=true
    // and keep the previous content visible (slightly dimmed in the
    // render below) until the new payload lands. Spinner only shows
    // when there is genuinely nothing to display.
    //
    // Stale-response guard: if the parent switches student A → B
    // before A's fetch resolves, A's late response would otherwise
    // overwrite B's freshly-set data. We capture the (studentId,
    // subject) the effect was queued with and bail in the .then if
    // either has changed — and AbortController kills the in-flight
    // request entirely.
    setLoading(true);
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
    const cacheKey = `tutor-v2-${studentId}-${subject}`;
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
    const queuedFor = { studentId, subject };
    const ctrl = new AbortController();
    fetch(`/api/tutor/${studentId}?subject=${encodeURIComponent(subject)}`, { signal: ctrl.signal })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        // Drop the response if the effect has been superseded.
        if (queuedFor.studentId !== studentId || queuedFor.subject !== subject) return;
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
        // Ignore the AbortError thrown by ctrl.abort() on cleanup —
        // any other failure is logged but doesn't disturb the prior
        // payload still on screen.
        if (err?.name !== "AbortError") console.warn("[tutor] fetch failed:", err);
      })
      .finally(() => {
        if (queuedFor.studentId === studentId && queuedFor.subject === subject) setLoading(false);
      });
    return () => ctrl.abort();
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
          Loading {firstName ? `${firstName}'s` : ""} {subject.toLowerCase()}…
        </div>
      )}
      {showSpinner && (
        <div className="flex flex-col items-center justify-center py-32 gap-6">
          <div className="w-16 h-16 rounded-full border-4 border-slate-100 border-t-[#003366] animate-spin" />
          <p className="text-sm font-medium text-slate-500">Loading {firstName ? `${firstName}'s` : ""} {subject.toLowerCase()} tutor view…</p>
        </div>
      )}
      {data && data.kind === "ineligible" && (
        <div className={`bg-white rounded-2xl border border-slate-200 shadow-sm p-8 text-center transition-opacity ${loading ? "opacity-50" : ""}`}>
          <p className="text-base font-semibold text-[#001e40] mb-2">Not enough data yet</p>
          <p className="text-sm text-slate-600">{data.reason} ({data.paperCount} {subject} paper{data.paperCount === 1 ? "" : "s"} so far.)</p>
        </div>
      )}
      {data && data.kind === "ready" && (
        <div className={`transition-opacity ${loading ? "opacity-50" : ""}`}>
          {paperDelta > 0 && (
            <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Since this diagnosis, {firstName || "your child"} has done {paperDelta} more {subject.toLowerCase()} quiz{paperDelta === 1 ? "" : "zes"}. I&apos;ll update this when more data comes in.
            </div>
          )}
          <ReadyView data={data} parentId={parentId} studentId={studentId} />
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
              <option>Chinese</option>
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

type DetailView =
  | { kind: "mistake"; index: number }
  | { kind: "concept"; index: number };

function ReadyView({ data, parentId, studentId }: { data: Extract<TutorData, { kind: "ready" }>; parentId: string; studentId: string }) {
  const [view, setView] = useState<DetailView | null>(null);
  const isOverview = view === null;
  const stageRef = useRef<HTMLDivElement>(null);
  // When the swipe transitions in either direction, scroll the page
  // so the SWIPE STAGE sits right at the top of the viewport — that
  // way the detail panel's own heading ('Common Mistake · …', 'Conceptual
  // Gap · …') lands flush with the top instead of the user staring
  // at the empty top of the Lumi greeting card above. The -4 px nudge
  // accounts for sub-pixel layout so the section's rounded corner
  // doesn't peek above the fold.
  useEffect(() => {
    if (typeof window === "undefined" || !stageRef.current) return;
    const top = stageRef.current.getBoundingClientRect().top + window.scrollY - 4;
    window.scrollTo({ top, behavior: "smooth" });
  }, [view]);
  return (
    <>
      {/* Lumi greeting — always visible above the swipe stage. On
          mobile we stack the avatar on its own row (centred) above a
          full-width summary; on md+ we revert to the side-by-side
          layout. */}
      <section className="bg-white rounded-2xl border border-slate-200 shadow-sm px-6 sm:px-8 py-6 mb-6 flex flex-col items-center gap-4 md:flex-row md:items-start md:gap-6">
        <LumiAvatar />
        <div className="flex-1 w-full">
          <p className="text-[#001e40] text-base leading-relaxed">
            Hi! I&apos;m <strong>Lumi</strong>, your owl assistant <span className="text-[10px] uppercase tracking-wider font-bold text-violet-600 bg-violet-50 px-1.5 py-0.5 rounded">Beta</span>. Let&apos;s review {data.childFirst}&apos;s progress in {data.subject}.
          </p>
          <LumiSummary data={data} />
          {/* Staleness banner removed — caches refresh daily, so the
              minor drift between regens is acceptable and not worth
              alerting the parent over. The questionId-based resolution
              under enrichExample still keeps examples accurate even
              when drift exists; only the marks-lost % may be slightly
              off until the next daily refresh. */}
        </div>
      </section>

      {/* Swipe stage — flex row holds both panels side-by-side; we
          translate the whole row by -100% to slide overview off
          screen left and bring the detail in from the right. */}
      <div ref={stageRef} className="overflow-hidden scroll-mt-4">
        <div className={`flex transition-transform duration-500 ease-out will-change-transform ${isOverview ? "translate-x-0" : "-translate-x-full"}`}>
          <div className="w-full shrink-0">
            <OverviewPanel data={data} parentId={parentId} studentId={studentId} onSelectMistake={(i) => setView({ kind: "mistake", index: i })} onSelectConcept={(i) => setView({ kind: "concept", index: i })} />
          </div>
          <div className="w-full shrink-0">
            {view !== null && <DetailPanel data={data} view={view} onBack={() => setView(null)} />}
          </div>
        </div>
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
  return text
    .replace(/\bThe student\b/g, fn)
    .replace(/\bthe student\b/g, fn.toLowerCase())
    .replace(directVerbRe, "$1 sometimes $2")
    .replace(namedOftenRe, "$1 sometimes")
    .replace(/\bstruggles to\b/gi, "sometimes finds it tricky to")
    .replace(/\bstruggles with\b/gi, "sometimes finds")
    .replace(/\bfails to\b/gi, "sometimes misses")
    .replace(/\bconsistently\b/gi, "sometimes")
    .replace(/\bcannot\b/gi, "doesn't always");
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
function LumiSummary({ data }: { data: Extract<TutorData, { kind: "ready" }> }) {
  const { childFirst, topline, commonMistakes, conceptualGaps, subject, previousAssessment } = data;
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

  // "Since last check" callout — only renders when the workshop
  // archived a prior assessment in this kid's cache. The first time
  // we run the workshop for a kid, previousAssessment is null and we
  // skip the bullet entirely.
  const sinceLast = previousAssessment ? (() => {
    const date = new Date(previousAssessment.generatedAt).toLocaleDateString();
    const cleared = previousAssessment.patternsCleared.slice(0, 2);
    const avgDelta = previousAssessment.avgDelta;
    const papersGained = previousAssessment.paperCountDelta ?? 0;
    const hasMovement = cleared.length > 0 || (avgDelta !== null && Math.abs(avgDelta) >= 2) || papersGained > 0;
    if (!hasMovement) return null;
    return (
      <li>
        Since the last check on <strong>{date}</strong>:
        {avgDelta !== null && avgDelta >= 2 && <> {childFirst}&apos;s average is <strong>up {Math.round(avgDelta)} percentage points</strong>.</>}
        {avgDelta !== null && avgDelta <= -2 && <> the average has slipped <strong>{Math.abs(Math.round(avgDelta))} percentage points</strong> — worth a look.</>}
        {cleared.length > 0 && <> The pattern{cleared.length > 1 ? "s" : ""} <strong>&ldquo;{cleared.join("”, “")}&rdquo;</strong> {cleared.length > 1 ? "have" : "has"} dropped out of the top 4 — nice progress.</>}
        {papersGained > 0 && cleared.length === 0 && (avgDelta === null || Math.abs(avgDelta) < 2) && <> {childFirst} has completed {papersGained} more {subject.toLowerCase()} paper{papersGained === 1 ? "" : "s"} since.</>}
      </li>
    );
  })() : null;

  return (
    <div className="text-[#001e40] text-sm leading-relaxed mt-3 space-y-2.5">
      <p>
        {childFirst} is making <strong>{status}</strong> progress in {subject}. A few things to take note:
      </p>
      <ul className="space-y-2 list-disc pl-5">
        {sinceLast}
        {avg < 80 && (
          <li>
            Daily quizzes are a good way to get more practices in a short and fun way for {childFirst}.
            Would you like me to set a 10 min MCQ quiz for {childFirst} the next few days? {link("daily-practices-section", "here")}.
            {(subject === "English" || subject === "Chinese") && <> I&apos;ll rotate the sections for the quiz.</>}
          </li>
        )}
        {weak && (
          <li>
            {childFirst}&apos;s weakest topic is <strong>{weak.topic}</strong> ({weak.pct}%).
            A focused practice on this would help — pick this topic in the bar chart above to assign one,
            or jump to {link("topics-section", "Topics for Practice")} below.
          </li>
        )}
        {m1 && (
          <li>
            There are common trends in the mistakes. The biggest pattern is
            {" "}<strong>&ldquo;{m1.name}&rdquo;</strong> ({pctOfSubject(m1.marksLost, topline.totalAvailable)} of the subject score)
            {m2 && <> and <strong>&ldquo;{m2.name}&rdquo;</strong> ({pctOfSubject(m2.marksLost, topline.totalAvailable)})</>}.
            Let&apos;s go through these answering techniques with him {link("mistakes-section", "here")}.
          </li>
        )}
        {concept && (
          <li>
            I notice <strong>&ldquo;{concept.name}&rdquo;</strong> is a common conceptual mistake
            — he&apos;s lost {pctOfSubject(concept.marksLost, topline.totalAvailable)} on questions involving it.
            I have prepared a short explanation module {link("concepts-section", "here")}.
            We can walk through together, plus take a guided quiz.
          </li>
        )}
      </ul>
    </div>
  );
}
function boldifyHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function OverviewPanel({ data, parentId, studentId, onSelectMistake, onSelectConcept }: { data: Extract<TutorData, { kind: "ready" }>; parentId: string; studentId: string; onSelectMistake: (i: number) => void; onSelectConcept: (i: number) => void }) {
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

      {/* Bar chart upfront — clickable bars surface a topic detail
          panel + Assign Focus Practice CTA without needing the user
          to swipe to a separate "Full Progress" view. */}
      <FullProgressEmbed studentId={studentId} parentId={parentId} subject={data.subject} childFirst={data.childFirst} />

      {/* Common Mistakes */}
      {data.commonMistakes.length > 0 && (
        <section id="mistakes-section" className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 mb-6 scroll-mt-20">
          <h2 className="font-headline text-xl font-extrabold text-[#006c49] mb-2">Common Mistakes</h2>
          <p className="text-sm text-slate-500 mb-5">Answering techniques where {data.childFirst} keeps losing marks. Let&apos;s go through these and get some practices to fix these mistakes.</p>
          <div className="space-y-3">
            {data.commonMistakes.map((m, i) => (
              <button key={m.bucket} onClick={() => onSelectMistake(i)} className="w-full text-left border border-slate-100 rounded-xl p-5 flex justify-between items-center bg-slate-50/50 hover:bg-violet-50/40 hover:border-violet-200 transition-colors group">
                <div>
                  <p className="text-xs font-bold text-violet-600 mb-1">Mistake {i + 1} · {m.marksLost} marks lost{(() => { const p = pctOfSubject(m.marksLost, t.totalAvailable); return p ? ` (${p})` : ""; })()}</p>
                  <h3 className="font-headline font-extrabold text-lg text-[#001e40] mb-1">{m.name}</h3>
                  <p className="text-sm text-slate-600 max-w-2xl">{softenTone(m.what, data.childFirst)}</p>
                </div>
                <span className="shrink-0 text-sm font-semibold text-[#003366] group-hover:text-violet-600 ml-4 whitespace-nowrap">
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
              <button key={c.bucket} onClick={() => onSelectConcept(i)} className="w-full text-left border border-slate-100 rounded-xl p-5 flex justify-between items-center bg-slate-50/50 hover:bg-orange-50/40 hover:border-orange-200 transition-colors group">
                <div>
                  <p className="text-xs font-bold text-orange-600 mb-1">Concept · {c.marksLost} marks lost{(() => { const p = pctOfSubject(c.marksLost, t.totalAvailable); return p ? ` (${p})` : ""; })()}</p>
                  <h3 className="font-headline font-extrabold text-lg text-[#001e40] mb-1">{c.name}</h3>
                  <p className="text-sm text-slate-600 max-w-2xl">{softenTone(c.what, data.childFirst)}</p>
                </div>
                <span className="shrink-0 text-sm font-semibold text-[#003366] group-hover:text-orange-600 ml-4 whitespace-nowrap">
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
                    className="shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-[#003366] text-white text-sm font-bold shadow-sm hover:bg-[#001e40] active:scale-[0.98] transition disabled:opacity-60 whitespace-nowrap"
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
        <p className="text-sm text-slate-500 mb-5">Daily bite-sized practices are a good way to level up in a short and fun way.{(data.subject === "English" || data.subject === "Chinese") && " I'll rotate the sections each day so " + data.childFirst + " covers the whole subject."}</p>
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
                ? <><span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />Scheduling…</>
                : <><span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 1" }}>calendar_month</span>{n} day{n === 1 ? "" : "s"} of daily quizzes</>}
            </button>
          ))}
        </div>
        <p className="text-xs text-slate-500 mt-4 italic">After I assign, you can move these around in the weekly calendar at your homepage.</p>
      </section>
    </>
  );
}

function DetailPanel({ data, view, onBack }: { data: Extract<TutorData, { kind: "ready" }>; view: DetailView; onBack: () => void }) {
  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-2 text-sm font-semibold text-slate-600 hover:text-[#003366] mb-4">
        <span className="material-symbols-outlined text-base">arrow_back</span>
        Back to overview
      </button>
      {view.kind === "mistake" && data.commonMistakes[view.index] && (
        <MistakeDetail card={data.commonMistakes[view.index]} childFirst={data.childFirst} totalAvailable={data.topline.totalAvailable} />
      )}
      {view.kind === "concept" && data.conceptualGaps[view.index] && (
        <ConceptDetail card={data.conceptualGaps[view.index]} childFirst={data.childFirst} totalAvailable={data.topline.totalAvailable} />
      )}
    </div>
  );
}

function MistakeDetail({ card, childFirst, totalAvailable }: { card: Extract<TutorData, { kind: "ready" }>["commonMistakes"][number]; childFirst: string; totalAvailable: number }) {
  const adviceHtml = boldifyHtml(softenTone(card.advice, childFirst));
  const pct = pctOfSubject(card.marksLost, totalAvailable);
  return (
    <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8">
      <p className="text-xs font-bold text-violet-600 uppercase tracking-wider mb-2">Common Mistake · {card.marksLost} marks lost{pct ? ` (${pct})` : ""}</p>
      <h2 className="font-headline text-2xl font-extrabold text-[#001e40] mb-2">{card.name}</h2>
      <p className="text-base text-slate-600 leading-relaxed mb-6">{softenTone(card.what, childFirst)}</p>

      <div className="bg-emerald-50 border border-emerald-100 rounded-xl px-5 py-4 mb-6">
        <p className="text-xs font-bold text-emerald-700 uppercase tracking-wider mb-2">Lumi&apos;s Advice</p>
        <p className="text-sm text-emerald-900 leading-relaxed" dangerouslySetInnerHTML={{ __html: adviceHtml }} />
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
              <ExpandableExample key={i} ex={ex} index={i} accent="violet" childFirst={childFirst} />
            ))}
          </div>
        </div>
      )}

      <button className="w-full py-4 rounded-2xl bg-gradient-to-r from-[#003366] to-[#5b21b6] text-white font-bold text-base shadow-md hover:opacity-95">
        Generate Personal Quiz with Guidance →
      </button>
    </section>
  );
}

function ConceptDetail({ card, childFirst, totalAvailable }: { card: Extract<TutorData, { kind: "ready" }>["conceptualGaps"][number]; childFirst: string; totalAvailable: number }) {
  const adviceHtml = boldifyHtml(softenTone(card.advice, childFirst));
  const pct = pctOfSubject(card.marksLost, totalAvailable);
  return (
    <section className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8">
      <p className="text-xs font-bold text-orange-600 uppercase tracking-wider mb-2">Conceptual Gap · {card.marksLost} marks lost{pct ? ` (${pct})` : ""}</p>
      <h2 className="font-headline text-2xl font-extrabold text-[#001e40] mb-2">{card.name}</h2>
      <p className="text-base text-slate-600 leading-relaxed mb-6">{softenTone(card.what, childFirst)}</p>

      <div className="bg-orange-50 border border-orange-100 rounded-xl px-5 py-4 mb-6">
        <p className="text-xs font-bold text-orange-700 uppercase tracking-wider mb-2">Lumi&apos;s Explanation</p>
        <p className="text-sm text-orange-900 leading-relaxed" dangerouslySetInnerHTML={{ __html: adviceHtml }} />
      </div>

      {card.examples.length > 0 && (
        <div className="mb-6">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Where {childFirst} got mixed up</p>
          <div className="space-y-3">
            {card.examples.map((ex, i) => (
              <ExpandableExample key={i} ex={ex} index={i} accent="orange" childFirst={childFirst} />
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

function FullProgressEmbed({ studentId, parentId, subject, childFirst }: { studentId: string; parentId: string; subject: string; childFirst: string }) {
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [progressErr, setProgressErr] = useState(false);
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [assignedToast, setAssignedToast] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/student-progress?parentId=${parentId}&studentId=${studentId}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => d ? setProgress(d as ProgressData) : setProgressErr(true))
      .catch(() => setProgressErr(true));
  }, [studentId, parentId]);

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

function ExpandableExample({ ex, index, accent, childFirst }: { ex: MistakeExample; index: number; accent: "violet" | "orange"; childFirst: string }) {
  const [open, setOpen] = useState(false);
  const accentClass = accent === "violet" ? "text-violet-600" : "text-orange-600";
  const accentBg = accent === "violet" ? "bg-violet-50 border-violet-200" : "bg-orange-50 border-orange-200";
  const diagnosisHtml = boldifyHtml(softenTone(ex.whatWentWrong, childFirst));
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
  const imgSrc = ex.diagramImageData
    ? (ex.diagramImageData.startsWith("data:") ? ex.diagramImageData : `data:image/jpeg;base64,${ex.diagramImageData}`)
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
        <p className="text-sm text-slate-700 leading-relaxed" dangerouslySetInnerHTML={{ __html: diagnosisHtml }} />
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
                      <strong>({num})</strong> {o}
                      {isCorrect && <span className="text-xs font-bold ml-2">✓ correct</span>}
                      {isPicked && !isCorrect && <span className="text-xs font-bold ml-2">✗ {childFirst} picked</span>}
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
          {ex.isMcq && ex.options.length === 0 && (ex.picked || ex.correct) && (
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
          {!ex.isMcq && ex.correct && (
            <div>
              <p className="text-[11px] font-bold text-emerald-700 uppercase tracking-wider mb-1">Correct answer</p>
              <div className="text-sm text-emerald-900 leading-relaxed"><MathText text={ex.correct} /></div>
            </div>
          )}
          {ex.markingNotes && (
            <div>
              <p className="text-[11px] font-bold text-emerald-700 uppercase tracking-wider mb-1">What {childFirst} missed</p>
              <p className="text-sm text-emerald-900 leading-relaxed" dangerouslySetInnerHTML={{ __html: boldifyHtml(ex.markingNotes) }} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
