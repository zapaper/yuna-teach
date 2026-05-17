"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import AdminNav from "@/components/AdminNav";

export default function Page() {
  return (
    <Suspense>
      <RemaskWatermarks />
    </Suspense>
  );
}

type Paper = { id: string; title: string; subject: string | null; pageCount: number };
type Status = "pending" | "running" | "done" | "failed";
type Row = Paper & { status: Status; masked?: number; skipped?: number; error?: string };

function RemaskWatermarks() {
  const userId = useSearchParams().get("userId") ?? "";
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [doneCount, setDoneCount] = useState(0);
  const [failCount, setFailCount] = useState(0);
  // useRef so the in-flight loop can see "stop" requests without
  // restarting via a re-render.
  const stoppedRef = useRef(false);
  // Mirror rows in a ref so runAll can read the canonical id list
  // without re-creating the closure on every render.
  const rowsRef = useRef<Row[]>([]);
  rowsRef.current = rows;

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`).then(r => setAllowed(r.ok)).catch(() => setAllowed(false));
  }, [userId]);

  useEffect(() => {
    if (allowed !== true) return;
    fetch("/api/admin/master-papers-pages")
      .then(r => r.json())
      .then((d: { papers: Paper[] }) => {
        setRows(d.papers.map(p => ({ ...p, status: "pending" })));
      })
      .catch(() => setRows([]));
  }, [allowed]);

  async function runAll() {
    setRunning(true);
    stoppedRef.current = false;
    setDoneCount(0);
    setFailCount(0);
    // Reset previously-completed rows so a re-run shows fresh state.
    setRows(prev => prev.map(r => ({ ...r, status: "pending", masked: undefined, skipped: undefined, error: undefined })));
    // Snapshot ids from the ref so the loop drives off the canonical
    // list and survives per-row state updates.
    const ids = rowsRef.current.map(r => r.id);
    for (const id of ids) {
      if (stoppedRef.current) break;
      setRows(prev => prev.map(r => r.id === id ? { ...r, status: "running" } : r));
      try {
        const res = await fetch(`/api/exam/${id}/remask-watermark`, { method: "POST" });
        if (!res.ok) {
          const t = await res.text();
          setRows(prev => prev.map(r => r.id === id ? { ...r, status: "failed", error: t.slice(0, 120) } : r));
          setFailCount(c => c + 1);
        } else {
          const d = await res.json() as { masked?: number; skipped?: number };
          setRows(prev => prev.map(r => r.id === id ? { ...r, status: "done", masked: d.masked, skipped: d.skipped } : r));
          setDoneCount(c => c + 1);
        }
      } catch (err) {
        setRows(prev => prev.map(r => r.id === id ? { ...r, status: "failed", error: (err as Error).message.slice(0, 120) } : r));
        setFailCount(c => c + 1);
      }
    }
    setRunning(false);
  }

  if (allowed === null) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" /></div>;
  }
  if (!allowed) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><p className="text-slate-500 text-sm">Access denied.</p></div>;
  }

  const total = rows.length;
  const pct = total > 0 ? Math.round(((doneCount + failCount) / total) * 100) : 0;

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24 lg:pb-0">
        <div className="bg-white border-b border-slate-200 px-4 py-3">
          <h1 className="text-lg font-bold text-slate-800">Remask Watermarks (All Master Papers)</h1>
          <p className="text-xs text-slate-400">
            Repaints a white box over the bottom-right corner of every page, plus the top-left corner of page 1.
            Idempotent — safe to re-run. Clones inherit via their master so only masters are processed.
          </p>
        </div>

        <div className="max-w-3xl mx-auto px-4 py-6 space-y-4">
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <p className="text-sm font-bold text-slate-800">{total} master papers loaded</p>
                <p className="text-xs text-slate-400">
                  {doneCount} done · {failCount} failed · {total - doneCount - failCount} pending
                </p>
              </div>
              <div className="flex gap-2">
                {!running && (
                  <button
                    onClick={runAll}
                    disabled={total === 0}
                    className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400"
                  >
                    {doneCount + failCount > 0 ? "Re-run All" : "Run All"}
                  </button>
                )}
                {running && (
                  <button
                    onClick={() => { stoppedRef.current = true; }}
                    className="px-4 py-2 rounded-xl bg-amber-500 text-white text-sm font-bold hover:bg-amber-600"
                  >
                    Stop after current
                  </button>
                )}
              </div>
            </div>
            <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
              <div
                className={`h-full transition-all ${failCount > 0 ? "bg-amber-400" : "bg-emerald-500"}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 border-b border-slate-100">
                <tr className="text-left text-slate-500 uppercase tracking-wider">
                  <th className="px-4 py-2 font-bold">Status</th>
                  <th className="px-4 py-2 font-bold">Paper</th>
                  <th className="px-4 py-2 font-bold">Subject</th>
                  <th className="px-4 py-2 font-bold text-right">Pages</th>
                  <th className="px-4 py-2 font-bold text-right">Masked</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} className="border-b border-slate-50 last:border-b-0">
                    <td className="px-4 py-2">
                      {r.status === "pending" && <span className="text-slate-300">·</span>}
                      {r.status === "running" && <span className="text-emerald-600 animate-pulse">running…</span>}
                      {r.status === "done" && <span className="text-emerald-600">✓</span>}
                      {r.status === "failed" && <span className="text-rose-600" title={r.error}>✗</span>}
                    </td>
                    <td className="px-4 py-2 text-slate-800">{r.title || r.id}</td>
                    <td className="px-4 py-2 text-slate-500">{r.subject ?? "—"}</td>
                    <td className="px-4 py-2 text-slate-500 text-right">{r.pageCount}</td>
                    <td className="px-4 py-2 text-slate-500 text-right">
                      {r.status === "done" ? `${r.masked ?? 0}${r.skipped ? ` (${r.skipped} skip)` : ""}` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
