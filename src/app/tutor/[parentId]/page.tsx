"use client";

import { Suspense, useEffect, useState, use } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

type Topline = {
  avgPct: number;
  totalAwarded: number;
  totalAvailable: number;
  paperCount: number;
  strongTopics: Array<{ topic: string; pct: number }>;
  weakTopics: Array<{ topic: string; pct: number; attempts: number }>;
  nudge: string | null;
};
type MistakeCard = {
  bucket: string;
  name: string;
  what: string;
  advice: string;
  triggerKeywords: string[];
  marksLost: number;
};
type ConceptCard = {
  bucket: string;
  name: string;
  what: string;
  advice: string;
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

function TutorContent({ parentId }: { parentId: string }) {
  const searchParams = useSearchParams();
  const [students, setStudents] = useState<LinkedStudent[]>([]);
  const [studentId, setStudentId] = useState<string | null>(searchParams.get("studentId"));
  const [subject, setSubject] = useState<string>(searchParams.get("subject") ?? "Science");
  const [data, setData] = useState<TutorData | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch(`/api/users/${parentId}`).then(r => r.ok ? r.json() : null).then(d => {
      if (!d?.linkedStudents) return;
      const list = (d.linkedStudents as LinkedStudent[]).filter(s => !!s.id);
      setStudents(list);
      if (!studentId && list.length > 0) setStudentId(list[0].id);
    });
  }, [parentId, studentId]);

  useEffect(() => {
    if (!studentId) return;
    setLoading(true);
    setData(null);
    // Cache key — mirror AI insights: per-day per (student, subject).
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
          try { localStorage.setItem(cacheKey, JSON.stringify(d)); } catch { /* quota — ignore */ }
        }
      })
      .finally(() => setLoading(false));
  }, [studentId, subject]);

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
                {currentChild ? `${currentChild.name.split(/\s+/)[0]}'s ${subject}` : "Loading…"}
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
        {loading && <p className="text-sm text-slate-500">Loading tutor view…</p>}
        {!loading && data && data.kind === "ineligible" && (
          <div className="bg-white rounded-2xl border border-slate-100 p-8 text-center">
            <p className="text-base font-semibold text-[#001e40] mb-2">Not enough data yet</p>
            <p className="text-sm text-slate-600">{data.reason} ({data.paperCount} {subject} paper{data.paperCount === 1 ? "" : "s"} so far.)</p>
          </div>
        )}
        {!loading && data && data.kind === "ready" && <ReadyView data={data} />}

        <p className="text-[11px] text-slate-400 mt-12 text-center">
          {data && data.kind === "ready" && `Refreshed once a day. Last updated ${new Date(data.generatedAt).toLocaleString()}.`}
        </p>
      </main>

      <main className="lg:hidden max-w-5xl mx-auto px-6 py-12 text-center">
        <p className="text-sm text-slate-500">Tutor is best viewed on a larger screen — please open this on a desktop or tablet.</p>
      </main>
    </div>
  );
}

function ReadyView({ data }: { data: Extract<TutorData, { kind: "ready" }> }) {
  const t = data.topline;
  return (
    <>
      {/* Topline */}
      <section className="bg-white rounded-2xl border border-slate-100 p-8 mb-6">
        <div className="flex items-baseline justify-between mb-1">
          <h2 className="text-sm font-bold text-slate-500 uppercase tracking-wider">Overview</h2>
          <p className="text-xs text-slate-400">{t.paperCount} {data.subject} paper{t.paperCount === 1 ? "" : "s"}</p>
        </div>
        <div className="flex items-baseline gap-3 mt-3 mb-6">
          <span className="text-5xl font-headline font-black text-[#001e40]">{t.avgPct}%</span>
          <span className="text-sm text-slate-500">avg ({t.totalAwarded}/{t.totalAvailable} marks)</span>
        </div>
        <div className="grid grid-cols-2 gap-6">
          <div>
            <p className="text-xs font-bold text-emerald-700 uppercase tracking-wider mb-2">Strong on</p>
            {t.strongTopics.length === 0 ? <p className="text-sm text-slate-400 italic">No standouts yet</p>
              : t.strongTopics.map(s => (
                <div key={s.topic} className="flex items-baseline justify-between py-1">
                  <span className="text-sm text-[#001e40] font-medium">{s.topic}</span>
                  <span className="text-xs font-bold text-emerald-700">{s.pct}%</span>
                </div>
              ))}
          </div>
          <div>
            <p className="text-xs font-bold text-rose-700 uppercase tracking-wider mb-2">Weak on</p>
            {t.weakTopics.length === 0 ? <p className="text-sm text-slate-400 italic">Nothing flagged</p>
              : t.weakTopics.map(w => (
                <div key={w.topic} className="flex items-baseline justify-between py-1">
                  <span className="text-sm text-[#001e40] font-medium">{w.topic}</span>
                  <span className="text-xs font-bold text-rose-700">{w.pct}%</span>
                </div>
              ))}
          </div>
        </div>
        {t.nudge && (
          <div className="mt-6 bg-amber-50 border border-amber-100 rounded-xl px-4 py-3">
            <p className="text-sm text-amber-900 leading-relaxed">💛 {t.nudge}</p>
          </div>
        )}
      </section>

      {/* Common Mistakes */}
      {data.commonMistakes.length > 0 && (
        <section className="mb-6">
          <h2 className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-3">Common Mistakes</h2>
          <p className="text-sm text-slate-500 mb-4">Answering techniques where {data.childFirst} keeps losing marks. Fix these and the marks come back fastest.</p>
          {data.commonMistakes.map((m, i) => (
            <div key={m.bucket} className="bg-white rounded-2xl border border-slate-100 p-6 mb-3 flex justify-between items-center">
              <div>
                <p className="text-xs font-bold text-violet-600 mb-1">Mistake {i + 1}</p>
                <h3 className="font-headline font-extrabold text-lg text-[#001e40] mb-1">{m.name}</h3>
                <p className="text-sm text-slate-600 max-w-2xl">{m.what}</p>
              </div>
              <button className="shrink-0 text-sm font-semibold text-[#003366] hover:text-violet-600 ml-4 whitespace-nowrap">
                Tell me more →
              </button>
            </div>
          ))}
        </section>
      )}

      {/* Conceptual Gaps */}
      {data.conceptualGaps.length > 0 && (
        <section className="mb-6">
          <h2 className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-3">Conceptual Gaps</h2>
          <p className="text-sm text-slate-500 mb-4">Concepts {data.childFirst} consistently mixes up — worth explaining and quizzing on.</p>
          {data.conceptualGaps.map(c => (
            <div key={c.bucket} className="bg-white rounded-2xl border border-slate-100 p-6 mb-3 flex justify-between items-center">
              <div>
                <p className="text-xs font-bold text-orange-600 mb-1">Concept</p>
                <h3 className="font-headline font-extrabold text-lg text-[#001e40] mb-1">{c.name}</h3>
                <p className="text-sm text-slate-600 max-w-2xl">{c.what}</p>
              </div>
              <button className="shrink-0 text-sm font-semibold text-[#003366] hover:text-orange-600 ml-4 whitespace-nowrap">
                Explain →
              </button>
            </div>
          ))}
        </section>
      )}

      {/* Topics for Practice */}
      {data.topicsForPractice.length > 0 && (
        <section className="mb-6">
          <h2 className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-3">Topics for Practice</h2>
          <p className="text-sm text-slate-500 mb-4">Below average — a Focused Practice on each will lift the score.</p>
          <div className="bg-white rounded-2xl border border-slate-100 divide-y divide-slate-100">
            {data.topicsForPractice.map(t => (
              <div key={t.topic} className="flex justify-between items-center p-5">
                <div>
                  <p className="font-semibold text-[#001e40] text-base">{t.topic}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{t.attempts} attempts · {t.pct}% avg</p>
                </div>
                <button className="text-sm font-semibold text-[#003366] hover:text-violet-600 whitespace-nowrap">
                  Assign Focused Practice →
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
