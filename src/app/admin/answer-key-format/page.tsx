"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import AdminNav from "@/components/AdminNav";

type Row = {
  id: string;
  questionNum: string;
  paperId: string;
  paperTitle: string;
  level: number | null;
  subject: string | null;
  before: string;
  after: string;
};

export default function AnswerKeyFormatPage() {
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
  const [scanning, setScanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [scannedCount, setScannedCount] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [filterLevel, setFilterLevel] = useState<"all" | "3" | "4" | "5" | "6">("all");
  const [filterSubject, setFilterSubject] = useState<"all" | "math" | "science">("all");

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`).then(r => setAllowed(r.ok)).catch(() => setAllowed(false));
  }, [userId]);

  const scan = useCallback(async () => {
    setScanning(true);
    setError(null);
    setRows([]);
    setSelected(new Set());
    setAppliedIds(new Set());
    setScannedCount(null);
    try {
      const res = await fetch(`/api/admin/answer-key-format`);
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `${res.status}`);
      }
      const data: { scannedCount: number; changedCount: number; rows: Row[] } = await res.json();
      setRows(data.rows);
      setScannedCount(data.scannedCount);
      // Pre-tick everything by default; admin un-checks anything that looks wrong.
      setSelected(new Set(data.rows.map(r => r.id)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  }, []);

  const filtered = useMemo(() => {
    return rows.filter(r => {
      if (filterLevel !== "all" && String(r.level ?? "") !== filterLevel) return false;
      if (filterSubject !== "all") {
        const subj = (r.subject ?? "").toLowerCase();
        if (filterSubject === "math" && !subj.includes("math")) return false;
        if (filterSubject === "science" && !subj.includes("science")) return false;
      }
      return true;
    });
  }, [rows, filterLevel, filterSubject]);

  const applySelected = useCallback(async () => {
    const ids = filtered.filter(r => selected.has(r.id) && !appliedIds.has(r.id)).map(r => r.id);
    if (ids.length === 0) return;
    setApplying(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/answer-key-format`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `${res.status}`);
      }
      const data: { updated: number; skipped: number } = await res.json();
      setAppliedIds(prev => {
        const next = new Set(prev);
        for (const id of ids) next.add(id);
        return next;
      });
      setError(null);
      console.log(`Applied ${data.updated}, skipped ${data.skipped}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }, [filtered, selected, appliedIds]);

  function toggleRow(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function selectAll() {
    setSelected(new Set(filtered.map(r => r.id)));
  }
  function selectNone() {
    setSelected(new Set());
  }

  if (allowed === null) return null;
  if (!allowed) {
    return (
      <div className="min-h-screen bg-slate-50 p-8">
        <p className="text-slate-600">You don&apos;t have admin access.</p>
      </div>
    );
  }

  const pendingCount = filtered.filter(r => selected.has(r.id) && !appliedIds.has(r.id)).length;

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <main className="lg:ml-56 px-4 lg:px-8 py-6 pb-24 lg:pb-8 max-w-6xl">
        <h1 className="text-2xl font-bold text-slate-900 mb-2">Answer-Key Format Normaliser</h1>
        <p className="text-sm text-slate-600 mb-6">
          Scans math/science OEQ answer keys and proposes deterministic
          sub-part label fixes: <code>7a)</code> → <code>(a)</code>,
          <code>{" b)(i) "}</code> → <code>(b)(i)</code>, bare <code>(i)</code>{" "}
          under a parent letter → <code>(parent)(i)</code>. No AI — pure string
          transforms on known printed conventions.
        </p>

        <div className="flex flex-wrap items-center gap-3 mb-4">
          <button
            onClick={scan}
            disabled={scanning || applying}
            className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50"
          >
            {scanning ? "Scanning…" : "Scan for format issues"}
          </button>
          {scannedCount !== null && (
            <span className="text-sm text-slate-600">
              Scanned {scannedCount} OEQs · {rows.length} would change
            </span>
          )}
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
            {error}
          </div>
        )}

        {rows.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-3 mb-3 text-sm">
              <label className="flex items-center gap-2">
                <span className="text-slate-600">Level:</span>
                <select
                  value={filterLevel}
                  onChange={(e) => setFilterLevel(e.target.value as "all" | "3" | "4" | "5" | "6")}
                  className="border border-slate-300 rounded px-2 py-1"
                >
                  <option value="all">All</option>
                  <option value="3">P3</option>
                  <option value="4">P4</option>
                  <option value="5">P5</option>
                  <option value="6">P6</option>
                </select>
              </label>
              <label className="flex items-center gap-2">
                <span className="text-slate-600">Subject:</span>
                <select
                  value={filterSubject}
                  onChange={(e) => setFilterSubject(e.target.value as "all" | "math" | "science")}
                  className="border border-slate-300 rounded px-2 py-1"
                >
                  <option value="all">All</option>
                  <option value="math">Math</option>
                  <option value="science">Science</option>
                </select>
              </label>
              <span className="text-slate-400 mx-2">|</span>
              <button onClick={selectAll} className="text-blue-600 hover:underline">Select all</button>
              <button onClick={selectNone} className="text-blue-600 hover:underline">Select none</button>
              <span className="text-slate-500 ml-auto">
                {pendingCount} selected · {appliedIds.size} applied
              </span>
              <button
                onClick={applySelected}
                disabled={applying || pendingCount === 0}
                className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
              >
                {applying ? "Applying…" : `Apply ${pendingCount} selected`}
              </button>
            </div>

            <div className="space-y-3">
              {filtered.map(r => {
                const isApplied = appliedIds.has(r.id);
                return (
                  <div
                    key={r.id}
                    className={`bg-white rounded-xl border p-4 ${isApplied ? "border-emerald-300 bg-emerald-50/50" : "border-slate-200"}`}
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        checked={selected.has(r.id)}
                        disabled={isApplied}
                        onChange={() => toggleRow(r.id)}
                        className="mt-1.5"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2 text-xs text-slate-500">
                          <span className="font-semibold text-slate-700">Q{r.questionNum}</span>
                          {r.level && <span>· P{r.level}</span>}
                          {r.subject && <span>· {r.subject}</span>}
                          <span className="truncate">· {r.paperTitle}</span>
                          {isApplied && <span className="ml-auto px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-xs font-medium">Applied</span>}
                        </div>
                        <div className="grid md:grid-cols-2 gap-3 text-sm">
                          <div>
                            <div className="text-xs font-semibold text-rose-600 mb-1">Before</div>
                            <pre className="whitespace-pre-wrap font-mono text-xs bg-rose-50 p-2 rounded border border-rose-100 text-slate-800">{r.before}</pre>
                          </div>
                          <div>
                            <div className="text-xs font-semibold text-emerald-600 mb-1">After</div>
                            <pre className="whitespace-pre-wrap font-mono text-xs bg-emerald-50 p-2 rounded border border-emerald-100 text-slate-800">{r.after}</pre>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {rows.length === 0 && scannedCount !== null && !scanning && (
          <div className="p-6 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm">
            No format issues found. Scanned {scannedCount} math/science OEQs — all are in the canonical <code>(a)</code> / <code>(a)(i)</code> format.
          </div>
        )}
      </main>
    </div>
  );
}
