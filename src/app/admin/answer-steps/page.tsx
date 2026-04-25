"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import AdminNav from "@/components/AdminNav";

type PreviewItem = {
  id: string;
  questionNum: string;
  paperTitle: string;
  stem: string;
  existingAnswer: string;
  diagramImageData: string | null;
  // AI fields — present when no error
  stepByStep?: string;
  finalAnswer?: string;
  matchesKey?: boolean;
  mismatchReason?: string;
  error?: string;
};

type Counts = { pending: number; processed: number; flagged: number };

export default function AnswerStepsPage() {
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
  const [counts, setCounts] = useState<Counts | null>(null);
  const [items, setItems] = useState<PreviewItem[]>([]);
  const [running, setRunning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Skip set: questions already shown so the next preview surfaces fresh
  // candidates. Kept in component state — wipes on page refresh, which is
  // fine for this admin tool.
  const [skipIds, setSkipIds] = useState<string[]>([]);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`).then(r => setAllowed(r.ok)).catch(() => setAllowed(false));
  }, [userId]);

  const loadCounts = useCallback(async () => {
    const res = await fetch("/api/admin/answer-steps");
    if (res.ok) setCounts(await res.json());
  }, []);
  useEffect(() => { if (allowed) loadCounts(); }, [allowed, loadCounts]);

  const fetchPreview = useCallback(async (limit: number) => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/answer-steps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "preview", limit, excludeIds: skipIds }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Preview failed");
        return;
      }
      setItems(data.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setRunning(false);
    }
  }, [skipIds]);

  const apply = useCallback(async () => {
    if (items.length === 0) return;
    setApplying(true);
    setError(null);
    try {
      const ready = items.filter(it => !it.error && it.stepByStep && it.finalAnswer !== undefined);
      const res = await fetch("/api/admin/answer-steps", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "apply",
          items: ready.map(it => ({
            id: it.id,
            stepByStep: it.stepByStep,
            finalAnswer: it.finalAnswer,
            matchesKey: it.matchesKey,
            mismatchReason: it.mismatchReason ?? "",
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Apply failed");
        return;
      }
      // Push the just-applied IDs into the skip set so the next preview
      // doesn't show the same questions again (some go to flagged, some to
      // processed — both should be excluded next round).
      setSkipIds(prev => [...prev, ...ready.map(it => it.id)]);
      setItems([]);
      await loadCounts();
      alert(`Applied: ${data.updated} updated, ${data.flagged} flagged for review.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Apply failed");
    } finally {
      setApplying(false);
    }
  }, [items, loadCounts]);

  if (allowed === null) return <div className="p-8 text-sm text-[#43474f]">Checking access…</div>;
  if (!allowed) return <div className="p-8 text-sm text-[#ba1a1a]">Admin access required.</div>;

  return (
    <div className="min-h-screen bg-[#f7f8fb]">
      <AdminNav userId={userId} />
      <main className="max-w-6xl mx-auto p-4 lg:p-6">
        <h1 className="text-xl font-extrabold text-[#001e40] mb-1">Generate Answer Steps</h1>
        <p className="text-sm text-[#43474f] mb-4">
          P4–P6 Math questions at difficulty 4 or 5. AI rewrites the answer key as concise step-by-step working.
          If the AI&apos;s final answer disagrees with the existing key, the question is flagged for your review and the original key is kept.
        </p>

        {counts && (
          <div className="flex gap-3 mb-4 flex-wrap">
            <span className="px-3 py-1 rounded-lg bg-white border border-slate-200 text-sm">
              <strong>{counts.pending}</strong> pending
            </span>
            <span className="px-3 py-1 rounded-lg bg-emerald-50 border border-emerald-200 text-sm">
              <strong>{counts.processed}</strong> processed
            </span>
            <span className="px-3 py-1 rounded-lg bg-rose-50 border border-rose-200 text-sm">
              <strong>{counts.flagged}</strong> flagged
            </span>
          </div>
        )}

        <div className="flex gap-2 mb-4 flex-wrap">
          <button
            onClick={() => fetchPreview(10)}
            disabled={running || applying}
            className="px-4 py-2 rounded-lg bg-[#001e40] text-white text-sm font-bold hover:bg-[#003366] disabled:opacity-50"
          >
            {running ? "Generating…" : items.length === 0 ? "Preview 10" : "Preview next 10"}
          </button>
          {items.length > 0 && (
            <button
              onClick={apply}
              disabled={running || applying}
              className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:opacity-50"
            >
              {applying ? "Applying…" : `Apply this batch (${items.filter(it => !it.error).length})`}
            </button>
          )}
        </div>

        {error && <div className="mb-4 p-3 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-700">{error}</div>}

        <div className="space-y-4">
          {items.map(it => (
            <div key={it.id} className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div>
                  <p className="text-xs text-[#737780]">{it.paperTitle}</p>
                  <p className="text-sm font-bold text-[#001e40]">Q{it.questionNum}</p>
                </div>
                {it.error ? (
                  <span className="text-xs px-2 py-1 rounded bg-rose-100 text-rose-700">{it.error}</span>
                ) : it.matchesKey ? (
                  <span className="text-xs px-2 py-1 rounded bg-emerald-100 text-emerald-700">Match → will save</span>
                ) : (
                  <span className="text-xs px-2 py-1 rounded bg-amber-100 text-amber-700">Mismatch → will flag</span>
                )}
              </div>

              <p className="text-sm text-[#0b1c30] whitespace-pre-wrap mb-2">{it.stem}</p>
              {it.diagramImageData && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={it.diagramImageData.startsWith("data:") ? it.diagramImageData : `data:image/jpeg;base64,${it.diagramImageData}`}
                  alt={`Q${it.questionNum} diagram`}
                  className="max-w-xs rounded border border-slate-100 mb-3"
                />
              )}

              <div className="grid md:grid-cols-2 gap-3 mt-2">
                <div>
                  <p className="text-[10px] uppercase tracking-wider font-bold text-[#737780] mb-1">Existing answer key</p>
                  <pre className="text-xs whitespace-pre-wrap bg-slate-50 rounded p-2 border border-slate-200">{it.existingAnswer || "(blank)"}</pre>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider font-bold text-[#737780] mb-1">
                    AI step-by-step {it.finalAnswer && <span className="font-normal">→ <strong>{it.finalAnswer}</strong></span>}
                  </p>
                  {it.stepByStep ? (
                    <pre className="text-xs whitespace-pre-wrap bg-emerald-50 rounded p-2 border border-emerald-200">{it.stepByStep}</pre>
                  ) : (
                    <p className="text-xs italic text-[#737780]">no output</p>
                  )}
                  {it.mismatchReason && (
                    <p className="text-xs text-amber-700 mt-1">{it.mismatchReason}</p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
