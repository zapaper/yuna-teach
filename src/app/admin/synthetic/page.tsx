"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import DiagramEditor from "@/components/DiagramEditor";
import AdminNav from "@/components/AdminNav";

type Subject = "math" | "science" | "english";

type Question = {
  id: string;
  questionNum: string;
  stem: string;
  // English synthesis questions don't have MCQ options — keep the field optional.
  options: string[] | null;
  // When the source question uses image options, this holds 4 base64 data URIs.
  optionImages?: (string | null)[] | null;
  // Math/Science: numeric 1-4. English synthesis: the transformed-sentence text.
  correctAnswer: number | string;
  diagramImageData: string | null;
  syntheticGenerated?: boolean;
  syntheticQuestions?: Array<{ variant: string; stem: string; options: string[]; correctAnswer: number; diagramImageData: string | null }>;
  paperTitle: string;
  paperYear: string | null;
  paperSchool: string | null;
};

type Decision = "accepted" | "rejected" | null;

type Variant = {
  stem: string;
  options: string[];
  correctAnswer: number;
  diagramDescription?: string;
  diagramImageData?: string | null;
  // Present when the variant uses image options (mirrors source question shape).
  optionImages?: (string | null)[];
  optionImageDescriptions?: string[];
};

// Image-option options are packed as data URIs into the options[] array so they
// survive the existing SyntheticQuestion schema without a migration. A single
// data: URI prefix is enough to detect.
function isImageOptionString(s: string | null | undefined): boolean {
  return typeof s === "string" && s.startsWith("data:image/");
}
function hasImageOptions(opts: (string | null)[] | null | undefined): boolean {
  return Array.isArray(opts) && opts.some(o => isImageOptionString(o ?? ""));
}

type DraftPair = { simple: Variant; similar: Variant };
type Drafts = DraftPair | null;
// Additional pairs produced by the "Generate more" button, keyed by source
// question id. Each pair saves under variant names "simple2"/"similar2",
// "simple3"/"similar3", … so the existing (simple, similar) DB rows stay put.
function moreVariantName(kind: "simple" | "similar", pairIdx: number) {
  // pairIdx starts at 1 for the first additional pair; concat as suffix.
  return `${kind}${pairIdx + 1}`;
}

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
  // Narrow the source pool further by level + exam type. Empty = no filter.
  const [level, setLevel] = useState<string>("");
  const [examTypes, setExamTypes] = useState<Set<string>>(new Set());
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Drafts>>({});
  // Additional variant pairs per question appended by the "Generate more" button.
  const [morePairs, setMorePairs] = useState<Record<string, DraftPair[]>>({});
  const [decisions, setDecisions] = useState<Record<string, { simple: Decision; similar: Decision }>>({});
  // Decisions for additional pairs: indexed by question then by pair index (0 = first extra pair).
  const [moreDecisions, setMoreDecisions] = useState<Record<string, Array<{ simple: Decision; similar: Decision }>>>({});
  const [lockedIds, setLockedIds] = useState<Set<string>>(new Set());
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [savingState, setSavingState] = useState<string | null>(null);
  const [regenPrompts, setRegenPrompts] = useState<Record<string, string>>({});
  const [regenerating, setRegenerating] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [counts, setCounts] = useState<{ total: number; groups: Array<{ subject: string; level: string; examType: string; count: number }> } | null>(null);
  const [countsOpen, setCountsOpen] = useState(false);
  const [backfilling, setBackfilling] = useState(false);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`)
      .then(r => setAllowed(r.ok))
      .catch(() => setAllowed(false));
  }, [userId]);

  const loadBatch = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ userId, subject });
      if (level) params.set("level", level);
      if (examTypes.size > 0) params.set("examTypes", [...examTypes].join(","));
      const res = await fetch(`/api/admin/synthetic/batch?${params.toString()}`);
      const data = await res.json();
      const qs: Question[] = data.questions ?? [];
      setQuestions(qs);
      setCurrentIdx(0);
      // Prefill primary-pair drafts + any additional pairs saved under
      // simpleN/similarN from previous "Generate more" runs.
      const nextDrafts: Record<string, Drafts> = {};
      const nextDecisions: Record<string, { simple: Decision; similar: Decision }> = {};
      const nextMorePairs: Record<string, DraftPair[]> = {};
      const nextMoreDecisions: Record<string, Array<{ simple: Decision; similar: Decision }>> = {};
      // Unpack any image-option variant rows from the DB. Image options live in
      // the `options` JSON array as data URIs — lift them back onto
      // `optionImages` for the editor, and blank out the textual `options`.
      const unpack = (v: { stem: string; options: string[]; correctAnswer: number; diagramImageData: string | null }): Variant => {
        const opts = Array.isArray(v.options) ? v.options : [];
        if (opts.length === 4 && opts.some(o => isImageOptionString(o))) {
          return {
            stem: v.stem,
            options: ["", "", "", ""],
            correctAnswer: v.correctAnswer,
            diagramImageData: v.diagramImageData,
            optionImages: opts,
          };
        }
        return { stem: v.stem, options: opts, correctAnswer: v.correctAnswer, diagramImageData: v.diagramImageData };
      };
      for (const q of qs) {
        if (!q.syntheticQuestions || q.syntheticQuestions.length === 0) continue;
        const simple = q.syntheticQuestions.find(x => x.variant === "simple");
        const similar = q.syntheticQuestions.find(x => x.variant === "similar");
        if (simple && similar) {
          nextDrafts[q.id] = { simple: unpack(simple), similar: unpack(similar) };
        }
        nextDecisions[q.id] = {
          simple: simple ? "accepted" : null,
          similar: similar ? "accepted" : null,
        };
        // Scan for simpleN / similarN (N >= 2) to rebuild morePairs.
        const extras: Array<{ simple?: Variant; similar?: Variant; simpleOk: boolean; similarOk: boolean }> = [];
        for (const row of q.syntheticQuestions) {
          const m = row.variant.match(/^(simple|similar)(\d+)$/);
          if (!m) continue;
          const kind = m[1] as "simple" | "similar";
          const pairIdx = parseInt(m[2], 10) - 2; // "simple2" → idx 0 in morePairs
          if (pairIdx < 0) continue;
          while (extras.length <= pairIdx) extras.push({ simpleOk: false, similarOk: false });
          extras[pairIdx][kind] = { stem: row.stem, options: row.options, correctAnswer: row.correctAnswer, diagramImageData: row.diagramImageData };
          if (kind === "simple") extras[pairIdx].simpleOk = true;
          else extras[pairIdx].similarOk = true;
        }
        const pairs: DraftPair[] = [];
        const dec: Array<{ simple: Decision; similar: Decision }> = [];
        for (const e of extras) {
          if (e.simple && e.similar) {
            pairs.push({
              simple: unpack({ stem: e.simple.stem, options: e.simple.options, correctAnswer: e.simple.correctAnswer, diagramImageData: e.simple.diagramImageData ?? null }),
              similar: unpack({ stem: e.similar.stem, options: e.similar.options, correctAnswer: e.similar.correctAnswer, diagramImageData: e.similar.diagramImageData ?? null }),
            });
            dec.push({ simple: e.simpleOk ? "accepted" : null, similar: e.similarOk ? "accepted" : null });
          }
        }
        if (pairs.length > 0) { nextMorePairs[q.id] = pairs; nextMoreDecisions[q.id] = dec; }
      }
      setDrafts(nextDrafts);
      setDecisions(nextDecisions);
      setMorePairs(nextMorePairs);
      setMoreDecisions(nextMoreDecisions);
      setLockedIds(new Set());
    } finally {
      setLoading(false);
    }
  }, [userId, subject, level, examTypes]);

  useEffect(() => { if (allowed) loadBatch(); }, [allowed, loadBatch]);

  const loadCounts = useCallback(async () => {
    const res = await fetch("/api/admin/synthetic/counts");
    if (!res.ok) return;
    setCounts(await res.json());
  }, []);

  useEffect(() => { if (allowed) loadCounts(); }, [allowed, loadCounts]);

  async function runBackfill() {
    setBackfilling(true);
    try {
      const res = await fetch("/api/admin/synthetic/backfill-exam-type", { method: "POST" });
      const data = await res.json();
      if (!res.ok) { showToast(data.error ?? "Backfill failed"); return; }
      showToast(`Backfilled: ${data.updated} updated, ${data.skipped} skipped`);
      await loadCounts();
    } finally { setBackfilling(false); }
  }

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

  async function setDecision(q: Question, which: "simple" | "similar", decision: Exclude<Decision, null>) {
    const d = drafts[q.id];
    if (!d) return;
    const key = `save-${q.id}-${which}`;
    setSavingState(key);
    try {
      if (decision === "accepted") {
        // Synthesis variants have an `answer` field and no meaningful options.
        // Pack the answer into options[0] so the existing schema (options Json,
        // correctAnswer Int) can carry it without a migration. Save endpoint
        // treats options.length === 1 as the synthesis shape.
        const v = d[which] as (typeof d)[typeof which] & { answer?: string };
        // Image-option variants: pack the 4 data URIs into options[] — the
        // existing schema already stores options as JSON, so no migration.
        const packImageOptions = Array.isArray(v.optionImages) && hasImageOptions(v.optionImages);
        const payload = (v.answer && v.answer.trim())
          ? { stem: v.stem, options: [v.answer.trim()], correctAnswer: 1, diagramImageData: v.diagramImageData ?? null }
          : packImageOptions
          ? { stem: v.stem, options: v.optionImages!.map(o => o ?? ""), correctAnswer: v.correctAnswer, diagramImageData: v.diagramImageData ?? null }
          : v;
        const res = await fetch("/api/admin/synthetic/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, questionId: q.id, variant: which, data: payload }),
        });
        const data = await res.json();
        if (!res.ok) { showToast(data.error ?? "Save failed"); return; }
      } else {
        const res = await fetch("/api/admin/synthetic/save", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, questionId: q.id, variant: which }),
        });
        if (!res.ok) { showToast("Reject failed"); return; }
      }
      setDecisions(prev => ({
        ...prev,
        [q.id]: { ...(prev[q.id] ?? { simple: null, similar: null }), [which]: decision },
      }));
    } finally {
      setSavingState(null);
    }
  }

  async function skipQuestion(q: Question) {
    setSavingState(`skip-${q.id}`);
    try {
      const res = await fetch("/api/admin/synthetic/skip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: q.id }),
      });
      if (!res.ok) { showToast("Skip failed"); return; }
      showToast("Skipped — moved to end of queue");
      setQuestions(prev => prev.filter(x => x.id !== q.id));
      setCurrentIdx(idx => Math.max(0, Math.min(idx, questions.length - 2)));
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
      showToast("Marked generated — locked");
      setLockedIds(prev => { const next = new Set(prev); next.add(q.id); return next; });
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

  async function regenerateDiagram(q: Question, which: "simple" | "similar", reset = false) {
    const d = drafts[q.id];
    if (!d) return;
    const key = `${q.id}-${which}`;
    setRegenerating(key);
    try {
      const res = await fetch("/api/admin/synthetic/regen-diagram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceQuestionId: q.id,
          variantStem: d[which].stem,
          diagramDescription: d[which].diagramDescription,
          userPrompt: reset ? undefined : regenPrompts[key],
          ...(reset ? { mode: "reset" } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.error ?? "Regen failed"); return; }
      updateVariant(q.id, which, { diagramImageData: data.diagramImageData });
      if (reset) setRegenPrompts(prev => ({ ...prev, [key]: "" }));
    } finally {
      setRegenerating(null);
    }
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
  const locked = q ? lockedIds.has(q.id) : false;
  const qDecisions = q ? (decisions[q.id] ?? { simple: null, similar: null }) : { simple: null as Decision, similar: null as Decision };

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
          <div className="flex gap-2 mb-3">
            {(["math", "science", "english"] as const).map(s => (
              <button key={s} onClick={() => setSubject(s)}
                className={`flex-1 py-2.5 rounded-xl border-2 text-sm font-bold transition-all ${subject === s ? "border-slate-800 bg-slate-800 text-white" : "border-slate-200 bg-white text-slate-600"}`}>
                {s === "math" ? "Math" : s === "science" ? "Science" : "English"}
              </button>
            ))}
          </div>

          {/* Level + exam-type filters — narrow the source pool. */}
          <div className="flex flex-wrap gap-3 mb-4 items-center">
            <div className="flex items-center gap-2">
              <label className="text-xs font-bold text-slate-500">Level</label>
              <select value={level} onChange={e => setLevel(e.target.value)}
                className="px-2 py-1.5 rounded-lg border border-slate-200 text-xs bg-white focus:outline-none focus:border-slate-500">
                <option value="">Any</option>
                <option value="P3">P3</option>
                <option value="P4">P4</option>
                <option value="P5">P5</option>
                <option value="P6">P6</option>
              </select>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <label className="text-xs font-bold text-slate-500">Exam type</label>
              {(["WA1", "WA2", "EOY", "Prelim"] as const).map(t => {
                const on = examTypes.has(t);
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setExamTypes(prev => {
                      const next = new Set(prev);
                      if (next.has(t)) next.delete(t); else next.add(t);
                      return next;
                    })}
                    className={`px-2.5 py-1 rounded-full text-[11px] font-bold border-2 transition ${on ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-600 border-slate-200"}`}
                  >
                    {t}
                  </button>
                );
              })}
              {examTypes.size > 0 && (
                <button type="button" onClick={() => setExamTypes(new Set())}
                  className="text-[11px] text-slate-400 hover:text-slate-600 underline">
                  clear
                </button>
              )}
            </div>
          </div>

          {/* Bank inventory — collapsible, shows per subject/level/examType counts */}
          <div className="mb-4 rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="flex items-stretch">
              <button onClick={() => setCountsOpen(o => !o)}
                className="flex-1 flex items-center justify-between px-4 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-50">
                <span>Synthetic bank inventory {counts ? `· ${counts.total} questions` : "(loading…)"}</span>
                <span>{countsOpen ? "▲" : "▼"}</span>
              </button>
              <button onClick={runBackfill} disabled={backfilling}
                className={`px-3 border-l border-slate-200 text-[11px] font-bold whitespace-nowrap ${backfilling ? "bg-slate-100 text-slate-400" : "bg-indigo-50 text-indigo-700 hover:bg-indigo-100"}`}>
                {backfilling ? "Backfilling…" : "Backfill examType"}
              </button>
            </div>
            {countsOpen && counts && (
              <div className="border-t border-slate-100 max-h-80 overflow-y-auto">
                {counts.groups.length === 0 ? (
                  <p className="px-4 py-3 text-xs text-slate-400">No synthetic questions generated yet.</p>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr>
                        <th className="px-3 py-1.5 text-left font-bold">Subject</th>
                        <th className="px-3 py-1.5 text-left font-bold">Level</th>
                        <th className="px-3 py-1.5 text-left font-bold">Exam type</th>
                        <th className="px-3 py-1.5 text-right font-bold">Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {counts.groups.map(g => (
                        <tr key={`${g.subject}-${g.level}-${g.examType}`} className="border-t border-slate-100">
                          <td className="px-3 py-1.5 text-slate-700">{g.subject}</td>
                          <td className="px-3 py-1.5 text-slate-700">{g.level}</td>
                          <td className="px-3 py-1.5 text-slate-700">{g.examType}</td>
                          <td className="px-3 py-1.5 text-right font-bold tabular-nums text-slate-800">{g.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
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
                {Array.isArray(q.optionImages) && q.optionImages.some(Boolean) ? (
                  // Image-option MCQ — show the 4 slot images in a grid.
                  <div className="grid grid-cols-2 gap-2">
                    {q.optionImages.map((img, i) => {
                      const isCorrect = i + 1 === q.correctAnswer;
                      if (!img) {
                        return (
                          <div key={i} className={`flex items-center justify-center h-24 rounded-lg text-xs ${isCorrect ? "bg-green-50 border border-green-200 text-green-800" : "bg-slate-50 text-slate-400"}`}>
                            ({i + 1}) (no image)
                          </div>
                        );
                      }
                      const src = img.startsWith("data:") ? img : `data:image/jpeg;base64,${img}`;
                      return (
                        <div key={i} className={`relative rounded-lg overflow-hidden border ${isCorrect ? "border-green-400 ring-2 ring-green-200" : "border-slate-200"}`}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={src} alt={`option ${i + 1}`} className="w-full h-28 object-contain bg-white" />
                          <span className={`absolute top-1 left-1 px-1.5 py-0.5 rounded text-[10px] font-bold ${isCorrect ? "bg-green-600 text-white" : "bg-slate-700/80 text-white"}`}>
                            ({i + 1}){isCorrect ? " ✓" : ""}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : Array.isArray(q.options) && q.options.length > 0 ? (
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
                ) : (
                  // Synthesis / OEQ: render the expected answer as a single block.
                  <div className="px-3 py-2 rounded-lg text-sm bg-green-50 border border-green-200 text-green-800 whitespace-pre-wrap">
                    <span className="text-[10px] font-bold uppercase mr-2">Expected answer</span>
                    {typeof q.correctAnswer === "string" ? q.correctAnswer : ""}
                  </div>
                )}
              </div>

              {!d && bulkProgress === null && (
                <p className="text-center text-xs text-slate-400 py-4">No variants generated yet for this question. Click the generate button above.</p>
              )}
              {!d && bulkProgress !== null && (
                <div className="flex items-center justify-center gap-2 py-6 text-sm font-bold text-blue-600">
                  <span className="inline-block animate-spin rounded-full h-4 w-4 border-2 border-blue-200 border-t-blue-500" />
                  Still generating…
                </div>
              )}

              {d && (
                <div className={locked ? "opacity-40 pointer-events-none" : ""}>
                  <VariantEditor title="Simple variant (changed numbers / reordered)" variant={d.simple} disabled={locked}
                    hasOriginalDiagram={!!q.diagramImageData}
                    regenPrompt={regenPrompts[`${q.id}-simple`] ?? ""}
                    setRegenPrompt={v => setRegenPrompts(prev => ({ ...prev, [`${q.id}-simple`]: v }))}
                    regenerating={regenerating === `${q.id}-simple`}
                    onRegenDiagram={() => regenerateDiagram(q, "simple")}
                    onResetDiagram={() => regenerateDiagram(q, "simple", true)}
                    onStem={s => updateVariant(q.id, "simple", { stem: s })}
                    onOption={(i, v) => updateOption(q.id, "simple", i, v)}
                    onCorrect={n => updateVariant(q.id, "simple", { correctAnswer: n })}
                    onDiagramEdit={base64 => updateVariant(q.id, "simple", { diagramImageData: base64 })} />
                  <DecisionButtons which="simple" decision={qDecisions.simple} savingState={savingState}
                    questionId={q.id}
                    onChoose={dec => setDecision(q, "simple", dec)} />

                  <VariantEditor title="Similar variant (related but different)" variant={d.similar} disabled={locked}
                    hasOriginalDiagram={!!q.diagramImageData}
                    regenPrompt={regenPrompts[`${q.id}-similar`] ?? ""}
                    setRegenPrompt={v => setRegenPrompts(prev => ({ ...prev, [`${q.id}-similar`]: v }))}
                    regenerating={regenerating === `${q.id}-similar`}
                    onRegenDiagram={() => regenerateDiagram(q, "similar")}
                    onResetDiagram={() => regenerateDiagram(q, "similar", true)}
                    onStem={s => updateVariant(q.id, "similar", { stem: s })}
                    onOption={(i, v) => updateOption(q.id, "similar", i, v)}
                    onCorrect={n => updateVariant(q.id, "similar", { correctAnswer: n })}
                    onDiagramEdit={base64 => updateVariant(q.id, "similar", { diagramImageData: base64 })} />
                  <DecisionButtons which="similar" decision={qDecisions.similar} savingState={savingState}
                    questionId={q.id}
                    onChoose={dec => setDecision(q, "similar", dec)} />
                </div>
              )}

              {/* Additional pairs from "Generate more" — each renders below the primary pair. */}
              {!locked && (morePairs[q.id] ?? []).map((pair, pairIdx) => {
                const pairDec = (moreDecisions[q.id] ?? [])[pairIdx] ?? { simple: null, similar: null };
                const updatePair = (which: "simple" | "similar", patch: Partial<Variant>) => {
                  setMorePairs(prev => {
                    const list = [...(prev[q.id] ?? [])];
                    if (!list[pairIdx]) return prev;
                    list[pairIdx] = { ...list[pairIdx], [which]: { ...list[pairIdx][which], ...patch } };
                    return { ...prev, [q.id]: list };
                  });
                };
                const updatePairOption = (which: "simple" | "similar", i: number, value: string) => {
                  setMorePairs(prev => {
                    const list = [...(prev[q.id] ?? [])];
                    if (!list[pairIdx]) return prev;
                    const opts = [...list[pairIdx][which].options];
                    opts[i] = value;
                    list[pairIdx] = { ...list[pairIdx], [which]: { ...list[pairIdx][which], options: opts } };
                    return { ...prev, [q.id]: list };
                  });
                };
                async function savePair(which: "simple" | "similar", decision: Exclude<Decision, null>) {
                  const variant = moreVariantName(which, pairIdx + 1); // pairIdx 0 is the FIRST extra → simple2
                  const key = `save-${q.id}-${variant}`;
                  setSavingState(key);
                  try {
                    if (decision === "accepted") {
                      const v = pair[which] as Variant & { answer?: string };
                      const packImageOptions = Array.isArray(v.optionImages) && hasImageOptions(v.optionImages);
                      const payload = (v.answer && v.answer.trim())
                        ? { stem: v.stem, options: [v.answer.trim()], correctAnswer: 1, diagramImageData: v.diagramImageData ?? null }
                        : packImageOptions
                        ? { stem: v.stem, options: v.optionImages!.map(o => o ?? ""), correctAnswer: v.correctAnswer, diagramImageData: v.diagramImageData ?? null }
                        : v;
                      const res = await fetch("/api/admin/synthetic/save", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ userId, questionId: q.id, variant, data: payload }),
                      });
                      const data = await res.json();
                      if (!res.ok) { showToast(data.error ?? "Save failed"); return; }
                    } else {
                      const res = await fetch("/api/admin/synthetic/save", {
                        method: "DELETE",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ userId, questionId: q.id, variant }),
                      });
                      if (!res.ok) { showToast("Reject failed"); return; }
                    }
                    setMoreDecisions(prev => {
                      const list = [...(prev[q.id] ?? [])];
                      while (list.length <= pairIdx) list.push({ simple: null, similar: null });
                      list[pairIdx] = { ...list[pairIdx], [which]: decision };
                      return { ...prev, [q.id]: list };
                    });
                  } finally { setSavingState(null); }
                }
                return (
                  <div key={`more-${pairIdx}`} className="mt-6 pt-6 border-t-2 border-dashed border-slate-300">
                    <p className="text-xs font-bold text-slate-500 mb-3">Additional pair #{pairIdx + 2}</p>
                    <VariantEditor title="Simple variant" variant={pair.simple} disabled={false}
                      hasOriginalDiagram={!!q.diagramImageData}
                      regenPrompt={""} setRegenPrompt={() => {}}
                      regenerating={false}
                      onRegenDiagram={() => {}} onResetDiagram={() => {}}
                      onStem={s => updatePair("simple", { stem: s })}
                      onOption={(i, v) => updatePairOption("simple", i, v)}
                      onCorrect={n => updatePair("simple", { correctAnswer: n })}
                      onDiagramEdit={base64 => updatePair("simple", { diagramImageData: base64 })} />
                    <DecisionButtons which="simple" decision={pairDec.simple} savingState={savingState}
                      questionId={`${q.id}-more${pairIdx}`} onChoose={dec => savePair("simple", dec)} />
                    <VariantEditor title="Similar variant" variant={pair.similar} disabled={false}
                      hasOriginalDiagram={!!q.diagramImageData}
                      regenPrompt={""} setRegenPrompt={() => {}}
                      regenerating={false}
                      onRegenDiagram={() => {}} onResetDiagram={() => {}}
                      onStem={s => updatePair("similar", { stem: s })}
                      onOption={(i, v) => updatePairOption("similar", i, v)}
                      onCorrect={n => updatePair("similar", { correctAnswer: n })}
                      onDiagramEdit={base64 => updatePair("similar", { diagramImageData: base64 })} />
                    <DecisionButtons which="similar" decision={pairDec.similar} savingState={savingState}
                      questionId={`${q.id}-more${pairIdx}`} onChoose={dec => savePair("similar", dec)} />
                  </div>
                );
              })}

              {d && !locked && (
                <button
                  onClick={async () => {
                    setSavingState(`regen-${q.id}`);
                    try {
                      const result = await generateOne(q);
                      if (result) {
                        setMorePairs(prev => ({ ...prev, [q.id]: [...(prev[q.id] ?? []), result] }));
                        setMoreDecisions(prev => ({ ...prev, [q.id]: [...(prev[q.id] ?? []), { simple: null, similar: null }] }));
                        showToast("Added 2 new variants");
                      } else {
                        showToast("Generation failed");
                      }
                    } finally { setSavingState(null); }
                  }}
                  disabled={savingState === `regen-${q.id}`}
                  className="w-full py-3 rounded-xl border-2 border-blue-300 bg-blue-50 text-blue-700 font-bold disabled:opacity-50 mt-4"
                >
                  {savingState === `regen-${q.id}` ? "Generating…" : "Generate more (add 2 new variants)"}
                </button>
              )}
              {d && !locked && (
                <button onClick={() => markGenerated(q)} disabled={savingState === `mark-${q.id}`}
                  className="w-full py-3 rounded-xl bg-slate-800 text-white font-bold disabled:opacity-50 mt-2">
                  {savingState === `mark-${q.id}` ? "Marking…" : "Mark Generated (lock this question)"}
                </button>
              )}
              {!locked && (
                <button onClick={() => skipQuestion(q)} disabled={savingState === `skip-${q.id}`}
                  className="w-full py-2 rounded-xl border border-slate-300 text-slate-600 text-xs font-bold disabled:opacity-50 mt-2">
                  {savingState === `skip-${q.id}` ? "Skipping…" : "Skip — come back later"}
                </button>
              )}
              {locked && (
                <p className="text-center text-xs font-bold text-slate-500 mt-4">Locked · marked generated</p>
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

function DecisionButtons({ which, decision, savingState, questionId, onChoose }: {
  which: "simple" | "similar";
  decision: Decision;
  savingState: string | null;
  questionId: string;
  onChoose: (d: "accepted" | "rejected") => void;
}) {
  const saving = savingState === `save-${questionId}-${which}`;
  return (
    <div className="flex gap-2 mb-4">
      <button onClick={() => onChoose("accepted")} disabled={saving}
        className={`flex-1 py-2.5 rounded-xl border-2 text-sm font-bold transition-all disabled:opacity-50 ${decision === "accepted" ? "bg-green-600 border-green-600 text-white" : "border-green-600 text-green-600 bg-white"}`}>
        {saving && decision !== "accepted" ? "…" : "Accept"}
      </button>
      <button onClick={() => onChoose("rejected")} disabled={saving}
        className={`flex-1 py-2.5 rounded-xl border-2 text-sm font-bold transition-all disabled:opacity-50 ${decision === "rejected" ? "bg-red-500 border-red-500 text-white" : "border-red-400 text-red-500 bg-white"}`}>
        {saving && decision !== "rejected" ? "…" : "Don't Accept"}
      </button>
    </div>
  );
}

function VariantEditor({ title, variant, disabled, hasOriginalDiagram, regenPrompt, setRegenPrompt, regenerating, onRegenDiagram, onResetDiagram, onStem, onOption, onCorrect, onDiagramEdit }: {
  title: string;
  variant: Variant;
  disabled?: boolean;
  hasOriginalDiagram?: boolean;
  regenPrompt?: string;
  setRegenPrompt?: (v: string) => void;
  regenerating?: boolean;
  onRegenDiagram?: () => void;
  onResetDiagram?: () => void;
  onStem: (s: string) => void;
  onOption: (i: number, v: string) => void;
  onCorrect: (n: number) => void;
  onDiagramEdit?: (editedBase64: string) => void;
}) {
  const [editingDiagram, setEditingDiagram] = useState(false);
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 mb-3">
      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2">{title}</p>
      <textarea value={variant.stem} onChange={e => onStem(e.target.value)} disabled={disabled}
        rows={3}
        className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-800 focus:border-slate-500 outline-none resize-none mb-3 disabled:bg-slate-50" />
      {variant.diagramImageData && (
        <div className="mb-3">
          <div className="flex items-center justify-between mb-1">
            <p className="text-[10px] font-bold uppercase text-slate-400">Generated diagram</p>
            {onDiagramEdit && (
              <button onClick={() => setEditingDiagram(true)} className="text-xs text-violet-500 hover:text-violet-700 font-semibold">Edit</button>
            )}
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={variant.diagramImageData.startsWith("data:") ? variant.diagramImageData : `data:image/png;base64,${variant.diagramImageData}`}
            alt="synthetic diagram"
            className={`max-w-sm rounded-lg border border-slate-200 ${onDiagramEdit ? "cursor-pointer hover:opacity-80 transition-opacity" : ""}`}
            onClick={() => { if (onDiagramEdit) setEditingDiagram(true); }}
          />
          {editingDiagram && onDiagramEdit && (
            <DiagramEditor
              imageBase64={variant.diagramImageData}
              onSave={(edited) => { onDiagramEdit(edited); setEditingDiagram(false); }}
              onClose={() => setEditingDiagram(false)}
            />
          )}
        </div>
      )}
      {variant.diagramDescription && !variant.diagramImageData && (
        <div className="mb-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
          <p className="text-[10px] font-bold uppercase text-amber-600 mb-0.5">Diagram suggestion (image generation failed)</p>
          <p className="text-xs text-amber-800">{variant.diagramDescription}</p>
        </div>
      )}
      {hasOriginalDiagram && onRegenDiagram && (
        <div className="mb-3 p-2 border border-dashed border-slate-200 rounded-lg space-y-1.5">
          <textarea
            value={regenPrompt ?? ""}
            onChange={e => setRegenPrompt?.(e.target.value)}
            placeholder="Optional: describe how to redraw the diagram (e.g. 'use a clearer bar model', 'add labels A, B, C')"
            rows={2}
            disabled={disabled}
            className="w-full text-xs border border-slate-200 rounded px-2 py-1.5 focus:border-slate-500 outline-none resize-none disabled:bg-slate-50"
          />
          <div className="flex gap-1.5">
            <button onClick={onRegenDiagram} disabled={disabled || regenerating}
              className="flex-1 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold disabled:opacity-50">
              {regenerating ? "Regenerating…" : variant.diagramImageData ? "Regenerate diagram" : "Generate diagram"}
            </button>
            {onResetDiagram && (
              <button onClick={onResetDiagram} disabled={disabled || regenerating}
                className="px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-600 text-xs font-bold disabled:opacity-50"
                title="Regenerate from original AI description, ignoring the prompt above">
                Reset
              </button>
            )}
          </div>
        </div>
      )}
      {Array.isArray(variant.optionImages) && variant.optionImages.some(Boolean) ? (
        // Image-option MCQ: 4 generated option images, click slot to mark correct.
        <>
          <div className="grid grid-cols-2 gap-2">
            {variant.optionImages.map((img, i) => {
              const isCorrect = i + 1 === variant.correctAnswer;
              const src = img ? (img.startsWith("data:") ? img : `data:image/png;base64,${img}`) : null;
              return (
                <button key={i} type="button" onClick={() => onCorrect(i + 1)}
                  className={`relative rounded-lg overflow-hidden border-2 transition-all ${isCorrect ? "border-green-500 ring-2 ring-green-200" : "border-slate-200 hover:border-slate-400"}`}>
                  {src ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={src} alt={`option ${i + 1}`} className="w-full h-28 object-contain bg-white" />
                  ) : (
                    <div className="w-full h-28 flex items-center justify-center text-xs text-slate-400 bg-slate-50">(no image)</div>
                  )}
                  <span className={`absolute top-1 left-1 px-1.5 py-0.5 rounded text-[10px] font-bold ${isCorrect ? "bg-green-600 text-white" : "bg-slate-700/80 text-white"}`}>
                    ({i + 1}){isCorrect ? " ✓" : ""}
                  </span>
                  {variant.optionImageDescriptions?.[i] && (
                    <span className="block text-[10px] text-slate-500 px-1.5 py-1 text-left bg-white border-t border-slate-100 line-clamp-2">
                      {variant.optionImageDescriptions[i]}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <p className="text-[10px] text-slate-400 mt-2">Tap the image to mark which option is correct.</p>
        </>
      ) : Array.isArray(variant.options) && variant.options.length === 4 ? (
        // MCQ: 4 options grid with correct-answer toggle.
        <>
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
        </>
      ) : (
        // Synthesis: single transformed-sentence answer. Either unpacked into
        // variant.answer (fresh from generator) or living in options[0] when
        // reloaded from the DB. Editing targets whichever field is populated.
        <div className="mt-2">
          <p className="text-[10px] font-bold uppercase text-slate-400 mb-1">Transformed answer</p>
          <textarea
            value={(variant as { answer?: string }).answer ?? variant.options?.[0] ?? ""}
            onChange={e => onOption(0, e.target.value)}
            rows={2}
            disabled={disabled}
            className="w-full border border-green-200 bg-green-50 text-green-900 rounded-lg px-3 py-2 text-sm resize-none outline-none focus:border-green-500 disabled:opacity-50"
          />
        </div>
      )}
    </div>
  );
}
