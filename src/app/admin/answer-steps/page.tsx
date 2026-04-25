"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import AdminNav from "@/components/AdminNav";

type Subpart = { label: string; text: string };
type PreviewItem = {
  id: string;
  questionNum: string;
  paperTitle: string;
  stem: string;
  subparts: Subpart[] | null;
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
  // Per-card skip set within the current preview batch — admin can opt-out
  // a specific question and Apply will leave it untouched (and the next
  // preview won't include it again because skipIds carries it forward).
  const [skipNow, setSkipNow] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Skip set: questions already shown so the next preview surfaces fresh
  // candidates. Kept in component state — wipes on page refresh, which is
  // fine for this admin tool.
  const [skipIds, setSkipIds] = useState<string[]>([]);
  // Rows the Revert-MCQ scan couldn't auto-recover — admin needs to fix
  // these manually in the clean editor. Each one carries the AI's final
  // answer so admin can compare without opening the question.
  type RevertSkip = { id: string; questionNum: string; paperTitle: string; cleanEditorUrl: string; aiFinalAnswer: string; reason: string };
  const [revertSkipped, setRevertSkipped] = useState<RevertSkip[]>([]);

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
      setSkipNow(new Set());
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
      // Honour the per-card skip — those rows aren't sent for AI apply, and
      // their IDs go to the API as skippedIds so the server writes a
      // 'skipped' marker. The marker then excludes them from the scope on
      // every future preview (and survives page reloads).
      const ready = items.filter(it => !it.error && it.stepByStep && it.finalAnswer !== undefined && !skipNow.has(it.id));
      const skippedIds = items.filter(it => skipNow.has(it.id)).map(it => it.id);
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
          skippedIds,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Apply failed");
        return;
      }
      // Push applied IDs into the in-memory exclude set as belt-and-braces;
      // skipped IDs are now persisted server-side via the SKIPPED_PREFIX
      // marker so they're excluded from the next scope query regardless of
      // session state.
      setSkipIds(prev => [...prev, ...ready.map(it => it.id), ...skippedIds]);
      setItems([]);
      setSkipNow(new Set());
      await loadCounts();
      const skippedNote = data.skipped > 0 ? ` (${data.skipped} skipped)` : "";
      alert(`Applied: ${data.updated} updated, ${data.flagged} flagged for review${skippedNote}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Apply failed");
    } finally {
      setApplying(false);
    }
  }, [items, skipNow, loadCounts]);

  function toggleSkip(id: string) {
    setSkipNow(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  if (allowed === null) return <div className="p-8 text-sm text-[#43474f]">Checking access…</div>;
  if (!allowed) return <div className="p-8 text-sm text-[#ba1a1a]">Admin access required.</div>;

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24 lg:pb-0">
        <div className="bg-white border-b border-slate-200 px-4 py-3">
          <h1 className="text-lg font-bold text-slate-800">Generate Answer Steps</h1>
          <p className="text-xs text-slate-400">
            P4–P6 Math questions at difficulty 4 or 5. AI rewrites the answer key as concise step-by-step working.
            If the AI&apos;s final answer disagrees with the existing key, the question is flagged for your review and the original key is kept.
          </p>
        </div>

        <main className="max-w-4xl mx-auto px-4 py-6">

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
            onClick={() => fetchPreview(20)}
            disabled={running || applying}
            className="px-4 py-2 rounded-lg bg-[#001e40] text-white text-sm font-bold hover:bg-[#003366] disabled:opacity-50"
          >
            {running ? "Generating…" : items.length === 0 ? "Preview 20" : "Preview next 20"}
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
          <button
            onClick={async () => {
              if (!confirm("Scan all 'Steps:' answers and revert any that were actually MCQ back to their option index? Uses the AI's 'Final answer:' line.")) return;
              const res = await fetch("/api/admin/answer-steps", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action: "revert-mcq" }),
              });
              const data = await res.json();
              setRevertSkipped(data.skippedDetails ?? []);
              await loadCounts();
              alert(`Reverted ${data.reverted} MCQ rows. ${data.skipped > 0 ? `${data.skipped} couldn't be auto-recovered — see list below.` : ""}`);
            }}
            disabled={running || applying}
            className="px-4 py-2 rounded-lg bg-white border border-rose-300 text-rose-700 text-sm font-bold hover:bg-rose-50 disabled:opacity-50"
          >
            Revert MCQ rows
          </button>
        </div>

        {revertSkipped.length > 0 && (
          <div className="mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200">
            <p className="text-sm font-bold text-amber-900 mb-2">
              {revertSkipped.length} MCQ row{revertSkipped.length > 1 ? "s" : ""} couldn&apos;t be auto-recovered — fix manually:
            </p>
            <ul className="space-y-1">
              {revertSkipped.map(s => (
                <li key={s.id} className="text-xs text-amber-900">
                  <a href={s.cleanEditorUrl} target="_blank" rel="noreferrer" className="font-bold underline hover:text-amber-700">
                    Q{s.questionNum} — {s.paperTitle}
                  </a>
                  <span className="ml-2 text-amber-700">
                    AI said: <code className="bg-amber-100 px-1 rounded">{s.aiFinalAnswer || "(no Final answer line)"}</code> — {s.reason}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && <div className="mb-4 p-3 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-700">{error}</div>}

        <div className="space-y-4">
          {items.map(it => {
            const skipped = skipNow.has(it.id);
            return (
            <div key={it.id} className={`bg-white rounded-xl border p-4 ${skipped ? "border-slate-300 opacity-50" : "border-slate-200"}`}>
              <div className="flex items-start justify-between gap-3 mb-2">
                <div>
                  <p className="text-xs text-[#737780]">{it.paperTitle}</p>
                  <p className="text-sm font-bold text-[#001e40]">Q{it.questionNum}</p>
                </div>
                <div className="flex items-center gap-2">
                  {skipped ? (
                    <span className="text-xs px-2 py-1 rounded bg-slate-200 text-slate-600">Skipped</span>
                  ) : it.error ? (
                    <span className="text-xs px-2 py-1 rounded bg-rose-100 text-rose-700">{it.error}</span>
                  ) : it.matchesKey ? (
                    <span className="text-xs px-2 py-1 rounded bg-emerald-100 text-emerald-700">Match → will save</span>
                  ) : (
                    <span className="text-xs px-2 py-1 rounded bg-amber-100 text-amber-700">Mismatch → will flag</span>
                  )}
                  <button
                    onClick={() => toggleSkip(it.id)}
                    className={`text-xs px-2 py-1 rounded border ${skipped ? "bg-white border-slate-300 text-slate-600 hover:bg-slate-50" : "bg-rose-50 border-rose-200 text-rose-700 hover:bg-rose-100"}`}
                  >
                    {skipped ? "Undo skip" : "Don't apply"}
                  </button>
                </div>
              </div>

              <p className="text-sm text-[#0b1c30] whitespace-pre-wrap mb-2">{it.stem}</p>
              {it.subparts && it.subparts.length > 0 && (
                <div className="mb-2 ml-2 space-y-1">
                  {it.subparts.map(sp => (
                    <p key={sp.label} className="text-sm text-[#0b1c30] whitespace-pre-wrap">
                      <span className="font-bold">({sp.label})</span> {sp.text}
                    </p>
                  ))}
                </div>
              )}
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
            );
          })}
        </div>
        </main>
      </div>
    </div>
  );
}
