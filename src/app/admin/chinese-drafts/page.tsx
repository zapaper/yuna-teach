"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";

export default function Page() {
  return (
    <Suspense>
      <ChineseDraftsPage />
    </Suspense>
  );
}

type Draft = {
  id: string;
  seedWord: string;
  seedMeaning: string | null;
  shape: "Q5-Q6" | "Q7-Q8" | "Q9-Q10";
  stem: string;
  options: string[];
  correctAnswer: number;
  explanation: string;
  syllabusTopic: string;
  subTopic: string | null;
  priority: number;
  status: "pending" | "kept" | "dropped";
};

const PRIORITY_LABEL: Record<number, string> = {
  0: "PSLE correct-ans 🏆",
  1: "PSLE distractor / target",
  2: "P5/P6 candidate (top)",
  3: "P5/P6 candidate",
};

const SHAPE_LABEL: Record<string, string> = {
  "Q5-Q6": "Q5-Q6 词语",
  "Q7-Q8": "Q7-Q8 词语解释",
  "Q9-Q10": "Q9-Q10 关联词",
};

function ChineseDraftsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [filterShape, setFilterShape] = useState<string>("");
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/chinese-drafts?status=pending");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { drafts: Draft[]; counts: Record<string, number> };
      setDrafts(data.drafts);
      setCounts(data.counts);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  async function act(id: string, action: "keep" | "drop") {
    setWorking(id);
    setError(null);
    try {
      const res = await fetch("/api/admin/chinese-drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, action }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      // Remove from list optimistically.
      setDrafts(prev => prev.filter(d => d.id !== id));
      // Update counts locally
      setCounts(prev => ({
        ...prev,
        pending: Math.max(0, (prev.pending ?? 0) - 1),
        [action === "keep" ? "kept" : "dropped"]: (prev[action === "keep" ? "kept" : "dropped"] ?? 0) + 1,
      }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setWorking(null);
    }
  }

  const visible = filterShape ? drafts.filter(d => d.shape === filterShape) : drafts;

  return (
    <div className="min-h-screen bg-slate-50 pb-12">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex flex-wrap items-center gap-3">
          <button
            onClick={() => router.push(userId ? `/admin?userId=${userId}` : "/admin")}
            className="text-xs text-slate-500 hover:text-slate-900"
          >
            ← Admin
          </button>
          <h1 className="text-lg font-bold text-slate-900">Chinese MCQ drafts</h1>
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-xs text-slate-500">Pending: {counts.pending ?? 0}</span>
            <span className="text-xs text-emerald-700">Kept: {counts.kept ?? 0}</span>
            <span className="text-xs text-rose-600">Dropped: {counts.dropped ?? 0}</span>
          </div>
        </div>
        <div className="max-w-5xl mx-auto px-4 pb-3 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-slate-500">Filter:</span>
          {["", "Q5-Q6", "Q7-Q8", "Q9-Q10"].map(s => (
            <button
              key={s || "all"}
              onClick={() => setFilterShape(s)}
              className={`text-xs px-2.5 py-1 rounded-full border ${
                filterShape === s ? "bg-slate-900 text-white border-slate-900" : "bg-white border-slate-200 text-slate-600 hover:bg-slate-100"
              }`}
            >
              {s || "All"}{s && ` (${drafts.filter(d => d.shape === s).length})`}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <div className="max-w-5xl mx-auto mt-3 mx-4 bg-rose-50 border border-rose-200 text-rose-800 text-sm px-3 py-2 rounded-lg">
          {error}
        </div>
      )}

      <div className="max-w-5xl mx-auto px-4 mt-4 space-y-4">
        {loading && <p className="text-sm text-slate-500">Loading…</p>}
        {!loading && visible.length === 0 && (
          <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-slate-500">
            🎉 No pending drafts. {counts.kept ?? 0} kept, {counts.dropped ?? 0} dropped.
          </div>
        )}
        {visible.map(d => (
          <div key={d.id} className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
            <div className="px-4 py-2 border-b border-slate-100 flex items-center gap-2 text-xs">
              <span className="font-bold text-slate-900">{d.seedWord}</span>
              {d.seedMeaning && <span className="text-slate-500">— {d.seedMeaning}</span>}
              <span className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                {SHAPE_LABEL[d.shape] ?? d.shape}
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">
                {PRIORITY_LABEL[d.priority] ?? `prio ${d.priority}`}
              </span>
            </div>
            <div className="px-4 py-3">
              <p className="text-base text-slate-800 whitespace-pre-wrap">{d.stem}</p>
              <ul className="mt-3 space-y-1.5">
                {d.options.map((opt, i) => {
                  const isCorrect = i + 1 === d.correctAnswer;
                  return (
                    <li
                      key={i}
                      className={`text-sm px-3 py-2 rounded-lg border flex items-center gap-2 ${
                        isCorrect ? "border-emerald-300 bg-emerald-50 text-emerald-900 font-semibold" : "border-slate-200 text-slate-700"
                      }`}
                    >
                      <span className={`w-5 h-5 rounded-full text-[10px] font-bold inline-flex items-center justify-center shrink-0 ${
                        isCorrect ? "bg-emerald-500 text-white" : "bg-slate-100 text-slate-500"
                      }`}>{i + 1}</span>
                      <span>{opt}</span>
                      {isCorrect && <span className="ml-auto text-emerald-600 text-xs">✓ correct</span>}
                    </li>
                  );
                })}
              </ul>
              {d.explanation && (
                <p className="mt-3 text-xs text-slate-600 italic">解析: {d.explanation}</p>
              )}
            </div>
            <div className="px-4 py-2 border-t border-slate-100 flex items-center justify-end gap-2">
              <button
                disabled={working === d.id}
                onClick={() => act(d.id, "drop")}
                className="text-xs font-medium px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-rose-50 hover:border-rose-200 hover:text-rose-700 disabled:opacity-50"
              >
                ✗ Drop
              </button>
              <button
                disabled={working === d.id}
                onClick={() => act(d.id, "keep")}
                className="text-xs font-bold px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {working === d.id ? "Saving…" : "✓ Keep → bank"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
