"use client";

// Admin review panel for retiring questions on topics MOE removed
// from the 2025/2026 PSLE syllabus (Cells / Speed / Compass).
// Three tabs, one per topic. Each row is a candidate question with
// "Approve" (re-tag to the legacy topic + remove from quiz pool)
// or "Skip" (don't ask again for this question + topic). Detection
// runs server-side on every page load so regex refinements pick up
// without a deploy step.

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import AdminNav from "@/components/AdminNav";

type LegacyTopic = "Cells" | "Speed" | "Compass";
const TOPICS: LegacyTopic[] = ["Cells", "Speed", "Compass"];

type Candidate = {
  questionId: string;
  questionNum: string;
  paperId: string;
  paperTitle: string;
  paperLevel: string | null;
  currentTopic: string | null;
  stemSnippet: string;
};
type Data = Record<LegacyTopic, Candidate[]>;

export default function LegacyTopicsPage() {
  return (
    <Suspense>
      <Body />
    </Suspense>
  );
}

function Body() {
  const sp = useSearchParams();
  const userId = sp.get("userId") ?? "";
  const [data, setData] = useState<Data | null>(null);
  const [activeTab, setActiveTab] = useState<LegacyTopic>("Cells");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/legacy-topics");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json() as { candidates: Data };
      setData(j.candidates);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const decide = useCallback(async (questionId: string, decision: "approve" | "skip", topic: LegacyTopic) => {
    setPendingId(questionId);
    try {
      const res = await fetch("/api/admin/legacy-topics", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId, decision, topic }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        alert(`Failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
        return;
      }
      // Optimistic: drop the row from the current tab's list.
      setData(prev => prev ? { ...prev, [topic]: prev[topic].filter(c => c.questionId !== questionId) } : prev);
    } finally {
      setPendingId(null);
    }
  }, []);

  const counts = TOPICS.reduce<Record<LegacyTopic, number>>((acc, t) => {
    acc[t] = data?.[t]?.length ?? 0;
    return acc;
  }, { Cells: 0, Speed: 0, Compass: 0 });

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="max-w-5xl mx-auto px-6 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900 mb-1">Legacy PSLE topics review</h1>
          <p className="text-sm text-slate-600 leading-relaxed">
            Approve to re-tag a question to one of the legacy topics ({TOPICS.join(", ")}). Once tagged, the
            question is excluded from daily-quiz and focused-practice pools, but it still appears in full-paper
            assignments. Skip if it's a false positive — that question won't reappear for this topic.
          </p>
          {err && <p className="text-sm text-red-600 mt-2">Error: {err}</p>}
        </header>

        <div className="flex gap-2 mb-4">
          {TOPICS.map(t => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-colors ${
                activeTab === t
                  ? "bg-slate-900 text-white"
                  : "bg-white text-slate-700 hover:bg-slate-100 border border-slate-200"
              }`}
            >
              {t} <span className="ml-1 text-xs opacity-75">({counts[t]})</span>
            </button>
          ))}
          <button
            onClick={load}
            disabled={loading}
            className="ml-auto px-3 py-2 rounded-lg text-sm font-medium text-slate-600 hover:bg-white border border-slate-200 disabled:opacity-50"
            title="Re-run the detection sweep"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>

        {loading && !data && (
          <div className="text-center py-12 text-slate-500">Loading candidates…</div>
        )}

        {data && data[activeTab].length === 0 && !loading && (
          <div className="text-center py-12 text-slate-500">
            No outstanding candidates for {activeTab}.
          </div>
        )}

        {data && data[activeTab].length > 0 && (
          <div className="space-y-2">
            {data[activeTab].map(c => (
              <div key={c.questionId} className="bg-white border border-slate-200 rounded-lg p-4 flex gap-4 items-start">
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2 mb-1 flex-wrap">
                    <span className="text-xs font-bold text-slate-500">Q{c.questionNum}</span>
                    <span className="text-xs text-slate-400">·</span>
                    <span className="text-xs font-medium text-slate-700">{c.paperLevel ?? "?"}</span>
                    <span className="text-xs text-slate-400">·</span>
                    <span className="text-xs text-slate-600 truncate" title={c.paperTitle}>{c.paperTitle}</span>
                    <span className="text-xs text-slate-400">·</span>
                    <span className="text-xs text-violet-700 font-medium">current: {c.currentTopic ?? "(none)"}</span>
                  </div>
                  <p className="text-sm text-slate-800 leading-relaxed">{c.stemSnippet}{c.stemSnippet.length >= 220 ? "…" : ""}</p>
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  <button
                    onClick={() => decide(c.questionId, "approve", activeTab)}
                    disabled={pendingId === c.questionId}
                    className="px-3 py-1.5 rounded-md text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 whitespace-nowrap"
                    title={`Re-tag this question's syllabusTopic to ${activeTab}`}
                  >
                    Approve → {activeTab}
                  </button>
                  <button
                    onClick={() => decide(c.questionId, "skip", activeTab)}
                    disabled={pendingId === c.questionId}
                    className="px-3 py-1.5 rounded-md text-xs font-medium text-slate-600 hover:bg-slate-100 border border-slate-200 disabled:opacity-50 whitespace-nowrap"
                    title="False positive — don't show this question again for this topic"
                  >
                    Skip
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
