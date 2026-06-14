"use client";

import { Suspense, useEffect, useRef, useState, use } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { AdminTopicChart, type SubjectData, type TimelineEntry } from "../../progress/[studentId]/page";

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
    };

type LinkedStudent = { id: string; name: string };

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

  useEffect(() => {
    // Don't wipe `data` immediately — when switching students, that
    // would flash a spinner for every nav. Instead set loading=true
    // and keep the previous content visible (slightly dimmed in the
    // render below) until the new payload lands. Spinner only shows
    // when there is genuinely nothing to display.
    setLoading(true);
    const cacheKey = `tutor-${studentId}-${subject}-${new Date().toDateString()}`;
    const cached = typeof window !== "undefined" ? localStorage.getItem(cacheKey) : null;
    if (cached) {
      try { setData(JSON.parse(cached) as TutorData); setLoading(false); return; } catch { /* ignore */ }
    }
    fetch(`/api/tutor/${studentId}?subject=${encodeURIComponent(subject)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d) {
          setData(d as TutorData);
          try {
            const slim = stripImagesForCache(d as TutorData);
            localStorage.setItem(cacheKey, JSON.stringify(slim));
            pruneOldTutorCacheKeys(cacheKey);
          } catch { /* quota — ignore */ }
        }
      })
      .finally(() => setLoading(false));
  }, [studentId, subject]);

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
          <ReadyView data={data} parentId={parentId} studentId={studentId} />
        </div>
      )}
      <p className="text-[11px] text-slate-400 mt-12 text-center">
        {data && data.kind === "ready" && `Refreshed once a day. Last updated ${new Date(data.generatedAt).toLocaleString()}.`}
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
    Promise.all([
      fetch(`/api/users?userId=${parentId}`).then(r => r.ok ? r.json() : null),
      fetch(`/api/tutor/admin-students`).then(r => r.ok ? r.json() : null),
    ]).then(([parentResp, adminResp]) => {
      const linked = (parentResp?.user?.linkedStudents as LinkedStudent[] | undefined) ?? [];
      const adminExtras = (adminResp?.students as LinkedStudent[] | undefined) ?? [];
      const merged = new Map<string, LinkedStudent>();
      for (const s of linked) if (s.id) merged.set(s.id, s);
      for (const s of adminExtras) if (s.id) merged.set(s.id, s);
      const list = [...merged.values()];
      setStudents(list);
      if (!studentId && list.length > 0) setStudentId(list[0].id);
    });
  }, [parentId, studentId]);

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
                {students.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
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
  // When the swipe slides in the detail panel, scroll the page back
  // to the top so the user lands at the start of the panel and isn't
  // looking at empty space below where they clicked. Same on the way
  // back to overview — they came from somewhere they'd already
  // scrolled past, but on overview we want them at the top of the
  // bar chart again.
  useEffect(() => {
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }, [view]);
  return (
    <>
      {/* Lumi greeting — always visible above the swipe stage */}
      <section className="bg-white rounded-2xl border border-slate-200 shadow-sm px-8 py-6 mb-6 flex items-start gap-6">
        <LumiAvatar />
        <div className="flex-1">
          <p className="text-[#001e40] text-base leading-relaxed">
            Hi! I&apos;m <strong>Lumi</strong> your owl assistant <span className="text-[10px] uppercase tracking-wider font-bold text-violet-600 bg-violet-50 px-1.5 py-0.5 rounded">Beta</span>. Let&apos;s review {data.childFirst}&apos;s progress in {data.subject}.
          </p>
          <LumiSummary data={data} />
        </div>
      </section>

      {/* Swipe stage — flex row holds both panels side-by-side; we
          translate the whole row by -100% to slide overview off
          screen left and bring the detail in from the right. */}
      <div className="overflow-hidden">
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
  const { childFirst, topline, commonMistakes, conceptualGaps, subject } = data;
  const weak = topline.weakTopics[0];
  const m1 = commonMistakes[0];
  const m2 = commonMistakes[1];
  const concept = conceptualGaps[0];
  const avg = topline.avgPct;
  const status = avg >= 75 ? "good" : avg >= 60 ? "steady" : "tough";

  // Empty cache → simple fallback (the action briefing needs at
  // least one of weak topic / mistake / concept to be meaningful).
  if (!weak && !m1 && !concept) {
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

  return (
    <div className="text-[#001e40] text-sm leading-relaxed mt-3 space-y-2.5">
      <p>
        {childFirst} is making <strong>{status}</strong> progress in {subject}. A few things to take note:
      </p>
      <ul className="space-y-2 list-disc pl-5">
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
            Lastly, there are concepts worth refreshing with {childFirst}. I notice
            {" "}<strong>&ldquo;{concept.name}&rdquo;</strong> is one to revisit
            — he&apos;s lost {pctOfSubject(concept.marksLost, topline.totalAvailable)} on questions involving it.
            I&apos;ve put a short module {link("concepts-section", "here")} we can walk through together, plus a quick quiz.
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
          <p className="text-sm text-slate-500 mb-5">Answering techniques where {data.childFirst} keeps losing marks. Fix these and the marks come back fastest.</p>
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
        <p className="text-xs font-bold text-emerald-700 uppercase tracking-wider mb-2">Jane&apos;s Advice</p>
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
        <p className="text-xs font-bold text-orange-700 uppercase tracking-wider mb-2">Jane&apos;s Explanation</p>
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

function ExpandableExample({ ex, index, accent, childFirst }: { ex: MistakeExample; index: number; accent: "violet" | "orange"; childFirst: string }) {
  const [open, setOpen] = useState(false);
  const accentClass = accent === "violet" ? "text-violet-600" : "text-orange-600";
  const accentBg = accent === "violet" ? "bg-violet-50 border-violet-200" : "bg-orange-50 border-orange-200";
  const diagnosisHtml = boldifyHtml(softenTone(ex.whatWentWrong, childFirst));
  const hasFullData = ex.questionText !== null;
  const imgSrc = ex.diagramImageData
    ? (ex.diagramImageData.startsWith("data:") ? ex.diagramImageData : `data:image/jpeg;base64,${ex.diagramImageData}`)
    : null;
  return (
    <div className="border border-slate-200 rounded-xl bg-white">
      <div className="p-4">
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <p className={`text-xs font-bold ${accentClass}`}>
            Example {index + 1}{ex.paperTitle ? ` · ${ex.paperTitle}` : ""}
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
          <div>
            <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">Question</p>
            <p className="text-sm text-[#001e40] leading-relaxed whitespace-pre-line">{ex.questionText}</p>
          </div>
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
              <p className="text-sm text-rose-900 leading-relaxed whitespace-pre-line">{ex.studentAnswer}</p>
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
