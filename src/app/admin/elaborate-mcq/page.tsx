"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import AdminNav from "@/components/AdminNav";

type ResultRow = { id: string; questionNum: string; paperId: string; paperTitle: string; subject: string; level: string; ok: boolean; error?: string };
type Bucket = { total: number; elaborated: number; failed: number };
type Counts = { total: number; elaborated: number; failed: number; pending: number; byLevel: Record<string, Bucket>; bySubject: Record<string, Bucket> };

export default function ElaborateMcqPage() {
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
  const [counts, setCounts] = useState<Counts | null>(null);
  const [running, setRunning] = useState(false);
  const [continuous, setContinuous] = useState(false);
  const continuousRef = useRef(false);
  const [results, setResults] = useState<ResultRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const failedIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`).then((r) => setAllowed(r.ok)).catch(() => setAllowed(false));
  }, [userId]);

  const loadCounts = useCallback(async () => {
    const res = await fetch("/api/admin/elaborate-mcq");
    if (res.ok) setCounts(await res.json());
  }, []);
  useEffect(() => { if (allowed) loadCounts(); }, [allowed, loadCounts]);

  const runBatch = useCallback(async (limit: number) => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/elaborate-mcq", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit, excludeIds: [...failedIdsRef.current] }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Batch failed");
        return;
      }
      for (const r of (data.results ?? []) as ResultRow[]) {
        if (!r.ok) failedIdsRef.current.add(r.id);
      }
      setResults((prev) => [...data.results, ...prev].slice(0, 300));
      setCounts((c) => c ? { ...c, elaborated: c.elaborated + (data.updated ?? 0), pending: Math.max(0, c.pending - (data.updated ?? 0)) } : c);
      const queueDrained = data.totalRemaining <= failedIdsRef.current.size;
      if (continuousRef.current && !queueDrained) {
        setTimeout(() => runBatch(limit), 800);
      } else {
        loadCounts();
      }
    } finally {
      setRunning(false);
    }
  }, [loadCounts]);

  function startContinuous() {
    continuousRef.current = true;
    setContinuous(true);
    runBatch(3);
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

  const pct = counts && counts.total > 0 ? Math.round((counts.elaborated / counts.total) * 100) : 0;
  const ok = results.filter((r) => r.ok).length;
  const errs = results.filter((r) => !r.ok).length;

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24 lg:pb-0">
        <div className="bg-white border-b border-slate-200 px-4 py-3">
          <h1 className="text-lg font-bold text-slate-800">Generate Explanation for MCQ</h1>
          <p className="text-xs text-slate-400">P3-P6 Math + Science MCQ on real master papers. Once a master is elaborated, every clone of it inherits the cached value (see /api/exam/[id]/elaborate). Run a small test first, then leave it running in background.</p>
        </div>

        <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
          {counts && (
            <div className="bg-white rounded-2xl border border-slate-100 p-5">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-bold text-slate-700">Progress</span>
                <span className="text-xs font-bold text-slate-500">
                  {counts.elaborated.toLocaleString()} / {counts.total.toLocaleString()} elaborated · {counts.pending.toLocaleString()} pending{counts.failed > 0 && <> · <span className="text-red-600">{counts.failed.toLocaleString()} failed</span></>}
                </span>
              </div>
              <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden">
                <div className="h-full bg-indigo-500 transition-all" style={{ width: `${pct}%` }} />
              </div>
              <p className="text-[10px] text-slate-400 mt-1.5 text-right">{pct}%</p>
            </div>
          )}

          {counts && (
            <div className="bg-white rounded-2xl border border-slate-100 p-5 space-y-4">
              <div>
                <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">By level</p>
                <div className="space-y-1.5 text-xs">
                  {Object.entries(counts.byLevel)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([lvl, v]) => (
                    <div key={lvl} className="flex justify-between">
                      <span className="font-bold text-slate-700">{lvl}</span>
                      <span className="text-slate-500 tabular-nums">{v.elaborated} / {v.total}  ({v.total - v.elaborated - v.failed} pending{v.failed > 0 && <>, <span className="text-red-600">{v.failed} failed</span></>})</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="pt-3 border-t border-slate-100">
                <p className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">By subject</p>
                <div className="space-y-1.5 text-xs">
                  {Object.entries(counts.bySubject)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([subj, v]) => (
                    <div key={subj} className="flex justify-between">
                      <span className="font-bold text-slate-700 truncate pr-2">{subj}</span>
                      <span className="text-slate-500 tabular-nums">{v.elaborated} / {v.total}  ({v.total - v.elaborated - v.failed} pending{v.failed > 0 && <>, <span className="text-red-600">{v.failed} failed</span></>})</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="bg-white rounded-2xl border border-slate-100 p-5 space-y-3">
            {!continuous ? (
              <div className="flex flex-col gap-2">
                <button onClick={() => runBatch(3)} disabled={running}
                  className="w-full py-3 rounded-xl border border-slate-300 text-slate-700 font-bold text-sm disabled:opacity-50">
                  {running ? "Processing…" : "Test run (3 questions)"}
                </button>
                <button onClick={startContinuous} disabled={running || (counts?.pending ?? 1) === 0}
                  className="w-full py-3 rounded-xl bg-indigo-600 text-white font-bold text-sm disabled:opacity-50">
                  Start continuous (3 per batch, until done)
                </button>
              </div>
            ) : (
              <button onClick={stopContinuous}
                className="w-full py-3 rounded-xl bg-red-500 text-white font-bold text-sm">
                Stop {running ? "(finishing current batch…)" : ""}
              </button>
            )}
            <p className="text-[11px] text-slate-400">This session: {ok} elaborated, {errs} errors.</p>
            {error && <p className="text-xs text-red-600">{error}</p>}
          </div>

          {results.length > 0 && (
            <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 text-sm font-bold text-slate-700">Recent ({results.length})</div>
              <div className="max-h-[60vh] overflow-y-auto text-xs">
                {results.map((r, i) => (
                  <div key={`${r.id}-${i}`} className={`px-5 py-2 border-b border-slate-50 ${!r.ok ? "bg-red-50" : ""}`}>
                    <div className="flex items-center gap-2">
                      <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] font-bold">{r.level}</span>
                      <a
                        href={`/exam/${r.paperId}/transcribe-edit?userId=${userId}#q-${r.id}`}
                        target="_blank"
                        rel="noopener"
                        className="text-slate-500 truncate flex-1 hover:text-slate-800 underline decoration-dotted underline-offset-2"
                        title="Open the clean editor for this question"
                      >
                        Q{r.questionNum} · {r.paperTitle}
                      </a>
                      <a
                        href={`/exam/${r.paperId}/edit?userId=${userId}#q-${r.id}`}
                        target="_blank"
                        rel="noopener"
                        className="px-2 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] font-bold hover:bg-slate-200 hover:text-slate-800 shrink-0"
                        title="Open the raw Edit Q&A view for this question"
                      >
                        Edit Q&amp;A
                      </a>
                      {r.ok
                        ? <span className="text-emerald-600 font-bold">✓</span>
                        : <span className="text-red-600 font-bold">✗ {r.error}</span>}
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
