"use client";

// Admin-only "Revise Work" modal. Surfaces a per-subject mistake
// summary across the student's last 100 completed papers and lets the
// admin compile either:
//   - a marked review paper (questions + the student's prior wrong
//     answers + correct answers, navigable like any review)
//   - a blank practice paper for the student to retry
//
// Sliders pick how many questions to include; ordering rules are
// applied server-side (MCQ-then-OEQ for math/science; English groups
// by topic with comp-OEQ last).

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type SubjectKey = "math" | "science" | "english";

type SubjectSummary = {
  mistakeCount: number;
  paperCount: number;
  topTopics: string[];
  earliestAt: string | null;
};

type Summary = {
  studentName: string;
  studentLevel: number | null;
  papersScanned: number;
  bySubject: Record<SubjectKey, SubjectSummary>;
};

const SUBJECT_TABS: { key: SubjectKey; label: string }[] = [
  { key: "math", label: "Math" },
  { key: "science", label: "Science" },
  { key: "english", label: "English" },
];

export default function ReviseWorkModal({
  studentId,
  studentName,
  onClose,
}: {
  studentId: string;
  studentName: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<SubjectKey>("math");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [count, setCount] = useState(10);
  const [submitting, setSubmitting] = useState<"review" | "practice" | null>(null);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  // Fetch summary on open + whenever student changes.
  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    setLoadErr(null);
    fetch(`/api/admin/student-revision/summary?studentId=${studentId}`)
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok) {
          setLoadErr(data?.error ?? `summary failed (${r.status})`);
          return;
        }
        setSummary(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadErr(err instanceof Error ? err.message : "fetch failed");
      });
    return () => { cancelled = true; };
  }, [studentId]);

  // Whenever the active tab changes, snap the slider to a sensible
  // default — half the available mistakes, capped at 30.
  useEffect(() => {
    if (!summary) return;
    const max = summary.bySubject[activeTab].mistakeCount;
    if (max === 0) { setCount(0); return; }
    const def = Math.min(30, Math.max(5, Math.round(max / 2)));
    setCount(Math.min(def, max));
  }, [summary, activeTab]);

  async function handleCompile(mode: "review" | "practice") {
    if (!summary) return;
    setSubmitting(mode);
    setSubmitErr(null);
    try {
      const res = await fetch("/api/admin/student-revision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId, subject: activeTab, count, mode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.redirectUrl) {
        throw new Error(data?.error ?? `compile failed (${res.status})`);
      }
      onClose();
      router.push(data.redirectUrl);
    } catch (err) {
      setSubmitErr(err instanceof Error ? err.message : "compile failed");
    } finally {
      setSubmitting(null);
    }
  }

  const sub = summary?.bySubject[activeTab];
  const max = sub?.mistakeCount ?? 0;
  const hasOver30 = max > 30;

  return (
    <div className="fixed inset-0 bg-black/50 z-[80] flex items-end lg:items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-t-3xl lg:rounded-3xl w-full max-w-md p-6 shadow-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-headline text-lg font-extrabold text-[#001e40]">Revise Work</h3>
          <button onClick={onClose} className="text-[#43474f] hover:text-[#001e40]" aria-label="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <p className="text-sm text-[#43474f] mb-4">
          Review <span className="font-bold text-[#001e40]">{studentName}</span>&apos;s mistakes from the last {summary?.papersScanned ?? "…"} papers.
        </p>

        {/* Subject tabs */}
        <div className="flex gap-1 bg-slate-100 p-1 rounded-xl mb-4">
          {SUBJECT_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`flex-1 py-2 rounded-lg text-sm font-bold transition-all ${activeTab === t.key ? "bg-white text-[#001e40] shadow-sm" : "text-slate-500"}`}
            >
              {t.label}
              {summary && (
                <span className={`ml-1.5 text-[10px] font-semibold ${activeTab === t.key ? "text-[#003366]" : "text-slate-400"}`}>
                  {summary.bySubject[t.key].mistakeCount}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Body */}
        {loadErr ? (
          <p className="text-sm text-red-600 py-6 text-center">{loadErr}</p>
        ) : !summary ? (
          <div className="py-10 flex flex-col items-center gap-3 text-center">
            <span className="inline-block w-8 h-8 border-2 border-[#dce9ff] border-t-[#003366] rounded-full animate-spin" />
            <p className="text-sm text-[#43474f]">Analysing recent papers…</p>
          </div>
        ) : !sub || sub.mistakeCount === 0 ? (
          <div className="py-10 text-center">
            <span className="material-symbols-outlined text-4xl text-[#6cf8bb] mb-2 block">celebration</span>
            <p className="text-sm font-bold text-[#001e40]">No {activeTab} mistakes in the last {summary.papersScanned} papers.</p>
            <p className="text-xs text-[#43474f] mt-1">Try a different subject tab.</p>
          </div>
        ) : (
          <div>
            <p className="text-sm text-[#0b1c30] leading-relaxed mb-4">
              {summary.studentName} has <span className="font-extrabold text-[#001e40]">{sub.mistakeCount} mistake{sub.mistakeCount === 1 ? "" : "s"}</span> in the last {summary.papersScanned} assignments
              {sub.topTopics.length > 0 && (
                <>, covering topics such as <span className="font-bold text-[#001e40]">{sub.topTopics.slice(0, 3).join(", ")}</span></>
              )}.
              <br />Would you like to go through them or create a practice?
            </p>

            <div className="bg-[#eff4ff] rounded-2xl p-4 mb-3">
              <div className="flex items-end justify-between mb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-[#43474f]">Questions to include</span>
                <span className="font-headline text-2xl font-extrabold text-[#001e40] tabular-nums">{count}</span>
              </div>
              <input
                type="range"
                min={Math.min(5, max)}
                max={max}
                step={1}
                value={count}
                onChange={(e) => setCount(parseInt(e.target.value, 10))}
                className="w-full accent-[#003366]"
                disabled={!!submitting}
              />
              <div className="flex justify-between text-[10px] text-[#43474f] mt-1">
                <span>{Math.min(5, max)}</span>
                <span>{max}</span>
              </div>
              {hasOver30 && (
                <p className="text-[11px] text-[#43474f] mt-2 italic">We will prioritise recent mistakes.</p>
              )}
            </div>

            {submitErr && (
              <p className="text-xs text-red-600 mb-3">{submitErr}</p>
            )}

            <div className="flex gap-2">
              <button
                onClick={() => handleCompile("review")}
                disabled={!!submitting || count === 0}
                className="flex-1 py-3 rounded-xl border-2 border-[#003366] text-[#003366] text-sm font-bold hover:bg-[#eff4ff] disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {submitting === "review"
                  ? <span className="inline-block w-4 h-4 border-2 border-[#003366]/30 border-t-[#003366] rounded-full animate-spin" />
                  : <span className="material-symbols-outlined text-base">menu_book</span>}
                Compile and review
              </button>
              <button
                onClick={() => handleCompile("practice")}
                disabled={!!submitting || count === 0}
                className="flex-1 py-3 rounded-xl bg-[#006c49] text-white text-sm font-bold disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {submitting === "practice"
                  ? <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  : <span className="material-symbols-outlined text-base">edit</span>}
                Compile and set paper
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
