"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import AdminNav from "@/components/AdminNav";

type Result = { id: string; paperTitle: string; difficulty: number | null; reason: string | null; error?: string };

export default function ClassifyDifficultyPage() {
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
  const [totals, setTotals] = useState<{ total: number; rated: number; unrated: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [continuous, setContinuous] = useState(false);
  const continuousRef = useRef(false);
  const [results, setResults] = useState<Result[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`).then(r => setAllowed(r.ok)).catch(() => setAllowed(false));
  }, [userId]);

  const loadTotals = useCallback(async () => {
    const res = await fetch("/api/admin/classify-difficulty");
    if (res.ok) setTotals(await res.json());
  }, []);
  useEffect(() => { if (allowed) loadTotals(); }, [allowed, loadTotals]);

  const runBatch = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/classify-difficulty", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 5 }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Batch failed");
        return;
      }
      setResults(prev => [...data.results, ...prev].slice(0, 300));
      setTotals(t => t ? { ...t, rated: t.rated + (data.updated ?? 0), unrated: Math.max(0, t.unrated - (data.updated ?? 0)) } : t);
      if (continuousRef.current && data.totalRemaining - data.processed > 0 && data.processed > 0) {
        setTimeout(runBatch, 800);
      } else {
        // Refresh true counts from DB once the loop stops or ends.
        loadTotals();
      }
    } finally {
      setRunning(false);
    }
  }, [loadTotals]);

  function startContinuous() {
    continuousRef.current = true;
    setContinuous(true);
    runBatch();
  }
  function stopContinuous() {
    continuousRef.current = false;
    setContinuous(false);
  }

  if (allowed === null) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" /></div>;
  }
  if (!allowed) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><p className="text-slate-500 text-sm">Access denied.</p></div>;
  }

  const pct = totals && totals.total > 0 ? Math.round((totals.rated / totals.total) * 100) : 0;
  const ok = results.filter(r => !r.error).length;
  const errs = results.filter(r => r.error).length;

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24 lg:pb-0">
        <div className="bg-white border-b border-slate-200 px-4 py-3">
          <h1 className="text-lg font-bold text-slate-800">Classify Question Difficulty</h1>
          <p className="text-xs text-slate-400">AI-rates clean-extracted master questions 1–5. Batches of 5 per Gemini call. Background mode keeps running until the queue is empty.</p>
        </div>

        <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
          {totals && (
            <div className="bg-white rounded-2xl border border-slate-100 p-5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-bold text-slate-700">Progress</span>
                <span className="text-xs font-bold text-slate-500">{totals.rated.toLocaleString()} / {totals.total.toLocaleString()} rated · {totals.unrated.toLocaleString()} remaining</span>
              </div>
              <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden">
                <div className="h-full bg-indigo-500 transition-all" style={{ width: `${pct}%` }} />
              </div>
              <p className="text-[10px] text-slate-400 mt-1.5 text-right">{pct}%</p>
            </div>
          )}

          <div className="bg-white rounded-2xl border border-slate-100 p-5 space-y-3">
            {!continuous ? (
              <div className="flex gap-2">
                <button onClick={runBatch} disabled={running}
                  className="flex-1 py-3 rounded-xl border border-slate-300 text-slate-700 font-bold text-sm disabled:opacity-50">
                  {running ? "Processing…" : "Run one batch (5)"}
                </button>
                <button onClick={startContinuous} disabled={running || (totals?.unrated ?? 1) === 0}
                  className="flex-1 py-3 rounded-xl bg-indigo-600 text-white font-bold text-sm disabled:opacity-50">
                  Start background classification
                </button>
              </div>
            ) : (
              <button onClick={stopContinuous}
                className="w-full py-3 rounded-xl bg-red-500 text-white font-bold text-sm">
                Stop {running ? "(finishing current batch…)" : ""}
              </button>
            )}
            <p className="text-[11px] text-slate-400">This session: {ok} rated, {errs} errors.</p>
            {error && <p className="text-xs text-red-600">{error}</p>}
          </div>

          {results.length > 0 && (
            <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 text-sm font-bold text-slate-700">Recent ratings ({results.length})</div>
              <div className="max-h-[60vh] overflow-y-auto text-xs">
                {results.map((r, i) => (
                  <div key={`${r.id}-${i}`} className={`px-5 py-2 border-b border-slate-50 ${r.error ? "bg-red-50" : ""}`}>
                    <div className="flex items-center gap-2">
                      {r.difficulty !== null && (
                        <span className={`px-1.5 py-0.5 rounded font-bold ${
                          r.difficulty <= 2 ? "bg-emerald-100 text-emerald-700" :
                          r.difficulty === 3 ? "bg-amber-100 text-amber-700" :
                          "bg-rose-100 text-rose-700"
                        }`}>Lv {r.difficulty}</span>
                      )}
                      <span className="text-slate-500 truncate flex-1">{r.paperTitle}</span>
                      {r.error
                        ? <span className="text-red-600 font-bold">✗ {r.error}</span>
                        : <span className="text-slate-600 italic">{r.reason}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
