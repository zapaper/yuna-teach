"use client";

// Admin page: Fix Science OEQ alignment.
//
// Walks master science questions whose subpart labels don't line up
// with the pipe-segmented answer key. For each, calls Gemini to
// re-extract the question and proposes a new subpart shape. Admin
// reviews the diff, then clicks Apply to save.
//
// Dry-run first, never auto-applies on page load.

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

type Subpart = { label: string; text?: string };
type Proposal = {
  paperId: string;
  paperTitle: string;
  questionId: string;
  questionNum: string;
  oldLabels: string[];
  newLabels: string[];
  oldStem: string | null;
  newStem: string | null;
  oldSubparts: Subpart[];
  newSubparts: Subpart[];
  oldAnswer: string | null;
  oldMisses: number;
  newMisses: number;
  verdict: "improve" | "no-change" | "no-image" | "error";
  error?: string;
  applied?: boolean;
  imageDataUrl: string | null;
};

export default function Page() {
  return (
    <Suspense>
      <Content />
    </Suspense>
  );
}

function Content() {
  const sp = useSearchParams();
  const userId = sp.get("userId") ?? "";
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [totalBroken, setTotalBroken] = useState<number | null>(null);
  const [skippedNoChange, setSkippedNoChange] = useState<number | null>(null);
  const [papersCount, setPapersCount] = useState<number | null>(null);
  const [limit, setLimit] = useState(10);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [running, setRunning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ processed: number; improvable: number; applied: number } | null>(null);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`)
      .then(r => setAllowed(r.ok))
      .catch(() => setAllowed(false));
  }, [userId]);

  const fetchCounts = useCallback(async () => {
    setErr(null);
    try {
      const r = await fetch(`/api/admin/oeq-alignment-fix`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setTotalBroken(j.totalBroken);
      setSkippedNoChange(j.skippedNoChange ?? null);
      setPapersCount(j.papers ?? null);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  const resetSkipped = async () => {
    if (!confirm("Clear all 'no-change' flags? Questions previously scanned with no improvement will re-appear in future dry-runs. Use this after editing answer keys via transcribe-edit.")) return;
    setErr(null);
    try {
      const r = await fetch(`/api/admin/oeq-alignment-fix`, { method: "DELETE" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await fetchCounts();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  useEffect(() => { if (allowed) void fetchCounts(); }, [allowed, fetchCounts]);

  const runDryRun = async () => {
    setRunning(true);
    setErr(null);
    setProposals([]);
    setSummary(null);
    try {
      const r = await fetch(`/api/admin/oeq-alignment-fix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit, apply: false }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setProposals(j.proposals as Proposal[]);
      setSummary({ processed: j.processed, improvable: j.improvable, applied: j.applied });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const applyAll = async () => {
    const improvable = proposals.filter(p => p.verdict === "improve").length;
    if (improvable === 0) {
      setErr("Nothing to apply — no proposals were 'improve'.");
      return;
    }
    if (!confirm(`Apply ${improvable} subpart label fix(es) to the DB? This rewrites transcribedSubparts on each affected master question. Cannot be undone via this UI.`)) return;
    setApplying(true);
    setErr(null);
    try {
      const r = await fetch(`/api/admin/oeq-alignment-fix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit, apply: true }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setProposals(j.proposals as Proposal[]);
      setSummary({ processed: j.processed, improvable: j.improvable, applied: j.applied });
      // Refresh broken count after applying.
      await fetchCounts();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setApplying(false);
    }
  };

  if (allowed === null) return <p className="p-6 text-sm text-slate-500">Loading…</p>;
  if (!allowed) return <p className="p-6 text-sm text-red-600">Access denied.</p>;

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-5">
      <div>
        <Link href={`/admin?userId=${userId}`} className="text-sm text-slate-500 hover:underline">← Admin</Link>
        <h1 className="text-2xl font-bold mt-2">Science OEQ Alignment Fix</h1>
        <p className="text-sm text-slate-600 mt-1">
          Re-extracts master Science questions whose subpart labels don't match the answer-key labels.
          Only normalises label SHAPE (e.g. <code className="bg-slate-100 px-1">bi</code> → <code className="bg-slate-100 px-1">b-i</code>,
          or <code className="bg-slate-100 px-1">[a, b]</code> → <code className="bg-slate-100 px-1">[a, b-i, b-ii]</code>).
          Cannot synthesise missing answer-key content — those need manual review on transcribe-edit.
        </p>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-3">
        <div className="flex items-center gap-6 text-sm flex-wrap">
          <div>
            <span className="text-slate-500">Broken (un-scanned):</span>{" "}
            <span className="text-2xl font-bold text-slate-900">{totalBroken ?? "…"}</span>
            {papersCount !== null && (
              <span className="ml-2 text-slate-500">across {papersCount} paper(s)</span>
            )}
          </div>
          {skippedNoChange !== null && skippedNoChange > 0 && (
            <div className="text-xs text-slate-500">
              + <strong>{skippedNoChange}</strong> already scanned (no-change) — silenced
              <button
                onClick={resetSkipped}
                className="ml-2 text-amber-700 hover:text-amber-900 hover:underline"
                title="Clear the 'no-change' flags so these questions re-appear for re-scan. Use after editing answer keys."
              >Reset</button>
            </div>
          )}
          <button
            onClick={fetchCounts}
            className="text-xs text-slate-500 hover:text-slate-700 hover:underline"
          >Refresh</button>
        </div>
        <div className="flex items-end gap-3">
          <label className="text-sm">
            <span className="block text-slate-500 mb-1">Batch size</span>
            <input
              type="number"
              min={1}
              max={50}
              value={limit}
              onChange={e => setLimit(Math.max(1, Math.min(50, parseInt(e.target.value) || 10)))}
              className="border border-slate-300 rounded-md px-2 py-1 w-20 text-sm"
            />
          </label>
          <button
            onClick={runDryRun}
            disabled={running || applying || !totalBroken}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {running ? "Re-extracting…" : `Dry-run (next ${Math.min(limit, totalBroken ?? limit)})`}
          </button>
          {proposals.length > 0 && (
            <button
              onClick={applyAll}
              disabled={running || applying || proposals.filter(p => p.verdict === "improve").length === 0}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {applying ? "Applying…" : `Apply ${proposals.filter(p => p.verdict === "improve").length} fix(es)`}
            </button>
          )}
        </div>
        {summary && (
          <p className="text-xs text-slate-500">
            Processed {summary.processed}, improvable {summary.improvable}, applied {summary.applied}.
          </p>
        )}
        {err && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700">{err}</div>
        )}
      </div>

      {proposals.length > 0 && (
        <div className="space-y-3">
          {proposals.map((p, i) => (
            <ProposalCard key={p.questionId} p={p} idx={i + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProposalCard({ p, idx }: { p: Proposal; idx: number }) {
  const badge =
    p.verdict === "improve" ? "bg-emerald-100 text-emerald-700" :
    p.verdict === "no-change" ? "bg-slate-100 text-slate-600" :
    "bg-rose-100 text-rose-700";
  const label =
    p.verdict === "improve" ? (p.applied ? "APPLIED" : "WOULD APPLY") :
    p.verdict === "no-change" ? "NO CHANGE" :
    p.verdict === "no-image" ? "NO IMAGE" :
    "ERROR";
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4">
      <div className="flex items-baseline justify-between">
        <div>
          <span className={`inline-block px-2 py-0.5 rounded-md text-[11px] font-semibold ${badge}`}>{label}</span>
          <span className="ml-2 text-sm font-medium text-slate-900">#{idx} · Q{p.questionNum}</span>
          <span className="ml-2 text-xs text-slate-500">{p.paperTitle}</span>
        </div>
        <a
          href={`https://www.markforyou.com/exam/${p.paperId}/transcribe-edit`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-slate-500 hover:underline"
        >transcribe-edit ↗</a>
      </div>
      {p.error && <p className="mt-2 text-xs text-rose-700">{p.error}</p>}

      {/* THE QUESTION IMAGE — admin can visually verify Gemini's proposal
          against what the scanned question actually shows. */}
      {p.imageDataUrl && (
        <div className="mt-3 bg-slate-50 border border-slate-200 rounded-lg p-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1 font-semibold">Question image</div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={p.imageDataUrl} alt={`Q${p.questionNum}`} className="max-h-96 w-auto mx-auto border border-slate-100 rounded" />
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-4 text-xs">
        <div>
          <div className="text-slate-500 mb-1 font-semibold">
            BEFORE — subpart labels <code className="bg-slate-100 px-1">[{p.oldLabels.join(", ")}]</code>, misses {p.oldMisses}
          </div>
          {p.oldStem && (
            <div className="mb-2 bg-slate-50 border border-slate-200 rounded px-2 py-1 text-slate-600 whitespace-pre-wrap">
              <span className="text-[10px] text-slate-500 uppercase tracking-wide">Stem</span><br />
              {p.oldStem}
            </div>
          )}
          <ul className="space-y-1 text-slate-700">
            {p.oldSubparts.map((s, i) => (
              <li key={i} className="whitespace-pre-wrap">
                <span className="font-semibold">({s.label})</span> {s.text ?? ""}
              </li>
            ))}
          </ul>
          {p.oldAnswer && (
            <div className="mt-2 bg-amber-50 border border-amber-200 rounded px-2 py-1 text-slate-700 whitespace-pre-wrap">
              <span className="text-[10px] text-amber-700 uppercase tracking-wide font-semibold">Answer key</span><br />
              {p.oldAnswer}
            </div>
          )}
        </div>
        <div>
          <div className="text-slate-500 mb-1 font-semibold">
            AFTER (Gemini re-extract) — subpart labels <code className="bg-slate-100 px-1">[{p.newLabels.join(", ")}]</code>, misses {p.newMisses}
          </div>
          {p.newStem && (
            <div className="mb-2 bg-slate-50 border border-slate-200 rounded px-2 py-1 text-slate-600 whitespace-pre-wrap">
              <span className="text-[10px] text-slate-500 uppercase tracking-wide">Stem</span><br />
              {p.newStem}
            </div>
          )}
          <ul className="space-y-1 text-slate-700">
            {p.newSubparts.map((s, i) => (
              <li key={i} className="whitespace-pre-wrap">
                <span className="font-semibold">({s.label})</span> {s.text ?? ""}
              </li>
            ))}
          </ul>
          <div className="mt-2 text-[10px] text-slate-400 italic">
            Note: Gemini re-extract proposes subpart shape only. The answer key isn't auto-edited.
          </div>
        </div>
      </div>
    </div>
  );
}
