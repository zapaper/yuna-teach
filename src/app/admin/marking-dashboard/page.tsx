"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import AdminNav from "@/components/AdminNav";

type Bucket = { bucket: string; total: number; complete: number; failed: number; inProgress: number; stuck: number };
type Anomaly = {
  id: string;
  title: string;
  subject: string | null;
  paperType: string | null;
  completedAt: string;
  ageMin: number;
  markingStatus: string | null;
  ownerName: string | null;
  ownerId: string | null;
  studentName: string | null;
  studentId: string | null;
  parentName: string | null;
  parentId: string | null;
  score: number | null;
  totalMarks: string | null;
  scorePct: number | null;
  questionCount: number;
  markedCount?: number;
  reason: "failed" | "stuck" | "complete-zero-marked" | "low-score" | "zero-score";
};
type Data = {
  now: string;
  tz: string;
  hourly: Bucket[];
  daily: Bucket[];
  totals: { total: number; complete: number; failed: number; stuck: number; zeroMarked: number; inProgress: number; zeroScore: number; lowScore: number };
  lowScoreThresholdPct: number;
  anomalies: { failed: Anomaly[]; stuck: Anomaly[]; zeroMarked: Anomaly[]; zeroScore: Anomaly[]; lowScore: Anomaly[] };
};

export default function Page() {
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
  const [data, setData] = useState<Data | null>(null);
  const [remarking, setRemarking] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`).then((r) => setAllowed(r.ok)).catch(() => setAllowed(false));
  }, [userId]);

  const load = useCallback(async () => {
    setErr(null);
    const r = await fetch("/api/admin/marking-dashboard");
    if (r.ok) setData(await r.json());
    else setErr(`Failed to load (HTTP ${r.status})`);
  }, []);
  useEffect(() => { if (allowed) load(); }, [allowed, load]);

  // Auto-refresh every 60s so the dashboard reflects live activity
  // without the admin having to F5.
  useEffect(() => {
    if (!allowed) return;
    const id = setInterval(() => load(), 60_000);
    return () => clearInterval(id);
  }, [allowed, load]);

  const handleRemark = useCallback(async (paperId: string) => {
    setRemarking((s) => new Set(s).add(paperId));
    try {
      const r = await fetch(`/api/exam/${paperId}/mark`, { method: "POST" });
      if (!r.ok) {
        const msg = await r.text().catch(() => "");
        alert(`Re-mark failed (HTTP ${r.status}): ${msg.slice(0, 200)}`);
      } else {
        // Re-fetch dashboard after a few seconds — marker runs async,
        // status will flip from failed/stuck to in_progress shortly.
        setTimeout(() => load(), 4000);
      }
    } finally {
      setRemarking((s) => { const n = new Set(s); n.delete(paperId); return n; });
    }
  }, [load]);

  if (allowed === false) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <p className="text-sm text-slate-500">Admin only.</p>
    </div>
  );

  const maxHourly = data ? Math.max(1, ...data.hourly.map((b) => b.total)) : 1;
  const maxDaily = data ? Math.max(1, ...data.daily.map((b) => b.total)) : 1;

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      {/* lg:ml-56 — push past the fixed 224-px left sidebar; pb-24 on
          mobile to clear the bottom bar nav. */}
      <main className="lg:ml-56 pb-24 lg:pb-0 max-w-6xl mx-auto p-6 space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-slate-800">Marking Dashboard</h1>
            <p className="text-sm text-slate-500">
              Real-user submission volume + marker health. Auto-refreshes every 60s.
            </p>
          </div>
          <button
            onClick={load}
            className="text-xs font-semibold px-3 py-1.5 rounded-md bg-white border border-slate-200 hover:bg-slate-100 text-slate-700"
          >
            Refresh now
          </button>
        </header>

        {err && <p className="text-sm text-red-600">{err}</p>}
        {!data ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : (
          <>
            {/* Headline counters */}
            <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {[
                { k: "total", label: "Last 14d", color: "bg-slate-100 text-slate-800" },
                { k: "complete", label: "Complete", color: "bg-green-50 text-green-700" },
                { k: "inProgress", label: "In-progress (active)", color: "bg-blue-50 text-blue-700" },
                { k: "stuck", label: "Stuck (>5min)", color: "bg-amber-50 text-amber-700" },
                { k: "failed", label: "Failed", color: "bg-red-50 text-red-700" },
                { k: "zeroMarked", label: "Silent zero-mark", color: "bg-fuchsia-50 text-fuchsia-700" },
                { k: "zeroScore", label: "Zero score", color: "bg-rose-50 text-rose-700" },
                { k: "lowScore", label: `Low score (<${data.lowScoreThresholdPct}%)`, color: "bg-orange-50 text-orange-700" },
              ].map((c) => (
                <div key={c.k} className={`rounded-xl p-3 ${c.color}`}>
                  <div className="text-[10px] uppercase tracking-wider opacity-70">{c.label}</div>
                  <div className="text-2xl font-bold">{(data.totals as Record<string, number>)[c.k] ?? 0}</div>
                </div>
              ))}
            </section>

            {/* Hourly chart — last 24h */}
            <section className="bg-white rounded-2xl border border-slate-200 p-5">
              <h2 className="text-sm font-bold text-slate-700 mb-3">Last 24 hours · {data.tz}</h2>
              <div className="flex items-end gap-1 h-32">
                {data.hourly.map((b, i) => {
                  const hPct = Math.round((b.total / maxHourly) * 100);
                  const failPct = b.total > 0 ? Math.round((b.failed / b.total) * 100) : 0;
                  const stuckPct = b.total > 0 ? Math.round((b.stuck / b.total) * 100) : 0;
                  return (
                    <div key={i} className="flex-1 flex flex-col items-center gap-1" title={`${b.bucket} — total ${b.total}, complete ${b.complete}, in-progress ${b.inProgress}, stuck ${b.stuck}, failed ${b.failed}`}>
                      <div className="w-full flex-1 flex flex-col-reverse">
                        <div className="bg-green-500" style={{ height: `${hPct}%`, minHeight: b.total > 0 ? 2 : 0 }} />
                        {failPct > 0 && <div className="bg-red-500" style={{ height: `${failPct}%`, minHeight: 2 }} />}
                        {stuckPct > 0 && <div className="bg-amber-500" style={{ height: `${stuckPct}%`, minHeight: 2 }} />}
                      </div>
                      <div className="text-[9px] text-slate-400 -rotate-45 origin-top-left whitespace-nowrap mt-1 ml-2">{b.bucket.slice(11, 13)}</div>
                    </div>
                  );
                })}
              </div>
              <p className="text-[10px] text-slate-400 mt-2">Hour labels are SGT (UTC+8). Hover a bar for details.</p>
            </section>

            {/* Daily chart — last 14d */}
            <section className="bg-white rounded-2xl border border-slate-200 p-5">
              <h2 className="text-sm font-bold text-slate-700 mb-3">Last 14 days · {data.tz}</h2>
              <div className="flex items-end gap-2 h-32">
                {data.daily.map((b, i) => {
                  const hPct = Math.round((b.total / maxDaily) * 100);
                  return (
                    <div key={i} className="flex-1 flex flex-col items-center gap-1" title={`${b.bucket} — total ${b.total}, complete ${b.complete}, in-progress ${b.inProgress}, stuck ${b.stuck}, failed ${b.failed}`}>
                      <div className="w-full flex-1 flex flex-col-reverse">
                        <div className="bg-green-500" style={{ height: `${hPct}%`, minHeight: b.total > 0 ? 2 : 0 }} />
                        {b.failed > 0 && <div className="bg-red-500" style={{ height: `${(b.failed / b.total) * 100}%`, minHeight: 2 }} />}
                        {b.stuck > 0 && <div className="bg-amber-500" style={{ height: `${(b.stuck / b.total) * 100}%`, minHeight: 2 }} />}
                      </div>
                      <div className="text-[10px] text-slate-500">{b.bucket.slice(5)}</div>
                      <div className="text-[9px] text-slate-400 font-bold">{b.total}</div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Anomalies */}
            <AnomalySection
              title="Failed marks"
              items={data.anomalies.failed}
              userId={userId}
              onRemark={handleRemark}
              remarking={remarking}
              accent="red"
              emptyLabel="No failed marks in the last 7 days."
            />
            <AnomalySection
              title="Stuck (>5 minutes in_progress)"
              items={data.anomalies.stuck}
              userId={userId}
              onRemark={handleRemark}
              remarking={remarking}
              accent="amber"
              emptyLabel="No stuck markers."
            />
            <AnomalySection
              title="Complete but zero questions marked"
              items={data.anomalies.zeroMarked}
              userId={userId}
              onRemark={handleRemark}
              remarking={remarking}
              accent="fuchsia"
              emptyLabel="No silent zero-mark anomalies."
            />
            <AnomalySection
              title="Zero score (likely scan or marker issue, not student)"
              items={data.anomalies.zeroScore}
              userId={userId}
              onRemark={handleRemark}
              remarking={remarking}
              accent="rose"
              emptyLabel="No zero-score papers in the last 7 days."
            />
            <AnomalySection
              title={`Low score (<${data.lowScoreThresholdPct}%) — investigate scan / marker / struggle`}
              items={data.anomalies.lowScore}
              userId={userId}
              onRemark={handleRemark}
              remarking={remarking}
              accent="orange"
              emptyLabel="No low-scoring papers in the last 7 days."
            />
          </>
        )}
      </main>
    </div>
  );
}

function AnomalySection({
  title,
  items,
  userId,
  onRemark,
  remarking,
  accent,
  emptyLabel,
}: {
  title: string;
  items: Anomaly[];
  userId: string;
  onRemark: (id: string) => void;
  remarking: Set<string>;
  accent: "red" | "amber" | "fuchsia" | "rose" | "orange";
  emptyLabel: string;
}) {
  const ring =
    accent === "red" ? "border-red-200 bg-red-50/40"
    : accent === "amber" ? "border-amber-200 bg-amber-50/40"
    : accent === "fuchsia" ? "border-fuchsia-200 bg-fuchsia-50/40"
    : accent === "rose" ? "border-rose-200 bg-rose-50/40"
    : "border-orange-200 bg-orange-50/40";
  const dot =
    accent === "red" ? "bg-red-500"
    : accent === "amber" ? "bg-amber-500"
    : accent === "fuchsia" ? "bg-fuchsia-500"
    : accent === "rose" ? "bg-rose-500"
    : "bg-orange-500";
  return (
    <section className={`rounded-2xl border p-5 space-y-3 ${ring}`}>
      <h2 className="text-sm font-bold text-slate-700 flex items-center gap-2">
        <span className={`inline-block w-2 h-2 rounded-full ${dot}`} />
        {title} ({items.length})
      </h2>
      {items.length === 0 ? (
        <p className="text-xs text-slate-500">{emptyLabel}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((p) => (
            <li key={p.id} className="bg-white rounded-xl border border-slate-200 p-3 text-xs">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-slate-800 truncate">{p.title}</span>
                    {p.subject && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 uppercase tracking-wider">{p.subject}</span>
                    )}
                    {p.paperType && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">{p.paperType}</span>
                    )}
                  </div>
                  {/* Score line — only present for low/zero-score rows */}
                  {p.scorePct !== null && (
                    <div className="text-[12px] font-bold mt-1.5">
                      Score: <span className="text-rose-700">{p.score}/{p.totalMarks}</span> · <span className="text-rose-700">{p.scorePct}%</span>
                    </div>
                  )}
                  <div className="text-[11px] text-slate-600 mt-1.5 space-y-0.5">
                    <div>
                      <span className="font-semibold text-slate-700">Student:</span>{" "}
                      {p.studentName ?? <span className="italic text-slate-400">none assigned (self-submit)</span>}
                      {p.parentName && p.parentName !== p.studentName && (
                        <>  ·  <span className="font-semibold text-slate-700">Parent:</span> {p.parentName}</>
                      )}
                    </div>
                    <div className="text-slate-500">
                      completed {new Date(p.completedAt).toLocaleString()} · age {p.ageMin} min · status <span className="font-bold text-slate-700">{p.markingStatus ?? "?"}</span>{p.scorePct === null ? <> · score {p.score ?? "?"}/{p.totalMarks ?? "?"}</> : null} · {p.questionCount} Q
                    </div>
                  </div>
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  <a
                    href={`/exam/${p.id}/review?userId=${userId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] text-blue-700 underline hover:text-blue-900"
                  >
                    Open review ↗
                  </a>
                  {p.parentId && (
                    <a
                      href={`/home/${p.parentId}?userId=${userId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-blue-700 underline hover:text-blue-900"
                    >
                      Parent home ↗
                    </a>
                  )}
                  <button
                    onClick={() => onRemark(p.id)}
                    disabled={remarking.has(p.id)}
                    className="text-[11px] px-2 py-1 rounded-md bg-slate-800 text-white font-semibold hover:bg-slate-900 disabled:opacity-50"
                  >
                    {remarking.has(p.id) ? "Re-marking…" : "Re-mark"}
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
