"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import AdminNav from "@/components/AdminNav";

type Subject = "math" | "science" | "english";

type Question = {
  id: string;
  questionNum: string;
  stem: string;
  options: string[];
  correctAnswer: number;
  diagramImageData: string | null;
  paperTitle: string;
  paperYear: string | null;
  paperSchool: string | null;
};

type Variant = {
  stem: string;
  options: string[];
  correctAnswer: number;
  diagramDescription?: string;
  diagramImageData?: string | null;
};

type Drafts = { simple: Variant; similar: Variant } | null;

export default function SyntheticPage() {
  return (
    <Suspense>
      <SyntheticContent />
    </Suspense>
  );
}

function SyntheticContent() {
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [subject, setSubject] = useState<Subject>("math");
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Drafts>>({});
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [savingState, setSavingState] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`)
      .then(r => setAllowed(r.ok))
      .catch(() => setAllowed(false));
  }, [userId]);

  const loadBatch = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/synthetic/batch?userId=${userId}&subject=${subject}`);
      const data = await res.json();
      setQuestions(data.questions ?? []);
      setCurrentIdx(0);
      setDrafts({});
    } finally {
      setLoading(false);
    }
  }, [userId, subject]);

  useEffect(() => { if (allowed) loadBatch(); }, [allowed, loadBatch]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  async function generateOne(q: Question) {
    const res = await fetch("/api/admin/synthetic/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, questionId: q.id, subject }),
    });
    if (!res.ok) return null;
    return (await res.json()) as { simple: Variant; similar: Variant };
  }

  async function generateAll() {
    if (questions.length === 0) return;
    setBulkProgress({ done: 0, total: questions.length });
    let done = 0;
    await Promise.all(questions.map(async q => {
      const result = await generateOne(q);
      done += 1;
      setBulkProgress({ done, total: questions.length });
      if (result) {
        setDrafts(prev => ({ ...prev, [q.id]: result }));
      }
    }));
    setBulkProgress(null);
    showToast("Generation complete");
  }

  async function acceptVariant(q: Question, which: "simple" | "similar") {
    const d = drafts[q.id];
    if (!d) return;
    const key = `save-${q.id}-${which}`;
    setSavingState(key);
    try {
      const res = await fetch("/api/admin/synthetic/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, questionId: q.id, variant: which, data: d[which] }),
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.error ?? "Save failed"); return; }
      showToast(`${which === "simple" ? "Simple" : "Similar"} saved`);
    } finally {
      setSavingState(null);
    }
  }

  async function markGenerated(q: Question) {
    setSavingState(`mark-${q.id}`);
    try {
      const res = await fetch("/api/admin/synthetic/mark-generated", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, questionId: q.id }),
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.error ?? "Mark failed"); return; }
      showToast("Marked generated");
      setQuestions(prev => prev.filter(x => x.id !== q.id));
      setCurrentIdx(idx => Math.max(0, Math.min(idx, questions.length - 2)));
    } finally {
      setSavingState(null);
    }
  }

  function updateVariant(qId: string, which: "simple" | "similar", patch: Partial<Variant>) {
    setDrafts(prev => {
      const curr = prev[qId];
      if (!curr) return prev;
      return { ...prev, [qId]: { ...curr, [which]: { ...curr[which], ...patch } } };
    });
  }

  function updateOption(qId: string, which: "simple" | "similar", idx: number, value: string) {
    setDrafts(prev => {
      const curr = prev[qId];
      if (!curr) return prev;
      const opts = [...curr[which].options];
      opts[idx] = value;
      return { ...prev, [qId]: { ...curr, [which]: { ...curr[which], options: opts } } };
    });
  }

  if (allowed === null) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" /></div>;
  }
  if (!allowed) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><p className="text-slate-500 text-sm">Access denied.</p></div>;
  }

  const q = questions[currentIdx];
  const d = q ? drafts[q.id] : null;
  const anyDrafts = Object.keys(drafts).length > 0;

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24">
        <div className="bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between">
          <div>
            <Link href={`/admin?userId=${userId}`} className="text-xs text-slate-400 hover:text-slate-600">← Admin</Link>
            <h1 className="text-lg font-bold text-slate-800">Generate Synthetic Questions</h1>
            <p className="text-xs text-slate-400">MCQ · batch of 10</p>
          </div>
          <button onClick={loadBatch} disabled={loading}
            className="px-3 py-1.5 rounded-lg bg-slate-800 text-white text-xs font-bold disabled:opacity-50">
            {loading ? "Loading…" : "Reload batch"}
          </button>
        </div>

        <div className="max-w-3xl mx-auto px-4 py-5">
          {/* Subject picker */}
          <div className="flex gap-2 mb-4">
            {(["math", "science", "english"] as const).map(s => (
              <button key={s} onClick={() => setSubject(s)}
                className={`flex-1 py-2.5 rounded-xl border-2 text-sm font-bold transition-all ${subject === s ? "border-slate-800 bg-slate-800 text-white" : "border-slate-200 bg-white text-slate-600"}`}>
                {s === "math" ? "Math" : s === "science" ? "Science" : "English"}
              </button>
            ))}
          </div>

          {/* Generate-all button */}
          {questions.length > 0 && !anyDrafts && (
            <button onClick={generateAll} disabled={bulkProgress !== null}
              className="w-full py-3 rounded-xl bg-blue-600 text-white font-bold mb-4 disabled:opacity-50">
              {bulkProgress ? `Generating ${bulkProgress.done} / ${bulkProgress.total}…` : `Generate 10 ${subject} variants in parallel`}
            </button>
          )}

          {loading && <div className="p-8 text-center text-sm text-slate-400">Loading…</div>}

          {!loading && questions.length === 0 && (
            <div className="p-8 text-center text-sm text-slate-400">No more clean {subject} MCQ questions pending generation.</div>
          )}

          {!loading && q && (
            <>
              {/* Navigation */}
              <div className="flex items-center justify-between mb-4">
                <button onClick={() => setCurrentIdx(i => Math.max(0, i - 1))} disabled={currentIdx === 0}
                  className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-bold text-slate-600 disabled:opacity-30">
                  ← Prev
                </button>
                <p className="text-xs text-slate-500 font-bold">Question {currentIdx + 1} of {questions.length}</p>
                <button onClick={() => setCurrentIdx(i => Math.min(questions.length - 1, i + 1))} disabled={currentIdx >= questions.length - 1}
                  className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-bold text-slate-600 disabled:opacity-30">
                  Next →
                </button>
              </div>

              {/* Original question */}
              <div className="bg-white rounded-2xl border border-slate-200 p-5 mb-4">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Original · {q.paperYear ?? ""} {q.paperSchool ?? ""}</p>
                  <p className="text-[10px] text-slate-400">{q.paperTitle} · Q{q.questionNum}</p>
                </div>
                <p className="text-sm text-slate-800 font-medium whitespace-pre-wrap mb-3">{q.stem}</p>
                {q.diagramImageData && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={q.diagramImageData.startsWith("data:") ? q.diagramImageData : `data:image/jpeg;base64,${q.diagramImageData}`}
                    alt="diagram" className="max-w-sm rounded-lg border border-slate-200 mb-3" />
                )}
                <div className="space-y-1.5">
                  {q.options.map((opt, i) => {
                    const isCorrect = i + 1 === q.correctAnswer;
                    return (
                      <div key={i} className={`flex items-start gap-2 px-3 py-2 rounded-lg text-sm ${isCorrect ? "bg-green-50 border border-green-200 text-green-800 font-bold" : "bg-slate-50 text-slate-700"}`}>
                        <span className="shrink-0">({i + 1})</span>
                        <span className="flex-1">{opt}</span>
                        {isCorrect && <span className="text-[10px] font-bold uppercase shrink-0">Correct</span>}
                      </div>
                    );
                  })}
                </div>
              </div>

              {!d && bulkProgress === null && (
                <p className="text-center text-xs text-slate-400 py-4">No variants generated yet for this question. Click the generate button above.</p>
              )}

              {d && (
                <>
                  <VariantEditor title="Simple variant (changed numbers / reordered)" variant={d.simple}
                    onStem={s => updateVariant(q.id, "simple", { stem: s })}
                    onOption={(i, v) => updateOption(q.id, "simple", i, v)}
                    onCorrect={n => updateVariant(q.id, "simple", { correctAnswer: n })} />
                  <button onClick={() => acceptVariant(q, "simple")} disabled={savingState === `save-${q.id}-simple`}
                    className="w-full py-2.5 rounded-xl bg-green-600 text-white font-bold mb-4 disabled:opacity-50">
                    {savingState === `save-${q.id}-simple` ? "Saving…" : "Accept Simple"}
                  </button>

                  <VariantEditor title="Similar variant (related but different)" variant={d.similar}
                    onStem={s => updateVariant(q.id, "similar", { stem: s })}
                    onOption={(i, v) => updateOption(q.id, "similar", i, v)}
                    onCorrect={n => updateVariant(q.id, "similar", { correctAnswer: n })} />
                  <button onClick={() => acceptVariant(q, "similar")} disabled={savingState === `save-${q.id}-similar`}
                    className="w-full py-2.5 rounded-xl bg-green-600 text-white font-bold mb-4 disabled:opacity-50">
                    {savingState === `save-${q.id}-similar` ? "Saving…" : "Accept Similar"}
                  </button>

                  <button onClick={() => markGenerated(q)} disabled={savingState === `mark-${q.id}`}
                    className="w-full py-3 rounded-xl bg-slate-800 text-white font-bold disabled:opacity-50">
                    {savingState === `mark-${q.id}` ? "Marking…" : "Mark Generated (skip in future)"}
                  </button>
                </>
              )}
            </>
          )}
        </div>

        {toast && (
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-sm px-4 py-2 rounded-xl shadow-lg z-50">
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}

function VariantEditor({ title, variant, onStem, onOption, onCorrect }: {
  title: string;
  variant: Variant;
  onStem: (s: string) => void;
  onOption: (i: number, v: string) => void;
  onCorrect: (n: number) => void;
}) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 mb-3">
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">{title}</p>
      <textarea value={variant.stem} onChange={e => onStem(e.target.value)}
        rows={3}
        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-800 focus:border-slate-500 outline-none resize-none mb-3" />
      {variant.diagramImageData && (
        <div className="mb-3">
          <p className="text-[10px] font-bold uppercase text-slate-400 mb-1">Generated diagram</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={variant.diagramImageData.startsWith("data:") ? variant.diagramImageData : `data:image/png;base64,${variant.diagramImageData}`}
            alt="synthetic diagram" className="max-w-sm rounded-lg border border-slate-200" />
        </div>
      )}
      {variant.diagramDescription && !variant.diagramImageData && (
        <div className="mb-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-[10px] font-bold uppercase text-amber-600 mb-0.5">Diagram suggestion (image generation failed)</p>
          <p className="text-xs text-amber-800">{variant.diagramDescription}</p>
        </div>
      )}
      <div className="space-y-2">
        {variant.options.map((opt, i) => {
          const isCorrect = i + 1 === variant.correctAnswer;
          return (
            <div key={i} className="flex items-start gap-2">
              <button onClick={() => onCorrect(i + 1)}
                className={`shrink-0 w-8 h-8 rounded-lg border-2 text-xs font-bold ${isCorrect ? "bg-green-500 border-green-500 text-white" : "border-slate-200 text-slate-500"}`}>
                ({i + 1})
              </button>
              <textarea value={opt} onChange={e => onOption(i, e.target.value)}
                rows={1}
                className={`flex-1 border rounded-lg px-3 py-2 text-sm resize-none outline-none ${isCorrect ? "border-green-400 bg-green-50 text-green-900 font-semibold" : "border-slate-200 text-slate-800 focus:border-slate-500"}`} />
            </div>
          );
        })}
      </div>
      <p className="text-[10px] text-slate-400 mt-2">Tap the number to mark which option is correct.</p>
    </div>
  );
}
