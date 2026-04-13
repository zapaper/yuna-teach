"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import AdminNav from "@/components/AdminNav";

export default function SubpartMarksPage() {
  return (
    <Suspense>
      <SubpartMarksContent />
    </Suspense>
  );
}

function SubpartMarksContent() {
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [subject, setSubject] = useState<"" | "math" | "science" | "english">("");
  const [scan, setScan] = useState<{ total: number; bySubject: Record<string, number>; ids: string[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`).then(r => setAllowed(r.ok)).catch(() => setAllowed(false));
  }, [userId]);

  async function doScan() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/subpart-marks?userId=${userId}${subject ? `&subject=${subject}` : ""}`);
      const data = await res.json();
      setScan(data);
      setLog([]);
    } finally {
      setLoading(false);
    }
  }

  async function runBatch() {
    if (!scan || scan.ids.length === 0) return;
    setRunning(true);
    setProgress({ done: 0, total: scan.ids.length });
    setLog([]);
    const BATCH = 5;
    const all = [...scan.ids];
    let done = 0;
    while (all.length > 0) {
      const batch = all.splice(0, BATCH);
      try {
        const res = await fetch("/api/admin/subpart-marks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, ids: batch }),
        });
        const data = await res.json();
        const results = data.results ?? [];
        for (const r of results) {
          const msg = r.updated > 0 ? `✓ ${r.id}: ${r.updated} parts — ${JSON.stringify(r.marks)}` : `– ${r.id}: ${r.error ?? "no update"}`;
          setLog(prev => [msg, ...prev].slice(0, 200));
        }
      } catch (e) {
        setLog(prev => [`ERR batch: ${(e as Error).message}`, ...prev]);
      }
      done += batch.length;
      setProgress({ done, total: scan.ids.length });
    }
    setRunning(false);
    // Re-scan after done
    await doScan();
  }

  if (allowed === null) return <div className="min-h-screen flex items-center justify-center bg-slate-50"><div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" /></div>;
  if (!allowed) return <div className="min-h-screen flex items-center justify-center bg-slate-50"><p className="text-slate-500 text-sm">Access denied.</p></div>;

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24">
        <div className="bg-white border-b border-slate-200 px-4 py-3">
          <Link href={`/admin?userId=${userId}`} className="text-xs text-slate-400 hover:text-slate-600">← Admin</Link>
          <h1 className="text-lg font-bold text-slate-800">Backfill Sub-part Marks</h1>
          <p className="text-xs text-slate-400">AI reads [1] / [2m] indicators from question images and updates sub-part texts.</p>
        </div>

        <div className="max-w-2xl mx-auto px-4 py-6 space-y-4">
          <div className="flex gap-2">
            {([["", "All"], ["math", "Math"], ["science", "Science"], ["english", "English"]] as const).map(([v, l]) => (
              <button key={v} onClick={() => { setSubject(v); setScan(null); }}
                className={`flex-1 py-2 rounded-xl border-2 text-sm font-bold ${subject === v ? "border-slate-800 bg-slate-800 text-white" : "border-slate-200 bg-white text-slate-600"}`}>
                {l}
              </button>
            ))}
          </div>

          <button onClick={doScan} disabled={loading || running}
            className="w-full py-3 rounded-xl bg-blue-600 text-white font-bold disabled:opacity-50">
            {loading ? "Scanning…" : "Scan"}
          </button>

          {scan && (
            <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-2">
              <p className="text-sm font-bold text-slate-800">{scan.total} questions need sub-part marks</p>
              <div className="text-xs text-slate-500">
                {Object.entries(scan.bySubject).map(([s, n]) => <span key={s} className="mr-3">{s}: {n}</span>)}
              </div>
              {scan.total > 200 && <p className="text-[11px] text-amber-600">Showing first 200 ids — re-scan after processing to continue.</p>}
              {scan.total > 0 && (
                <button onClick={runBatch} disabled={running}
                  className="w-full py-2.5 rounded-xl bg-green-600 text-white text-sm font-bold disabled:opacity-50">
                  {running ? `Processing ${progress?.done ?? 0} / ${progress?.total ?? 0}…` : `Process ${Math.min(scan.total, 200)} questions`}
                </button>
              )}
            </div>
          )}

          {log.length > 0 && (
            <div className="bg-slate-900 text-slate-100 rounded-xl p-3 max-h-96 overflow-y-auto">
              <p className="text-[10px] uppercase tracking-wider text-slate-400 mb-2">Log</p>
              {log.map((l, i) => <p key={i} className="text-[11px] font-mono whitespace-pre-wrap">{l}</p>)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
