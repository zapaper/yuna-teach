"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { listMasterClasses, type MasterClassContent } from "@/data/master-class";
import type { SubTopicMastery } from "@/lib/master-class/mastery";

const SUBJECTS = ["Science", "Math", "English", "Chinese"] as const;

export default function Page() {
  return (
    <Suspense>
      <MasterClassList />
    </Suspense>
  );
}

function MasterClassList() {
  const userId = useSearchParams().get("userId") ?? "";
  const router = useRouter();
  const [activeSubject, setActiveSubject] = useState<(typeof SUBJECTS)[number]>("Science");

  const allClasses = listMasterClasses();
  const filtered = allClasses.filter(
    mc => mc.subject.toLowerCase() === activeSubject.toLowerCase(),
  );

  // Mastery state per master-class, keyed by slug. Populated by
  // parallel fetches on mount. Map slug -> per-sub-topic mastery
  // rows. Undefined while loading; empty array if student hasn't
  // taken any quiz yet (all sub-topics will be "untested").
  const [mastery, setMastery] = useState<Record<string, SubTopicMastery[]>>({});
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    Promise.all(allClasses.map(async (mc) => {
      try {
        const r = await fetch(`/api/master-class/${mc.slug}/mastery?studentId=${userId}`);
        if (!r.ok) return [mc.slug, [] as SubTopicMastery[]] as const;
        const d = await r.json() as { subTopics: SubTopicMastery[] };
        return [mc.slug, d.subTopics] as const;
      } catch {
        return [mc.slug, [] as SubTopicMastery[]] as const;
      }
    })).then(rows => {
      if (cancelled) return;
      setMastery(Object.fromEntries(rows));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  return (
    <div className="min-h-screen bg-[#f8f9ff]">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-slate-100">
        <div className="max-w-3xl mx-auto px-4 lg:px-8 py-3 flex items-center justify-between">
          <button
            onClick={() => router.push(`/home/${userId}`)}
            className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-slate-100 transition-colors"
            title="Back to home"
          >
            <span className="material-symbols-outlined text-[#001e40]">arrow_back</span>
          </button>
          <h1 className="font-headline font-bold text-lg text-[#001e40]">Master Class</h1>
          <div className="w-10" />
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 lg:px-8 pt-5 pb-24">
        {/* Badges — one per Master Class the student has fully
            mastered (every sub-topic at 100% on the most recent
            attempt). The class's generated icon serves as the
            badge. Hidden when nothing's been earned yet. */}
        {(() => {
          const earned = allClasses.filter(mc => {
            const rows = mastery[mc.slug];
            if (!rows || rows.length === 0) return false;
            return rows.every(r => r.state === "mastered");
          });
          if (earned.length === 0) return null;
          return (
            <div className="mb-4 bg-gradient-to-br from-amber-50 to-emerald-50 border border-amber-200 rounded-2xl p-4">
              <p className="text-[10px] font-bold uppercase tracking-wider text-amber-800 mb-2">🏆 Badges earned</p>
              <div className="flex flex-wrap gap-3">
                {earned.map(mc => (
                  <div key={mc.slug} className="flex flex-col items-center gap-1 w-16">
                    <div className="w-14 h-14 rounded-full overflow-hidden ring-2 ring-amber-400 bg-white shadow-md">
                      <img
                        src={`/api/master-class/${mc.slug}/icon`}
                        alt={mc.title}
                        title={mc.title}
                        className="w-full h-full object-cover"
                      />
                    </div>
                    <p className="text-[9px] text-slate-600 text-center leading-tight line-clamp-2">{mc.title}</p>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}

        {/* Subject filter — pretty pill row at the top. Only "Science"
            is currently enabled; others are disabled until we author
            content for them. */}
        <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
          {SUBJECTS.map(s => {
            const hasContent = allClasses.some(c => c.subject.toLowerCase() === s.toLowerCase());
            const isActive = s === activeSubject;
            return (
              <button
                key={s}
                onClick={() => hasContent && setActiveSubject(s)}
                disabled={!hasContent}
                className={`px-5 py-2 rounded-full text-sm font-bold whitespace-nowrap transition-all shrink-0 ${
                  isActive
                    ? "bg-[#001e40] text-white shadow-md"
                    : hasContent
                      ? "bg-white text-[#001e40] hover:bg-blue-50 ring-1 ring-slate-200"
                      : "bg-slate-100 text-slate-400 ring-1 ring-slate-200 cursor-not-allowed"
                }`}
              >
                {s}
                {!hasContent && <span className="ml-1.5 text-[10px] opacity-60">Soon</span>}
              </button>
            );
          })}
        </div>

        {/* Headline + explainer */}
        <div className="mt-6 mb-5">
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">PSLE-focused deep dives</p>
          <h2 className="font-headline text-2xl font-extrabold text-[#001e40] mt-1">
            Master the highest-tested topics
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Each Master Class is an animated lesson with narration, scoring examples, and a 10 + 6 quiz at the end.
          </p>
        </div>

        {/* Explainer card — sets parent expectations on what these
            Master Classes are FOR (scoring marks, not re-teaching
            concepts students already know). */}
        <div className="mb-6 bg-gradient-to-br from-emerald-50 to-sky-50 border border-emerald-100 rounded-2xl p-5 text-sm text-slate-700 leading-relaxed space-y-3">
          <p>
            This series of Master Classes is meant to help your student ace the scoring of topics. We have generally found that students understand the concepts, but either find it difficult to apply their understanding or answer in such a way to score full marks.
          </p>
          <p>
            We have deeply analysed questions and scoring patterns across years of PSLE to pull out the key topics and common mistakes, as well as techniques to score the full marks. There are also customised quizzes to <strong className="font-bold text-emerald-800">ONLY</strong> practice on those scoring techniques, <strong className="font-bold text-emerald-800">personalised</strong> to each student.
          </p>
        </div>

        {/* Cards */}
        {filtered.length === 0 ? (
          <div className="bg-white border border-slate-100 rounded-2xl p-8 text-center text-sm text-slate-500 shadow-sm">
            No Master Classes available for {activeSubject} yet — we&apos;re adding them soon.
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map(mc => (
              <button
                key={mc.slug}
                onClick={() => router.push(`/master-class/${mc.slug}?userId=${userId}`)}
                className="w-full text-left bg-white rounded-2xl border border-slate-100 shadow-sm p-5 hover:border-emerald-300 hover:shadow-md transition-all"
              >
                <div className="flex items-center gap-4">
                  {/* Per-class generated icon. Falls back to the
                      generic school glyph if the file isn't there
                      yet (e.g. a freshly-added class before the
                      icon-gen script has been re-run). */}
                  <div className="w-24 h-24 lg:w-28 lg:h-28 rounded-2xl bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0 overflow-hidden">
                    <img
                      src={`/api/master-class/${mc.slug}/icon`}
                      alt=""
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        const t = e.currentTarget;
                        t.style.display = "none";
                        const sib = t.nextElementSibling as HTMLElement | null;
                        if (sib) sib.style.display = "";
                      }}
                    />
                    <span className="material-symbols-outlined text-4xl" style={{ display: "none" }}>school</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-headline font-bold text-base text-[#001e40]">{mc.title}</p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {mc.level} · {renderHeadlineFraction(mc)} · {mc.keyConcepts.length} slides
                    </p>
                  </div>
                  <span className="material-symbols-outlined text-slate-300 shrink-0">chevron_right</span>
                </div>
                {/* Sub-topic mastery chips. Untested = grey, mastered =
                    green with check, weak = yellow. Only shown when
                    the master class actually has sub-topics defined. */}
                {(mc.subTopics?.length ?? 0) > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-3">
                    {(mastery[mc.slug] ?? mc.subTopics!.map(s => ({ id: s.id, label: s.label, state: "untested" as const }))).map(st => (
                      <SubTopicChip key={st.id} state={st.state} label={st.label} />
                    ))}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

// Headline fraction shown in the card subtitle. Prefer the pieChart
// stats (percentage + label) when authored — that's the most
// student-friendly framing. Falls back to the older
// `psleSubjectPercent` field when no chart is set.
function renderHeadlineFraction(mc: MasterClassContent): React.ReactNode {
  const slideWithChart = mc.keyConcepts.find(s => s.pieChart);
  const pc = slideWithChart?.pieChart;
  if (pc) {
    return (
      <>
        <strong className="font-bold text-[#001e40]">{pc.percentage}%</strong> {pc.label}
      </>
    );
  }
  return (
    <>
      <strong className="font-bold text-[#001e40]">{mc.stats.psleSubjectPercent}%</strong> of PSLE Science
    </>
  );
}

function SubTopicChip({ state, label }: { state: SubTopicMastery["state"]; label: string }) {
  const styles = state === "mastered"
    ? "bg-emerald-100 text-emerald-800 border-emerald-200"
    : state === "weak"
      ? "bg-amber-100 text-amber-800 border-amber-200"
      : "bg-slate-100 text-slate-500 border-slate-200";
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border ${styles}`}>
      {state === "mastered" && <span className="material-symbols-outlined text-[12px] leading-none">check_circle</span>}
      {label}
    </span>
  );
}
