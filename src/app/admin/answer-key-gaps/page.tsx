"use client";

import { Fragment, Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import AdminNav from "@/components/AdminNav";

// Unified review for clean-extract Math/Science OEQs with sub-parts
// that are missing per-part marks AND/OR per-part answer keys.
// First batch of 10 with AI proposals shown side-by-side. After
// the admin reviews and applies, "Load next 10" loads more.
//
// Per row the page shows:
//   - Question stem + sub-parts (with current text incl. any [N])
//   - Marks gap: AI's proposed [N] per part with the option to
//     edit before applying.
//   - Answer gap: AI's proposed labelled answer block, editable
//     in a textarea before applying.
//   - Apply, Skip, or open paper editor.

type Subpart = { label: string; text: string };
type GapItem = {
  id: string;
  questionNum: string;
  paperId: string;
  paperTitle: string;
  level: number | null;
  subject: string | null;
  stem: string;
  subparts: Subpart[];
  currentAnswer: string;
  currentMarks: Record<string, number>;
  currentMarksAvailable: number | null;
  hasDiagram: boolean;
  hasAnswerImage: boolean;
  marksGap: boolean;
  answerGap: boolean;
  proposedMarks: Record<string, number>;
  proposedAnswer: string;
  aiError: string | null;
};

export default function AnswerKeyGapsPage() {
  return (
    <Suspense>
      <Content />
    </Suspense>
  );
}

function Content() {
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";
  const [items, setItems] = useState<GapItem[]>([]);
  const [scanned, setScanned] = useState(0);
  const [excludeIds, setExcludeIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subjectFilter, setSubjectFilter] = useState<"math" | "science" | "all">("math");
  // Per-row edits — keyed by question id. answer is the textarea
  // value, marks is { label: number }.
  const [editAnswer, setEditAnswer] = useState<Record<string, string>>({});
  const [editMarks, setEditMarks] = useState<Record<string, Record<string, number>>>({});
  const [saving, setSaving] = useState<Set<string>>(new Set());
  // Lightbox state — admin clicks a thumbnail to view the image
  // full-screen for closer inspection of question / answer.
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  // Per-row "regenerating" state for the re-run AI button.
  const [regenerating, setRegenerating] = useState<Set<string>>(new Set());

  async function regenerate(id: string) {
    setError(null);
    setRegenerating((s) => new Set(s).add(id));
    try {
      const r = await fetch("/api/admin/answer-key-gaps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "regenerate", id }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        setError(data.error ?? "Re-run failed");
        return;
      }
      const data = (await r.json()) as { proposedAnswer?: string };
      if (data.proposedAnswer) {
        setEditAnswer((prev) => ({ ...prev, [id]: data.proposedAnswer ?? "" }));
      }
    } finally {
      setRegenerating((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  async function scan(reset = false) {
    setLoading(true);
    setError(null);
    try {
      const ids = reset ? [] : excludeIds;
      const url = `/api/admin/answer-key-gaps?limit=10&subject=${subjectFilter}${ids.length > 0 ? `&excludeIds=${ids.join(",")}` : ""}`;
      const r = await fetch(url);
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        setError(data.error ?? `Scan failed (${r.status})`);
        return;
      }
      const data = (await r.json()) as { items: GapItem[]; scanned: number };
      // Seed per-row edit state from AI proposals
      const seedAnswer: Record<string, string> = {};
      const seedMarks: Record<string, Record<string, number>> = {};
      for (const it of data.items) {
        seedAnswer[it.id] = it.proposedAnswer || it.currentAnswer;
        seedMarks[it.id] = { ...it.proposedMarks };
      }
      if (reset) {
        setItems(data.items);
        setExcludeIds(data.items.map((it) => it.id));
        setEditAnswer(seedAnswer);
        setEditMarks(seedMarks);
      } else {
        setItems((prev) => [...prev, ...data.items]);
        setExcludeIds((prev) => [...prev, ...data.items.map((it) => it.id)]);
        setEditAnswer((prev) => ({ ...prev, ...seedAnswer }));
        setEditMarks((prev) => ({ ...prev, ...seedMarks }));
      }
      setScanned(data.scanned);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    scan(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function apply(id: string, action: "save" | "skip") {
    setSaving((s) => new Set(s).add(id));
    try {
      if (action === "save") {
        const r = await fetch("/api/admin/answer-key-gaps", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "apply",
            id,
            newAnswer: editAnswer[id],
            subpartMarks: editMarks[id],
          }),
        });
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          setError(data.error ?? "Save failed");
          return;
        }
      }
      setItems((prev) => prev.filter((it) => it.id !== id));
    } finally {
      setSaving((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  // Batch-apply every surfaced item. Skips rows where the proposed
  // answer is empty (AI couldn't solve), letting the admin handle
  // those manually after the batch.
  async function applyAll() {
    setError(null);
    const toApply = items.filter((it) => (editAnswer[it.id] ?? "").trim().length > 0);
    setSaving(new Set(toApply.map((it) => it.id)));
    try {
      // Sequential to keep DB writes ordered + show progress in the
      // UI as items disappear one by one. 10 rows = ~3 s total.
      for (const it of toApply) {
        const r = await fetch("/api/admin/answer-key-gaps", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "apply",
            id: it.id,
            newAnswer: editAnswer[it.id],
            subpartMarks: editMarks[it.id],
          }),
        });
        if (!r.ok) {
          const data = await r.json().catch(() => ({}));
          setError(`Stopped at Q${it.questionNum}: ${data.error ?? "save failed"}`);
          break;
        }
        setItems((prev) => prev.filter((x) => x.id !== it.id));
      }
    } finally {
      setSaving(new Set());
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24 lg:pb-0">
        <div className="bg-white border-b border-slate-200 px-4 py-3">
          <h1 className="text-lg font-bold text-slate-800">Fix OEQ sub-part keys</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Clean-extract Math/Science OEQs with sub-parts missing per-part marks or per-part answer keys.
            AI proposes both fixes; review + apply.
          </p>
        </div>

        <div className="p-4 max-w-4xl">
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <button
              onClick={() => scan(false)}
              disabled={loading}
              className="px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-bold hover:bg-rose-700 disabled:opacity-50"
            >
              {loading ? "Scanning…" : items.length === 0 ? "Scan first 10" : "Load next 10"}
            </button>
            <button
              onClick={() => { setItems([]); setExcludeIds([]); setEditAnswer({}); setEditMarks({}); scan(true); }}
              disabled={loading}
              className="px-3 py-2 rounded-lg bg-white border border-slate-300 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              Reset scan
            </button>
            {items.length > 0 && (
              <button
                onClick={applyAll}
                disabled={loading || saving.size > 0}
                className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:opacity-50"
              >
                {saving.size > 0 ? `Applying ${saving.size}…` : `Apply all ${items.length}`}
              </button>
            )}
            <div className="flex items-center gap-1 bg-white rounded-lg border border-slate-200 p-1">
              {(["math", "science", "all"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => { setSubjectFilter(s); setItems([]); setExcludeIds([]); setEditAnswer({}); setEditMarks({}); }}
                  className={`px-3 py-1 rounded text-xs font-bold transition-colors ${
                    subjectFilter === s ? "bg-rose-600 text-white" : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
            <span className="text-xs text-slate-500 ml-2">
              {items.length} surfaced · {scanned} scanned in last batch
            </span>
          </div>

          {error && (
            <div className="mb-4 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2 text-sm text-rose-700">
              {error}
            </div>
          )}

          {!loading && items.length === 0 && (
            <p className="text-sm text-slate-500 py-8 text-center">
              No gaps surfaced. {excludeIds.length > 0 ? "All scanned candidates resolved or excluded." : "Try Scan again."}
            </p>
          )}

          <div className="space-y-4">
            {items.map((it) => {
              const labels = it.subparts.map((s) => s.label);
              const proposedMarksTotal = Object.values(editMarks[it.id] ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
              const totalMatchesAvailable = it.currentMarksAvailable !== null && proposedMarksTotal === it.currentMarksAvailable;
              return (
                <div key={it.id} className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
                  <div className="flex items-start justify-between mb-2 gap-3 flex-wrap">
                    <div className="text-xs text-slate-500 min-w-0">
                      <span className="font-bold text-slate-700">Q{it.questionNum}</span>
                      {" · "}
                      <span>{it.paperTitle}</span>
                      {it.level && <span> · P{it.level}</span>}
                      {it.subject && <span> · {it.subject}</span>}
                      {it.currentMarksAvailable !== null && (
                        <span> · total {it.currentMarksAvailable} marks</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {it.marksGap && (
                        <span className="text-[10px] font-extrabold uppercase tracking-widest bg-amber-100 text-amber-700 rounded-full px-2 py-0.5">
                          marks gap
                        </span>
                      )}
                      {it.answerGap && (
                        <span className="text-[10px] font-extrabold uppercase tracking-widest bg-rose-100 text-rose-700 rounded-full px-2 py-0.5">
                          key gap
                        </span>
                      )}
                      {it.hasDiagram && (
                        <span className="text-[10px] font-extrabold uppercase tracking-widest bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">
                          diagram
                        </span>
                      )}
                      {it.hasAnswerImage && (
                        <span className="text-[10px] font-extrabold uppercase tracking-widest bg-emerald-100 text-emerald-700 rounded-full px-2 py-0.5">
                          answer image
                        </span>
                      )}
                    </div>
                  </div>

                  {it.stem && (
                    <p className="text-sm text-slate-800 mb-2 whitespace-pre-wrap">{it.stem}</p>
                  )}

                  <div className="bg-slate-50 rounded-lg p-3 mb-3 text-xs space-y-2">
                    <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-1.5 items-center">
                      <div className="text-[10px] font-extrabold uppercase tracking-widest text-slate-500">Sub-part</div>
                      <div className="text-[10px] font-extrabold uppercase tracking-widest text-slate-500 text-center w-16">Before</div>
                      <div className="text-[10px] font-extrabold uppercase tracking-widest text-rose-600 text-center w-16">After</div>
                      {it.subparts.map((s) => {
                        const before = it.currentMarks[s.label];
                        const after = editMarks[it.id]?.[s.label];
                        return (
                          <Fragment key={s.label}>
                            <div className="flex items-start gap-2 min-w-0">
                              <span className="font-bold text-slate-700 shrink-0">({s.label})</span>
                              <span className="text-slate-600 truncate" title={s.text}>{s.text}</span>
                            </div>
                            <div className="text-center text-xs text-slate-500 w-16">
                              {before !== undefined ? (
                                <span className="px-2 py-0.5 rounded bg-slate-200 text-slate-700">[{before}]</span>
                              ) : (
                                <span className="text-slate-400">—</span>
                              )}
                            </div>
                            <input
                              type="number"
                              min={0}
                              max={20}
                              value={after ?? ""}
                              onChange={(e) => {
                                const v = parseInt(e.target.value, 10);
                                setEditMarks((prev) => ({
                                  ...prev,
                                  [it.id]: { ...(prev[it.id] ?? {}), [s.label]: Number.isFinite(v) ? v : 0 },
                                }));
                              }}
                              placeholder="?"
                              className={`w-16 px-1.5 py-0.5 text-xs border rounded text-center ${
                                after !== undefined && after !== before
                                  ? "border-rose-400 bg-rose-50 text-rose-700 font-bold"
                                  : "border-slate-300"
                              }`}
                            />
                          </Fragment>
                        );
                      })}
                    </div>
                    <p className={`text-[11px] ${totalMatchesAvailable ? "text-emerald-700" : "text-amber-700"}`}>
                      Proposed sum: {proposedMarksTotal}
                      {it.currentMarksAvailable !== null && ` / ${it.currentMarksAvailable} expected`}
                      {totalMatchesAvailable ? " ✓" : ""}
                    </p>
                  </div>

                  {/* Question + answer images for visual reference.
                      Click to enlarge in a full-screen lightbox. */}
                  <div className="flex gap-2 mb-3 overflow-x-auto">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/exam/question/${it.id}/image`}
                      alt="Question"
                      onClick={() => setLightboxSrc(`/api/exam/question/${it.id}/image`)}
                      className="h-32 rounded border border-slate-200 cursor-zoom-in hover:border-rose-400 transition-colors"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                    {it.hasAnswerImage && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`/api/exam/question/${it.id}/answer-image`}
                        alt="Answer"
                        onClick={() => setLightboxSrc(`/api/exam/question/${it.id}/answer-image`)}
                        className="h-32 rounded border border-emerald-200 cursor-zoom-in hover:border-emerald-400 transition-colors"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                      />
                    )}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-2">
                    <div>
                      <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Before — current answer</span>
                      <pre className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-200 bg-slate-50 text-xs font-mono whitespace-pre-wrap break-words text-slate-600 max-h-48 overflow-y-auto">{it.currentAnswer || "(empty)"}</pre>
                    </div>
                    <label className="block">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[11px] font-bold text-rose-600 uppercase tracking-wider">After — proposed (editable)</span>
                        <button
                          onClick={() => regenerate(it.id)}
                          disabled={regenerating.has(it.id) || saving.has(it.id)}
                          className="flex items-center gap-1 text-[10px] font-bold text-rose-600 hover:text-rose-800 disabled:opacity-50"
                        >
                          <span className="material-symbols-outlined text-xs">refresh</span>
                          {regenerating.has(it.id) ? "Re-running…" : "Re-run AI"}
                        </button>
                      </div>
                      <textarea
                        value={editAnswer[it.id] ?? ""}
                        onChange={(e) => setEditAnswer((prev) => ({ ...prev, [it.id]: e.target.value }))}
                        rows={8}
                        className="w-full px-3 py-2 rounded-lg border border-rose-300 bg-rose-50/30 text-xs font-mono focus:outline-none focus:border-rose-500"
                      />
                    </label>
                  </div>

                  {it.aiError && (
                    <p className="text-xs text-rose-600 mb-2">AI: {it.aiError}</p>
                  )}

                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={() => apply(it.id, "save")}
                      disabled={saving.has(it.id)}
                      className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {saving.has(it.id) ? "Saving…" : "Apply changes"}
                    </button>
                    <button
                      onClick={() => apply(it.id, "skip")}
                      disabled={saving.has(it.id)}
                      className="px-3 py-1.5 rounded-lg bg-white border border-slate-300 text-slate-700 text-xs font-bold hover:bg-slate-100 disabled:opacity-50"
                    >
                      Skip
                    </button>
                    <span className="text-[11px] text-slate-400 ml-2">{labels.length} sub-parts</span>
                    <a
                      href={`/exam/${it.paperId}/edit?userId=${userId}`}
                      target="_blank"
                      rel="noopener"
                      className="ml-auto text-xs text-slate-500 hover:text-slate-700 underline"
                    >
                      Open paper editor →
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Image lightbox — full-screen overlay; click anywhere to close. */}
      {lightboxSrc && (
        <div
          className="fixed inset-0 z-[200] bg-black/90 flex items-center justify-center p-6 cursor-zoom-out"
          onClick={() => setLightboxSrc(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightboxSrc}
            alt="Enlarged"
            className="max-w-full max-h-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={() => setLightboxSrc(null)}
            className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
            aria-label="Close"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
      )}
    </div>
  );
}
