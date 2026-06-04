"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import AdminNav from "@/components/AdminNav";

type PaperRow = {
  id: string;
  title: string;
  subject: string | null;
  year: string | null;
  createdAt: string;
  paperType: string | null;
  questionCount: number;
};

type Diff = {
  qId: string;
  qNum: string;
  status: "match" | "minor" | "diff" | "missing-stored" | "missing-extracted";
  stored: string;
  extracted: string;
  topic: string | null;
  marks: number | null;
  error?: string;
};

type AuditResult = {
  paperId: string;
  title: string;
  subject: string | null;
  year: string | null;
  answerPages?: number[];
  pageReadErrors?: string[];
  questionCount?: number;
  counts?: { match: number; minor: number; diff: number; missingStored: number; missingExtracted: number };
  diffs?: Diff[];
  error?: string;
};

export default function AdminAuditAnswerKeysPage() {
  return (
    <Suspense>
      <Content />
    </Suspense>
  );
}

function Content() {
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";
  const [papers, setPapers] = useState<PaperRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [subjectFilter, setSubjectFilter] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [auditing, setAuditing] = useState(false);
  const [currentPaperId, setCurrentPaperId] = useState<string | null>(null);
  const [results, setResults] = useState<AuditResult[]>([]);
  const [hideMatches, setHideMatches] = useState(true);
  const [hideMinor, setHideMinor] = useState(false);
  // Default: hide official PSLE papers (their MOE answer keys are
  // already vetted; the older school papers are where typos creep
  // in). Toggle off to include PSLE.
  const [hidePsle, setHidePsle] = useState(true);
  // Sort order — earliest scanned first by default so the admin can
  // sweep older scans where the bulk of stored-key issues live.
  const [sortOrder, setSortOrder] = useState<"earliest" | "latest">("earliest");

  useEffect(() => {
    fetch(`/api/admin/papers?userId=${userId}`)
      .then(r => r.ok ? r.json() : { papers: [] })
      .then(d => setPapers(d.papers ?? []))
      .finally(() => setLoading(false));
  }, [userId]);

  const subjects = useMemo(
    () => [...new Set(papers.map(p => p.subject).filter((s): s is string => !!s))].sort(),
    [papers],
  );

  const filtered = useMemo(() => {
    const term = search.toLowerCase();
    return papers
      .filter(p => p.paperType === null) // masters only
      .filter(p => !subjectFilter || p.subject === subjectFilter)
      .filter(p => !term || p.title.toLowerCase().includes(term))
      .filter(p => !hidePsle || !/psle/i.test(p.title))
      .slice()
      .sort((a, b) => {
        const aT = new Date(a.createdAt).getTime();
        const bT = new Date(b.createdAt).getTime();
        return sortOrder === "earliest" ? aT - bT : bT - aT;
      })
      .slice(0, 200);
  }, [papers, search, subjectFilter, hidePsle, sortOrder]);

  function toggle(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runAudit() {
    if (selectedIds.size === 0 || auditing) return;
    setAuditing(true);
    setResults([]);
    for (const paperId of selectedIds) {
      setCurrentPaperId(paperId);
      try {
        const r = await fetch(`/api/admin/audit-answer-keys`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paperId }),
        });
        const json = await r.json() as AuditResult;
        setResults(prev => [...prev, json]);
      } catch (err) {
        const paper = papers.find(p => p.id === paperId);
        setResults(prev => [...prev, { paperId, title: paper?.title ?? paperId, subject: paper?.subject ?? null, year: paper?.year ?? null, error: err instanceof Error ? err.message : String(err) }]);
      }
    }
    setCurrentPaperId(null);
    setAuditing(false);
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      {/* lg:ml-56 clears the fixed-width admin sidebar so the content
          isn't hidden behind it (same pattern as /admin/papers). */}
      <div className="lg:ml-56 pb-24 lg:pb-0">
        <div className="max-w-5xl mx-auto px-5 lg:px-8 py-8">
        <h1 className="font-headline text-2xl font-extrabold text-[#001e40] mb-2">Audit answer keys</h1>
        <p className="text-sm text-slate-500 mb-6">
          Pick 1-3 papers and run an audit. Each paper&apos;s answer-key pages are re-extracted with gemini-3.1-pro-preview and diffed against the stored question.answer rows. Takes ~30s per paper.
        </p>

        {/* Filters */}
        <div className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 mb-4">
          <div className="flex flex-col sm:flex-row gap-3 items-stretch">
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by title…"
              className="flex-1 px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-blue-400"
            />
            <select
              value={subjectFilter ?? ""}
              onChange={e => setSubjectFilter(e.target.value || null)}
              className="px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-blue-400"
            >
              <option value="">All subjects</option>
              {subjects.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <select
              value={sortOrder}
              onChange={e => setSortOrder(e.target.value as "earliest" | "latest")}
              className="px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-blue-400"
              title="Sort by scanned/created date"
            >
              <option value="earliest">Earliest first</option>
              <option value="latest">Latest first</option>
            </select>
            <button
              onClick={runAudit}
              disabled={selectedIds.size === 0 || auditing}
              className="px-5 py-2 rounded-lg bg-violet-500 text-white text-sm font-bold hover:bg-violet-600 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {auditing ? "Running…" : `Run audit (${selectedIds.size})`}
            </button>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={hidePsle}
                onChange={e => setHidePsle(e.target.checked)}
                className="w-4 h-4 accent-violet-500"
              />
              Hide official PSLE papers (focus on school-paper scans)
            </label>
          </div>
        </div>

        {/* Paper list */}
        <div className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 mb-6">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">
            Pick papers ({filtered.length} shown)
          </p>
          {loading ? (
            <p className="text-sm text-slate-400 py-4">Loading…</p>
          ) : (
            <div className="space-y-1 max-h-96 overflow-y-auto">
              {filtered.map(p => {
                const isSel = selectedIds.has(p.id);
                const isCur = currentPaperId === p.id;
                return (
                  <label
                    key={p.id}
                    className={`flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
                      isSel ? "bg-violet-50" : "hover:bg-slate-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSel}
                      onChange={() => toggle(p.id)}
                      disabled={auditing}
                      className="w-4 h-4 accent-violet-500"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-slate-800 truncate">{p.title}</p>
                      <p className="text-xs text-slate-400 mt-0.5">
                        {[p.subject, p.year, `${p.questionCount}q`].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    {isCur && <span className="text-[10px] font-bold text-violet-600 animate-pulse">Auditing…</span>}
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* Results */}
        {results.length > 0 && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-headline text-xl font-extrabold text-[#001e40]">Results</h2>
              <div className="flex items-center gap-3 text-xs text-slate-600">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={hideMatches} onChange={e => setHideMatches(e.target.checked)} className="accent-violet-500" />
                  Hide matches
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={hideMinor} onChange={e => setHideMinor(e.target.checked)} className="accent-violet-500" />
                  Hide minor
                </label>
              </div>
            </div>
            <div className="space-y-4">
              {results.map(r => <ResultCard key={r.paperId} result={r} hideMatches={hideMatches} hideMinor={hideMinor} userId={userId} />)}
            </div>
          </div>
        )}
        </div>
      </div>
    </div>
  );
}

function ResultCard({ result, hideMatches, hideMinor, userId }: { result: AuditResult; hideMatches: boolean; hideMinor: boolean; userId: string }) {
  const counts = result.counts ?? { match: 0, minor: 0, diff: 0, missingStored: 0, missingExtracted: 0 };
  const filteredDiffs = (result.diffs ?? []).filter(d => {
    if (hideMatches && d.status === "match") return false;
    if (hideMinor && d.status === "minor") return false;
    return true;
  });
  const editUrl = `/exam/${result.paperId}/edit${userId ? `?userId=${userId}` : ""}`;
  return (
    <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
      <div className="flex items-start justify-between mb-3">
        <div>
          <h3 className="font-bold text-slate-800">{result.title}</h3>
          <p className="text-xs text-slate-400 mt-0.5">
            {[result.subject, result.year].filter(Boolean).join(" · ")}
            {result.answerPages && result.answerPages.length > 0 && <> · pages {result.answerPages.join(", ")}</>}
          </p>
        </div>
        <a href={editUrl} target="_blank" rel="noreferrer" className="text-xs font-bold text-violet-600 hover:underline">
          Open /edit →
        </a>
      </div>
      {result.error ? (
        <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{result.error}</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 mb-3">
            <Pill label="diff" count={counts.diff} bg="bg-red-100" fg="text-red-700" />
            <Pill label="minor" count={counts.minor} bg="bg-amber-100" fg="text-amber-700" />
            <Pill label="missing-stored" count={counts.missingStored} bg="bg-orange-100" fg="text-orange-700" />
            <Pill label="missing-extracted" count={counts.missingExtracted} bg="bg-blue-100" fg="text-blue-700" />
            <Pill label="match" count={counts.match} bg="bg-emerald-50" fg="text-emerald-700" />
          </div>
          {result.pageReadErrors && result.pageReadErrors.length > 0 && (
            <p className="text-[11px] text-rose-500 mb-2">
              Page read errors: {result.pageReadErrors.join(", ")}
            </p>
          )}
          {filteredDiffs.length === 0 ? (
            <p className="text-xs text-emerald-700 italic">All clear (no rows match the visible filters).</p>
          ) : (
            <div className="space-y-3">
              {filteredDiffs.map(d => <DiffRow key={d.qId} diff={d} userId={userId} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DiffRow({ diff, userId }: { diff: Diff; userId: string }) {
  // Local action state so the row can be marked as applied / kept /
  // failed without re-fetching the whole audit. Stays sticky after
  // the action so the admin can see what they just did.
  const [action, setAction] = useState<"idle" | "saving" | "applied" | "kept" | "error">("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  async function applyExtracted() {
    setAction("saving");
    setErrMsg(null);
    try {
      const r = await fetch(`/api/exam/questions/${diff.qId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: diff.extracted }),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        setErrMsg(`HTTP ${r.status}${body ? `: ${body.slice(0, 120)}` : ""}`);
        setAction("error");
        return;
      }
      setAction("applied");
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : String(err));
      setAction("error");
    }
  }

  const editUrl = `/exam/${""}`; // not used here — kept for parity; per-Q open uses the qId.

  return (
    <div className={`rounded-xl border ${action === "applied" ? "border-emerald-200 bg-emerald-50/40" : action === "kept" ? "border-slate-200 bg-slate-50/60" : "border-slate-200 bg-white"} p-3`}>
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-slate-700">Q{diff.qNum}</span>
          <StatusBadge status={diff.status} />
          {diff.marks != null && <span className="text-[10px] text-slate-400">{diff.marks} mark{diff.marks === 1 ? "" : "s"}</span>}
          {diff.topic && <span className="text-[10px] text-slate-400 truncate max-w-[160px]" title={diff.topic}>· {diff.topic}</span>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {action === "idle" && (
            <>
              <button
                onClick={applyExtracted}
                disabled={!diff.extracted || diff.status === "missing-extracted"}
                className="text-[11px] font-bold px-3 py-1.5 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title={diff.status === "missing-extracted" ? "Nothing to apply — extractor didn't return a row" : "Replace the stored answer with the extracted version"}
              >
                ✓ Use extracted
              </button>
              <button
                onClick={() => setAction("kept")}
                className="text-[11px] font-bold px-3 py-1.5 rounded-lg bg-slate-100 text-slate-700 hover:bg-slate-200 transition-colors"
                title="Keep the stored answer, mark this row as reviewed"
              >
                ✗ Keep stored
              </button>
            </>
          )}
          {action === "saving" && <span className="text-[11px] font-bold text-slate-500">Saving…</span>}
          {action === "applied" && <span className="text-[11px] font-bold text-emerald-700">✓ Applied</span>}
          {action === "kept" && (
            <button
              onClick={() => setAction("idle")}
              className="text-[11px] font-bold text-slate-500 hover:text-slate-700 underline"
              title="Undo — bring the buttons back"
            >Kept · undo</button>
          )}
          {action === "error" && (
            <button onClick={applyExtracted} className="text-[11px] font-bold text-rose-700 underline">Retry</button>
          )}
          <a
            href={`/exam/questions/${diff.qId}`}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-slate-400 hover:text-slate-600"
            title="Open question in a new tab"
          >open</a>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">Currently stored</p>
          <p className="text-xs text-slate-800 whitespace-pre-wrap break-words">{diff.stored || "—"}</p>
        </div>
        <div className="rounded-lg border border-violet-200 bg-violet-50/50 p-2">
          <p className="text-[10px] font-bold uppercase tracking-wider text-violet-600 mb-1">Extracted (3.1-pro)</p>
          <p className="text-xs text-slate-800 whitespace-pre-wrap break-words">{diff.extracted || "—"}</p>
        </div>
      </div>
      {errMsg && action === "error" && (
        <p className="text-[11px] text-rose-700 mt-2">Save failed: {errMsg}</p>
      )}
      {diff.error && (
        <p className="text-[11px] text-rose-500 mt-2">Extract error: {diff.error}</p>
      )}
    </div>
  );
}

function Pill({ label, count, bg, fg }: { label: string; count: number; bg: string; fg: string }) {
  return (
    <span className={`px-2 py-0.5 rounded-md text-[11px] font-bold ${bg} ${fg}`}>
      {label} {count}
    </span>
  );
}

function StatusBadge({ status }: { status: Diff["status"] }) {
  const map: Record<Diff["status"], { bg: string; fg: string }> = {
    diff: { bg: "bg-red-100", fg: "text-red-700" },
    minor: { bg: "bg-amber-100", fg: "text-amber-700" },
    "missing-stored": { bg: "bg-orange-100", fg: "text-orange-700" },
    "missing-extracted": { bg: "bg-blue-100", fg: "text-blue-700" },
    match: { bg: "bg-emerald-50", fg: "text-emerald-700" },
  };
  const m = map[status];
  return <span className={`px-1.5 py-0.5 rounded-md text-[10px] font-bold ${m.bg} ${m.fg}`}>{status}</span>;
}

function truncate(s: string, n: number): string {
  if (!s) return "—";
  return s.length <= n ? s : s.slice(0, n) + "…";
}
