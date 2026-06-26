// Admin page: one-click orphan-submission-JPG cleanup. Hits the
// /api/admin/cleanup-orphan-jpgs endpoint that runs server-side on
// Railway (where /data and the prod DB are both real). Easier than
// curl or fetch-from-console — visit the page, see the count, click
// the button.
//
// Route: /admin/cleanup-orphans?userId=<admin>

"use client";

import { useState, useEffect } from "react";

type DryRun = {
  volumePath: string;
  submissionsDir: string;
  totalDirs: number;
  orphanCount: number;
  orphans: string[];
  truncated: boolean;
};

type Applied = {
  volumePath: string;
  totalDirs: number;
  orphanCount: number;
  applied: true;
  deleted: number;
  failed: number;
  failures: Array<{ id: string; error: string }>;
};

export default function CleanupOrphansPage() {
  const [state, setState] = useState<DryRun | null>(null);
  const [result, setResult] = useState<Applied | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch("/api/admin/cleanup-orphan-jpgs");
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
      setState(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  };

  useEffect(() => { void refresh(); }, []);

  const onDelete = async () => {
    if (!state || state.orphanCount === 0) return;
    if (!confirm(`Delete ${state.orphanCount} orphan submission directories from the Railway volume?\n\nThis cannot be undone.`)) return;
    setLoading(true); setError(null);
    try {
      const r = await fetch("/api/admin/cleanup-orphan-jpgs?apply=1", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
      setResult(d);
      // refresh the dry-run count so the page reflects post-delete state
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  };

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-xl font-bold mb-1">Orphan submission JPGs</h1>
      <p className="text-sm text-slate-600 mb-6">
        Submission-JPG directories under the Railway volume whose ExamPaper row has been deleted.
        Safe to remove — nothing reads them once the paper is gone.
      </p>

      {error && (
        <div className="mb-4 p-3 rounded bg-rose-50 border border-rose-200 text-rose-800 text-sm">
          {error}
        </div>
      )}

      {state && (
        <div className="mb-4 p-4 rounded-lg border border-slate-200 bg-slate-50">
          <div className="text-sm text-slate-600">Volume root</div>
          <div className="font-mono text-sm mb-2">{state.volumePath}</div>
          <div className="grid grid-cols-2 gap-4 mt-3">
            <div>
              <div className="text-2xl font-bold text-slate-800">{state.totalDirs}</div>
              <div className="text-xs text-slate-500">total submission dirs</div>
            </div>
            <div>
              <div className={`text-2xl font-bold ${state.orphanCount > 0 ? "text-rose-700" : "text-emerald-700"}`}>
                {state.orphanCount}
              </div>
              <div className="text-xs text-slate-500">orphans (paperId not in DB)</div>
            </div>
          </div>
        </div>
      )}

      {state && state.orphans.length > 0 && (
        <details className="mb-4 text-sm">
          <summary className="cursor-pointer text-slate-700 font-medium">
            First {state.orphans.length} orphan paper IDs {state.truncated ? "(truncated)" : ""}
          </summary>
          <ul className="mt-2 font-mono text-xs space-y-1 text-slate-600 bg-white p-3 rounded border border-slate-200">
            {state.orphans.map(id => <li key={id}>{id}</li>)}
          </ul>
        </details>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="px-4 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 font-medium text-sm disabled:opacity-50"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={loading || !state || state.orphanCount === 0}
          className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-bold text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? "Deleting…" : `Delete ${state?.orphanCount ?? 0} orphan${state?.orphanCount === 1 ? "" : "s"}`}
        </button>
      </div>

      {result && (
        <div className="mt-6 p-4 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm">
          <div className="font-bold mb-1">Deleted {result.deleted} {result.deleted === 1 ? "directory" : "directories"}.</div>
          {result.failed > 0 && (
            <div className="mt-2">
              <div className="text-rose-700">{result.failed} failed:</div>
              <ul className="font-mono text-xs mt-1">
                {result.failures.map(f => <li key={f.id}>{f.id} — {f.error}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
