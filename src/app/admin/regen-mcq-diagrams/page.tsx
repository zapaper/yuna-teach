"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import AdminNav from "@/components/AdminNav";

type Counts = { total: number; regenerated: number; pending: number; sci: number; math: number };
type Outcome = {
  id: string;
  questionNum: string;
  paperId: string;
  paperTitle: string;
  paperSubject: string | null;
  ok: boolean;
  letterSet: boolean;
  error?: string;
  solution?: string;
  answer?: string | null;
};

export default function Page() {
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
  const [letterSetOnly, setLetterSetOnly] = useState(false);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [running, setRunning] = useState(false);
  const [autoLoop, setAutoLoop] = useState(false);
  const [log, setLog] = useState<Outcome[]>([]);
  const [batchSize, setBatchSize] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const stopRef = useRef(false);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`).then((r) => setAllowed(r.ok)).catch(() => setAllowed(false));
  }, [userId]);

  const loadCounts = useCallback(async () => {
    const url = `/api/admin/regen-sci-math-mcq${letterSetOnly ? "?letterSetOnly=1" : ""}`;
    const r = await fetch(url);
    if (r.ok) setCounts(await r.json());
  }, [letterSetOnly]);
  useEffect(() => { if (allowed) loadCounts(); }, [allowed, loadCounts]);

  const runBatch = useCallback(async (): Promise<{ processed: number; done: boolean }> => {
    const r = await fetch("/api/admin/regen-sci-math-mcq", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: batchSize, letterSetOnly }),
    });
    const data = await r.json();
    if (!r.ok) {
      setError(data.error ?? "Batch failed");
      return { processed: 0, done: true };
    }
    setLog((prev) => [...(data.results ?? []), ...prev].slice(0, 200));
    await loadCounts();
    return { processed: data.processed ?? 0, done: !!data.done };
  }, [batchSize, letterSetOnly, loadCounts]);

  const handleRunOne = async () => {
    setRunning(true);
    setError(null);
    try { await runBatch(); }
    finally { setRunning(false); }
  };

  const handleAutoRun = async () => {
    setAutoLoop(true);
    setRunning(true);
    setError(null);
    stopRef.current = false;
    try {
      // Loop until done or user clicks stop. Each iteration runs one
      // batchSize through the API, so press Stop to land cleanly at
      // the end of the current batch.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (stopRef.current) break;
        const { processed, done } = await runBatch();
        if (done || processed === 0) break;
      }
    } finally {
      setRunning(false);
      setAutoLoop(false);
    }
  };
  const handleStop = () => { stopRef.current = true; };

  if (allowed === false) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <p className="text-sm text-slate-500">Admin only.</p>
    </div>
  );

  const pct = counts && counts.total > 0 ? Math.round((counts.regenerated / counts.total) * 100) : 0;

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <main className="max-w-4xl mx-auto p-6 space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-bold text-slate-800">Regen Sci / Math MCQ with Diagrams</h1>
          <p className="text-sm text-slate-500">
            Re-runs <code className="text-xs">gemini-3.1-pro-preview</code> against every master Sci/Math MCQ
            that has a diagram, using the new prompt that sends both the diagram crop AND the full question
            crop, and forces verbatim transcription of labelled statements (A/B/C/D) before reasoning. Skips
            rows that already carry the <code className="text-xs">regenV2</code> marker.
          </p>
        </header>

        <section className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4">
          <div className="flex items-center gap-3">
            <label className="text-sm text-slate-700 flex items-center gap-2">
              <input
                type="checkbox"
                checked={letterSetOnly}
                onChange={(e) => setLetterSetOnly(e.target.checked)}
                className="w-4 h-4"
              />
              Letter-set MCQ only (the 173 highest-impact questions)
            </label>
          </div>

          {counts ? (
            <div className="grid grid-cols-4 gap-3 text-sm">
              <div className="rounded-xl bg-slate-100 p-3">
                <div className="text-[10px] uppercase tracking-wider text-slate-500">Total</div>
                <div className="text-2xl font-bold text-slate-800">{counts.total}</div>
              </div>
              <div className="rounded-xl bg-green-50 p-3">
                <div className="text-[10px] uppercase tracking-wider text-green-600">Regenerated</div>
                <div className="text-2xl font-bold text-green-700">{counts.regenerated}</div>
              </div>
              <div className="rounded-xl bg-amber-50 p-3">
                <div className="text-[10px] uppercase tracking-wider text-amber-600">Pending</div>
                <div className="text-2xl font-bold text-amber-700">{counts.pending}</div>
              </div>
              <div className="rounded-xl bg-blue-50 p-3">
                <div className="text-[10px] uppercase tracking-wider text-blue-600">Subject mix</div>
                <div className="text-sm font-semibold text-blue-700 mt-1">Sci {counts.sci} · Math {counts.math}</div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-500">Loading counts…</p>
          )}

          {counts && (
            <div className="w-full bg-slate-100 rounded-full h-2 overflow-hidden">
              <div className="bg-green-500 h-full transition-all" style={{ width: `${pct}%` }} />
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm text-slate-600">
              Batch size:&nbsp;
              <select
                value={batchSize}
                onChange={(e) => setBatchSize(Number(e.target.value))}
                disabled={running}
                className="text-sm rounded-md border border-slate-300 px-2 py-1"
              >
                {[5, 10, 15, 20].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>

            <button
              onClick={handleRunOne}
              disabled={running || (counts?.pending ?? 0) === 0}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-slate-800 text-white hover:bg-slate-900 disabled:opacity-50"
            >
              {running && !autoLoop ? "Running…" : `Run 1 batch (${batchSize})`}
            </button>

            {autoLoop ? (
              <button
                onClick={handleStop}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-red-600 text-white hover:bg-red-700"
              >
                Stop after current batch
              </button>
            ) : (
              <button
                onClick={handleAutoRun}
                disabled={running || (counts?.pending ?? 0) === 0}
                className="px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Run all (auto-loop)
              </button>
            )}

            <button
              onClick={loadCounts}
              disabled={running}
              className="text-xs text-slate-500 hover:text-slate-700 underline"
            >
              refresh counts
            </button>
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </section>

        <section className="bg-white rounded-2xl border border-slate-200 p-5 space-y-2">
          <h2 className="text-sm font-bold text-slate-700">Latest results ({log.length})</h2>
          {log.length === 0 ? (
            <p className="text-xs text-slate-400">No results yet.</p>
          ) : (
            <ul className="space-y-2 max-h-[680px] overflow-y-auto">
              {log.map((r, i) => (
                <li key={`${r.id}:${i}`} className="border-b border-slate-100 last:border-b-0 pb-2">
                  <details>
                    <summary className="flex items-start gap-2 text-xs cursor-pointer list-none select-none">
                      <span className={r.ok ? "text-green-600" : "text-red-600"}>{r.ok ? "✓" : "✗"}</span>
                      <div className="flex-1 min-w-0">
                        <span className="font-medium text-slate-700">Q{r.questionNum}</span>{" "}
                        <span className="text-slate-500">— {r.paperTitle}</span>
                        {r.paperSubject && (
                          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 uppercase tracking-wider">{r.paperSubject}</span>
                        )}
                        {r.letterSet && (
                          <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-violet-50 text-violet-700 font-bold uppercase tracking-wider">letter-set</span>
                        )}
                        {r.answer && (
                          <span className="ml-2 text-[10px] text-slate-500">key=<strong className="text-slate-700">{r.answer}</strong></span>
                        )}
                        <span className="ml-2 text-[10px] text-slate-400">[click to expand]</span>
                        {!r.ok && r.error && <p className="text-red-700 text-[11px] mt-0.5">{r.error}</p>}
                      </div>
                    </summary>
                    {r.ok && r.solution && (
                      <div className="mt-2 ml-6 space-y-2">
                        <div className="rounded-lg bg-slate-50 border border-slate-200 p-3 text-xs text-slate-700 whitespace-pre-wrap">
                          {r.solution}
                        </div>
                        <div className="flex items-center gap-3 text-[11px]">
                          <a
                            href={`/exam/${r.paperId}/edit?userId=${userId}#q-${r.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 underline hover:text-blue-800"
                          >
                            Open master in /edit (jumps to Q{r.questionNum}) ↗
                          </a>
                          <a
                            href={`/exam/${r.paperId}/overview?userId=${userId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 underline hover:text-blue-800"
                          >
                            Master overview ↗
                          </a>
                        </div>
                      </div>
                    )}
                  </details>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
