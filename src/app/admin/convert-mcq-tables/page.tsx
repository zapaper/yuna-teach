"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import AdminNav from "@/components/AdminNav";

type Candidate = {
  id: string;
  questionNum: string;
  paperId: string;
  paperTitle: string;
  stem: string | null;
  options: string[] | null;
  answer: string | null;
  topic: string | null;
  imageData: string;
};

type OptionTable = { columns: string[]; rows: string[][] };

type CardState =
  | { kind: "pending" }
  | { kind: "extracting" }
  | { kind: "table"; table: OptionTable }
  | { kind: "text"; options: string[] }
  | { kind: "error"; message: string }
  | { kind: "applied" }
  | { kind: "skipped" };

export default function ConvertMcqTablesPage() {
  return (
    <Suspense>
      <ConvertContent />
    </Suspense>
  );
}

function ConvertContent() {
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [items, setItems] = useState<Candidate[]>([]);
  const [states, setStates] = useState<Record<string, CardState>>({});
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`).then(r => setAllowed(r.ok)).catch(() => setAllowed(false));
  }, [userId]);

  const loadBatch = useCallback(async (newOffset: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/mcq-table-candidates?offset=${newOffset}&limit=10`);
      const data = await res.json();
      const next: Candidate[] = data.items ?? [];
      setItems(next);
      setTotal(data.total ?? 0);
      setOffset(newOffset);
      const fresh: Record<string, CardState> = {};
      for (const q of next) fresh[q.id] = { kind: "pending" };
      setStates(fresh);
      // Auto-extract all 10 in parallel.
      next.forEach(q => extractFor(q.id));
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (allowed) loadBatch(0); }, [allowed, loadBatch]);

  async function extractFor(id: string) {
    setStates(prev => ({ ...prev, [id]: { kind: "extracting" } }));
    try {
      const res = await fetch("/api/admin/mcq-table-candidates/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId: id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStates(prev => ({ ...prev, [id]: { kind: "error", message: data.error ?? "Extract failed" } }));
        return;
      }
      if (data.optionTable && Array.isArray(data.optionTable.columns) && Array.isArray(data.optionTable.rows)) {
        setStates(prev => ({ ...prev, [id]: { kind: "table", table: data.optionTable } }));
      } else if (Array.isArray(data.options)) {
        setStates(prev => ({ ...prev, [id]: { kind: "text", options: data.options.map((o: unknown) => String(o ?? "")) } }));
      } else {
        setStates(prev => ({ ...prev, [id]: { kind: "error", message: "Empty extraction" } }));
      }
    } catch (e) {
      setStates(prev => ({ ...prev, [id]: { kind: "error", message: String(e) } }));
    }
  }

  async function apply(id: string, table: OptionTable) {
    setStates(prev => ({ ...prev, [id]: { kind: "extracting" } }));
    const res = await fetch(`/api/exam/questions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcribedOptionTable: table, transcribedOptions: null }),
    });
    if (!res.ok) {
      setStates(prev => ({ ...prev, [id]: { kind: "error", message: "Save failed" } }));
      return;
    }
    setStates(prev => ({ ...prev, [id]: { kind: "applied" } }));
  }

  function skip(id: string) {
    setStates(prev => ({ ...prev, [id]: { kind: "skipped" } }));
  }

  if (allowed === null) return <div className="min-h-screen flex items-center justify-center bg-slate-50"><div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" /></div>;
  if (!allowed) return <div className="min-h-screen flex items-center justify-center bg-slate-50"><p className="text-slate-500 text-sm">Access denied.</p></div>;

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24">
        <div className="bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between">
          <div>
            <Link href={`/admin?userId=${userId}`} className="text-xs text-slate-400 hover:text-slate-600">← Admin</Link>
            <h1 className="text-lg font-bold text-slate-800">Convert MCQ → Table</h1>
            <p className="text-xs text-slate-400">Science MCQs with blank / row-flattened options. {total > 0 ? `${total} candidates total.` : ""}</p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => loadBatch(Math.max(0, offset - 10))}
              disabled={loading || offset === 0}
              className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-bold text-slate-600 disabled:opacity-30">
              ← Prev 10
            </button>
            <button
              onClick={() => loadBatch(offset + 10)}
              disabled={loading || offset + items.length >= total}
              className="px-3 py-1.5 rounded-lg bg-slate-800 text-white text-xs font-bold disabled:opacity-50">
              {loading ? "Loading…" : "Next 10 →"}
            </button>
          </div>
        </div>

        {loading && <div className="p-8 text-center text-sm text-slate-400">Loading batch…</div>}

        {!loading && items.length === 0 && (
          <div className="p-8 text-center text-sm text-slate-400">🎉 No remaining candidates.</div>
        )}

        <div className="max-w-5xl mx-auto px-4 py-5 space-y-4">
          {items.map((q, i) => {
            const st = states[q.id] ?? { kind: "pending" };
            return (
              <div key={q.id} className="bg-white rounded-xl border border-slate-200 p-4">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] font-bold text-slate-400">{offset + i + 1} of {total}</p>
                    <p className="text-xs font-semibold text-slate-500">{q.paperTitle}</p>
                    <p className="text-sm font-bold text-slate-800">Q{q.questionNum} · ans={q.answer}{q.topic ? ` · ${q.topic}` : ""}</p>
                  </div>
                  <a href={`/exam/${q.paperId}/transcribe-edit?userId=${userId}`} target="_blank" rel="noopener"
                    className="text-[10px] font-bold uppercase tracking-wider text-blue-600 hover:underline shrink-0">Open paper ↗</a>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">Question image</p>
                    {q.imageData && q.imageData.length > 100 && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={q.imageData.startsWith("data:") ? q.imageData : `data:image/jpeg;base64,${q.imageData}`}
                        alt="question" className="w-full rounded-lg border border-slate-200" />
                    )}
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mt-3 mb-1">Current options</p>
                    {Array.isArray(q.options) && q.options.length > 0 ? (
                      <ol className="text-xs text-slate-600 space-y-0.5">
                        {q.options.map((o, j) => (
                          <li key={j}><span className="font-bold">({j + 1})</span> {o || <span className="text-slate-400">(blank)</span>}</li>
                        ))}
                      </ol>
                    ) : (
                      <p className="text-xs text-slate-400 italic">(none stored)</p>
                    )}
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Proposed</p>
                      <button onClick={() => extractFor(q.id)} disabled={st.kind === "extracting"}
                        className="text-[10px] font-bold uppercase tracking-wider text-purple-600 hover:underline disabled:opacity-50">
                        {st.kind === "extracting" ? "Extracting…" : "Re-extract"}
                      </button>
                    </div>

                    {st.kind === "pending" && <p className="text-xs text-slate-400">Waiting…</p>}
                    {st.kind === "extracting" && <p className="text-xs text-slate-500">Extracting from image…</p>}
                    {st.kind === "error" && <p className="text-xs text-red-600">{st.message}</p>}
                    {st.kind === "text" && (
                      <div>
                        <p className="text-[10px] text-amber-700 font-bold mb-1">Gemini returned TEXT options, not a table:</p>
                        <ol className="text-xs text-slate-600 space-y-0.5">
                          {st.options.map((o, j) => (
                            <li key={j}><span className="font-bold">({j + 1})</span> {o}</li>
                          ))}
                        </ol>
                      </div>
                    )}
                    {st.kind === "table" && (
                      <div>
                        <p className="text-[10px] text-emerald-700 font-bold mb-1">Detected TABLE</p>
                        <table className="w-full text-xs border border-slate-800">
                          <thead>
                            <tr className="bg-slate-100">
                              <th className="border border-slate-800 px-2 py-1"></th>
                              {st.table.columns.map((c, j) => (
                                <th key={j} className="border border-slate-800 px-2 py-1 font-bold text-slate-800">{c}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {st.table.rows.map((row, ri) => (
                              <tr key={ri}>
                                <td className="border border-slate-800 px-2 py-1 font-bold text-slate-700 text-center">({ri + 1})</td>
                                {row.map((cell, ci) => (
                                  <td key={ci} className="border border-slate-800 px-2 py-1 text-slate-700">{cell}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {st.kind === "applied" && <p className="text-xs font-bold text-emerald-700">✅ Saved as table</p>}
                    {st.kind === "skipped" && <p className="text-xs font-bold text-slate-500">↩︎ Skipped</p>}
                  </div>
                </div>

                <div className="flex gap-2 pt-3 mt-3 border-t border-slate-100">
                  <button
                    onClick={() => st.kind === "table" && apply(q.id, st.table)}
                    disabled={st.kind !== "table"}
                    className="flex-1 py-2 rounded-xl bg-emerald-600 text-white text-sm font-bold disabled:bg-slate-200 disabled:text-slate-400">
                    Apply table
                  </button>
                  <button
                    onClick={() => skip(q.id)}
                    disabled={st.kind === "applied" || st.kind === "skipped"}
                    className="flex-1 py-2 rounded-xl border border-slate-300 text-slate-700 text-sm font-bold hover:bg-slate-50 disabled:opacity-50">
                    Skip
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
