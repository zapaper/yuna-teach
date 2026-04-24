"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import AdminNav from "@/components/AdminNav";

type GhostPaper = {
  id: string;
  title: string;
  createdAt: string;
  creatorName: string | null;
  creatorEmail: string | null;
  questionCount: number;
  cloneCount: number;
};

export default function CleanupGhostPapersPage() {
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
  const [parentId, setParentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [list, setList] = useState<GhostPaper[] | null>(null);
  const [deletedCount, setDeletedCount] = useState<number | null>(null);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`).then(r => setAllowed(r.ok)).catch(() => setAllowed(false));
  }, [userId]);

  const preview = useCallback(async () => {
    setBusy(true);
    setDeletedCount(null);
    try {
      const res = await fetch("/api/admin/cleanup-ghost-papers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: true, ...(parentId.trim() ? { parentId: parentId.trim() } : {}) }),
      });
      const data = await res.json();
      setList(data.papers ?? []);
    } finally { setBusy(false); }
  }, [parentId]);

  async function runDelete() {
    if (!list || list.length === 0) return;
    if (!confirm(`Delete ${list.length} paper${list.length === 1 ? "" : "s"}? This also deletes their questions and any student clones. Not reversible.`)) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/cleanup-ghost-papers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: false, ...(parentId.trim() ? { parentId: parentId.trim() } : {}) }),
      });
      const data = await res.json();
      setDeletedCount(data.deleted ?? 0);
      setList([]);
    } finally { setBusy(false); }
  }

  if (allowed === null) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" /></div>;
  }
  if (!allowed) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><p className="text-slate-500 text-sm">Access denied.</p></div>;
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24 lg:pb-0">
        <div className="bg-white border-b border-slate-200 px-4 py-3">
          <h1 className="text-lg font-bold text-slate-800">Cleanup Ghost Papers</h1>
          <p className="text-xs text-slate-400">Finds master-paper rows auto-created on non-admin parents by the old signup hook. Matches &lsquo;Math practice …&rsquo; uploads AND any paper title that duplicates an admin-owned master.</p>
        </div>

        <div className="max-w-3xl mx-auto px-4 py-5 space-y-4">
          <div className="bg-white rounded-2xl border border-slate-100 p-5 space-y-3">
            <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider">Limit to one parent (optional)</label>
            <input
              type="text"
              value={parentId}
              onChange={e => setParentId(e.target.value)}
              placeholder="Parent user ID (blank = every non-admin parent)"
              className="w-full px-3 py-2 text-sm rounded-xl border border-slate-200 font-mono focus:outline-none focus:border-slate-500"
            />
            <div className="flex gap-2">
              <button onClick={preview} disabled={busy}
                className="flex-1 py-2.5 rounded-xl bg-slate-800 text-white font-bold text-sm disabled:opacity-50">
                {busy ? "Scanning…" : "Preview (dry run)"}
              </button>
              <button onClick={runDelete} disabled={busy || !list || list.length === 0}
                className="flex-1 py-2.5 rounded-xl bg-red-600 text-white font-bold text-sm disabled:opacity-50">
                Delete {list?.length ?? 0} paper{(list?.length ?? 0) === 1 ? "" : "s"}
              </button>
            </div>
            {deletedCount !== null && (
              <p className="text-xs text-emerald-600 font-bold">✓ Deleted {deletedCount} paper{deletedCount === 1 ? "" : "s"}.</p>
            )}
          </div>

          {list && (
            <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-100 text-sm font-bold text-slate-700">
                {list.length} match{list.length === 1 ? "" : "es"}
              </div>
              {list.length === 0 ? (
                <p className="px-5 py-6 text-sm text-slate-400 text-center">No ghost papers found.</p>
              ) : (
                <div className="max-h-[60vh] overflow-y-auto text-xs">
                  {list.map(p => (
                    <div key={p.id} className="px-5 py-2 border-b border-slate-50">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-800 truncate flex-1">{p.title}</span>
                        <span className="text-slate-500">{p.questionCount}q</span>
                        {p.cloneCount > 0 && <span className="text-blue-500">· {p.cloneCount} clones</span>}
                      </div>
                      <div className="text-[10px] text-slate-500 mt-0.5">
                        by {p.creatorName ?? "?"}{p.creatorEmail ? ` (${p.creatorEmail})` : ""} · {new Date(p.createdAt).toLocaleDateString()}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
