"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { listMasterClasses } from "@/data/master-class";

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
        <div className="mb-6 bg-gradient-to-br from-emerald-50 to-sky-50 border border-emerald-100 rounded-2xl p-5 text-sm text-slate-700 leading-relaxed">
          This series of Master Classes is meant to help your student ace the <strong className="font-bold text-emerald-800">scoring</strong> of topics. We have generally found that students understand the concepts, but either find it difficult to apply their understanding or answer in such a way to score full marks. These classes are meant to address this. We have deeply analysed questions and scoring patterns across years of PSLE to pull out the key topics and common mistakes, as well as tricks to score the full marks. There are also customised quizzes to ONLY practice on those scoring techniques, <strong className="font-bold text-emerald-800">personalised</strong> to each student.
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
                className="w-full text-left bg-white rounded-2xl border border-slate-100 shadow-sm p-5 hover:border-emerald-300 hover:shadow-md transition-all flex items-center gap-4"
              >
                <div className="w-14 h-14 rounded-2xl bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-2xl">school</span>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-headline font-bold text-base text-[#001e40]">{mc.title}</p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {mc.level} · <strong className="font-bold text-[#001e40]">{mc.stats.psleSubjectPercent}%</strong> of PSLE Life-Science · {mc.keyConcepts.length} slides
                  </p>
                </div>
                <span className="material-symbols-outlined text-slate-300 shrink-0">chevron_right</span>
              </button>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
