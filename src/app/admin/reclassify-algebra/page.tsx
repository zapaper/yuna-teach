"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import AdminNav from "@/components/AdminNav";

type Result = {
  id: string;
  paperTitle: string;
  level: string | null;
  from: string;
  to: string | null;
  error?: string;
};

export default function ReclassifyAlgebraPage() {
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
  const [running, setRunning] = useState(false);
  const [totalRemaining, setTotalRemaining] = useState<number | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [batchSize, setBatchSize] = useState(20);
  const [dryRun, setDryRun] = useState(true);
  const [continuous, setContinuous] = useState(false);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`).then(r => setAllowed(r.ok)).catch(() => setAllowed(false));
  }, [userId]);

  const runBatch = useCallback(async () => {
    setRunning(true);
    try {
      const res = await fetch("/api/admin/reclassify-algebra", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: batchSize, dryRun }),
      });
      if (!res.ok) {
        const msg = await res.text();
        alert(`Error: ${msg}`);
        setRunning(false);
        return;
      }
      const data = await res.json() as { totalRemaining: number; processed: number; results: Result[] };
      setTotalRemaining(data.totalRemaining);
      setResults(prev => [...data.results, ...prev].slice(0, 500));
      if (continuous && !dryRun && data.processed > 0 && data.totalRemaining - data.processed > 0) {
        // Keep running until the queue is drained.
        setTimeout(runBatch, 500);
        return;
      }
    } finally {
      setRunning(false);
    }
  }, [batchSize, dryRun, continuous]);

  if (allowed === null) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" /></div>;
  }
  if (!allowed) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><p className="text-slate-500 text-sm">Access denied.</p></div>;
  }

  const ok = results.filter(r => !r.error).length;
  const errs = results.filter(r => r.error).length;

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24 lg:pb-0">
        <div className="bg-white border-b border-slate-200 px-4 py-3">
          <h1 className="text-lg font-bold text-slate-800">Reclassify P4/P5 Algebra</h1>
          <p className="text-xs text-slate-400">AI-reclassifies P4/P5 math questions currently tagged &ldquo;Algebra&rdquo; to a valid topic (Fractions, Ratio, etc.).</p>
        </div>

        <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
          <div className="bg-white rounded-2xl border border-slate-100 p-5 space-y-3">
            <div className="flex items-center gap-3 text-sm">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} />
                <span>Dry run (don&apos;t write to DB)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={continuous} onChange={e => setContinuous(e.target.checked)} disabled={dryRun} />
                <span>Keep running until done</span>
              </label>
              <label className="flex items-center gap-2 ml-auto">
                <span>Batch:</span>
                <input type="number" min={1} max={100} value={batchSize} onChange={e => setBatchSize(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} className="w-16 px-2 py-1 border border-slate-200 rounded" />
              </label>
            </div>
            <button onClick={runBatch} disabled={running} className="w-full py-3 rounded-xl bg-purple-600 text-white font-bold text-sm disabled:opacity-50">
              {running ? "Processing..." : dryRun ? "Run dry batch" : "Run batch"}
            </button>
            {totalRemaining !== null && (
              <p className="text-xs text-slate-500">
                Remaining P4/P5 Algebra questions in DB: <span className="font-bold text-slate-800">{totalRemaining}</span>
                {" · "}
                This session: {ok} reclassified, {errs} errors
              </p>
            )}
          </div>

          {results.length > 0 && (
            <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 text-sm font-bold text-slate-700">Recent results ({results.length})</div>
              <div className="max-h-[60vh] overflow-y-auto text-xs">
                {results.map((r, i) => (
                  <div key={`${r.id}-${i}`} className={`px-5 py-2 border-b border-slate-50 ${r.error ? "bg-red-50" : ""}`}>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-800">{r.level ?? "?"}</span>
                      <span className="text-slate-500 truncate flex-1">{r.paperTitle}</span>
                      {r.error
                        ? <span className="text-red-600 font-bold">✗ {r.error}</span>
                        : <span className="text-green-700 font-bold">Algebra → {r.to}</span>}
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
