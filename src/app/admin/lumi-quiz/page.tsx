"use client";

// Internal admin sandbox for the Lumi-quiz endpoint. Hardcoded to
// David Lim's account so we can vet the personalised-quiz flow end-
// to-end before opening it to all parents.
//
// Flow:
//   1. Admin picks a skill + count + opens the modal.
//   2. POST /api/admin/lumi-quiz with David's studentId + the skill.
//   3. Endpoint picks fresh master Qs tagged with that skill, builds
//      a paper, returns a redirectUrl.
//   4. Browser navigates to /quiz/<paperId> — the standard quiz
//      player. Lumi-specific preamble copy can be added later.

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import AdminNav from "@/components/AdminNav";

// Hardcoded for v1 — matches the userId we've been working off in
// conversation. When this graduates from admin sandbox to a real
// parent feature, the studentId comes from the parent dashboard's
// selected-student state.
const DAVID_LIM_ID = "cmm5wf91d000ryrxwaddlo6xh";
const DAVID_LIM_NAME = "David Lim";

const SCIENCE_SKILLS: { value: string; label: string; description: string }[] = [
  {
    value: "graph-trend-describe",
    label: "Graph reading",
    description: "Questions that show a graph or table and ask the student to describe the trend.",
  },
  {
    value: "evidence-then-conclusion",
    label: "Evidence + reason",
    description: "Two-part OEQs where the answer needs evidence (a value, a quote) PLUS the underlying reason.",
  },
  {
    value: "precise-vocabulary",
    label: "Scientific vocabulary",
    description: "Questions whose answer key insists on specific scientific terms (luminous vs lights up, expanded vs got bigger).",
  },
  {
    value: "diagram-interpretation",
    label: "Reading diagrams",
    description: "Questions with a stem diagram the student must read information off (parts, flow, direction).",
  },
  {
    value: "direction-of-relationship",
    label: "How variables relate",
    description: "Questions whose answer requires writing 'as X increases, Y decreases' or similar proportional/inverse statements.",
  },
];

export default function LumiQuizAdminPage() {
  return (
    <Suspense>
      <Content />
    </Suspense>
  );
}

function Content() {
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [skill, setSkill] = useState<string>(SCIENCE_SKILLS[1].value); // evidence-then-conclusion as default
  const [count, setCount] = useState<number>(10);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`)
      .then(r => setAllowed(r.ok))
      .catch(() => setAllowed(false));
  }, [userId]);

  async function handleGenerate() {
    setSubmitting(true);
    setErr(null);
    try {
      const r = await fetch("/api/admin/lumi-quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId: DAVID_LIM_ID,
          subject: "science",
          skillTag: skill,
          count,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.redirectUrl) {
        throw new Error(data?.error ?? data?.detail ?? `failed (${r.status})`);
      }
      router.push(data.redirectUrl);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Generate failed");
      setSubmitting(false);
    }
  }

  if (allowed === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" />
      </div>
    );
  }
  if (!allowed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <p className="text-slate-500 text-sm">Access denied.</p>
      </div>
    );
  }

  const picked = SCIENCE_SKILLS.find(s => s.value === skill)!;

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24 lg:pb-0">
        <div className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3">
          <Link href={`/admin?userId=${userId}`} className="text-slate-400 hover:text-slate-700">
            <span className="material-symbols-outlined">arrow_back</span>
          </Link>
          <div>
            <h1 className="text-lg font-bold text-slate-800">Lumi Quiz — internal test</h1>
            <p className="text-xs text-slate-400">Generate a personalised Science quiz for {DAVID_LIM_NAME}</p>
          </div>
        </div>

        <div className="max-w-xl mx-auto px-4 py-6 space-y-5">
          {/* Status badge */}
          <div className="bg-purple-50 rounded-2xl border border-purple-100 px-4 py-3 flex items-start gap-2">
            <span className="material-symbols-outlined text-purple-600 text-base mt-0.5">psychology</span>
            <div className="text-xs text-purple-900">
              <p className="font-bold">Hardcoded to David Lim for v1.</p>
              <p className="mt-0.5 text-purple-700">
                Generates a 10-question Science quiz from master papers tagged with the picked skill.
                Excludes any question David has already attempted.
                Lands on <code>/quiz/&lt;id&gt;</code> as the parent — open in another browser as David to test the kid view.
              </p>
            </div>
          </div>

          {/* Skill picker */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Skill to drill</p>
            <div className="space-y-2">
              {SCIENCE_SKILLS.map(s => (
                <label
                  key={s.value}
                  className={`flex items-start gap-3 p-3 rounded-xl border-2 cursor-pointer transition-colors ${
                    skill === s.value ? "border-purple-400 bg-purple-50" : "border-slate-100 hover:border-slate-200"
                  }`}
                >
                  <input
                    type="radio"
                    name="skill"
                    value={s.value}
                    checked={skill === s.value}
                    onChange={() => setSkill(s.value)}
                    className="mt-1"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-bold text-slate-800">{s.label}</p>
                    <p className="text-xs text-slate-500 mt-0.5">{s.description}</p>
                    <p className="text-[10px] text-slate-400 mt-1 font-mono">{s.value}</p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Count picker */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3">
            <p className="text-xs font-bold uppercase tracking-wider text-slate-500">Number of questions</p>
            <div className="flex items-center gap-3">
              <input
                type="range" min={3} max={20} value={count}
                onChange={(e) => setCount(parseInt(e.target.value))}
                className="flex-1"
              />
              <div className="w-16 text-center text-2xl font-bold text-slate-800">{count}</div>
            </div>
          </div>

          {/* Error */}
          {err && (
            <div className="bg-red-50 rounded-xl border border-red-200 px-4 py-3 text-sm text-red-800">
              {err}
            </div>
          )}

          {/* Generate */}
          <button
            onClick={handleGenerate}
            disabled={submitting}
            className="w-full py-4 rounded-2xl bg-purple-600 text-white font-bold disabled:opacity-50 hover:bg-purple-700 flex items-center justify-center gap-2"
          >
            {submitting ? (
              <span className="inline-block w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <span className="material-symbols-outlined">auto_awesome</span>
            )}
            {submitting ? "Generating…" : `Generate ${count}-Q ${picked.label} quiz for ${DAVID_LIM_NAME}`}
          </button>
        </div>
      </div>
    </div>
  );
}
