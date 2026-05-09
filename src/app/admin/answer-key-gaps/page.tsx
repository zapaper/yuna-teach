"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import AdminNav from "@/components/AdminNav";

type Subpart = { label: string; text: string };
type GapItem = {
  id: string;
  questionNum: string;
  paperId: string;
  paperTitle: string;
  level: number | null;
  subject: string | null;
  stem: string;
  subparts: Subpart[] | null;
  answer: string;
  flagged: boolean;
  alreadyMarked: boolean;
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
  // Per-row inline edit state — keyed by question id.
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Set<string>>(new Set());

  async function scan(reset = false) {
    setLoading(true);
    setError(null);
    try {
      const ids = reset ? [] : excludeIds;
      const url = `/api/admin/answer-key-gaps${ids.length > 0 ? `?excludeIds=${ids.join(",")}` : ""}`;
      const r = await fetch(url);
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        setError(data.error ?? `Scan failed (${r.status})`);
        return;
      }
      const data = (await r.json()) as { items: GapItem[]; scanned: number };
      if (reset) {
        setItems(data.items);
        setExcludeIds(data.items.map((it) => it.id));
      } else {
        setItems((prev) => [...prev, ...data.items]);
        setExcludeIds((prev) => [...prev, ...data.items.map((it) => it.id)]);
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

  async function markHandled(id: string, newAnswer?: string) {
    setSaving((s) => new Set(s).add(id));
    try {
      const r = await fetch("/api/admin/answer-key-gaps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark-handled", id, newAnswer }),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        setError(data.error ?? "Save failed");
        return;
      }
      setItems((prev) => prev.filter((it) => it.id !== id));
      setEdits((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } finally {
      setSaving((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24 lg:pb-0">
        <div className="bg-white border-b border-slate-200 px-4 py-3">
          <h1 className="text-lg font-bold text-slate-800">Scan for Unclear Part-Answer Keys</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Master questions whose stored <code>answer</code> doesn&apos;t mention every sub-part label —
            usually a missed shared-block extraction. Edit + save fixes the master in place.
          </p>
        </div>

        <div className="p-4 max-w-4xl">
          <div className="flex items-center gap-3 mb-4">
            <button
              onClick={() => scan(false)}
              disabled={loading}
              className="px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-bold hover:bg-rose-700 disabled:opacity-50"
            >
              {loading ? "Scanning…" : items.length === 0 ? "Scan first 30" : "Load next 30"}
            </button>
            <button
              onClick={() => { setItems([]); setExcludeIds([]); scan(true); }}
              disabled={loading}
              className="px-3 py-2 rounded-lg bg-white border border-slate-300 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              Reset scan
            </button>
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

          <div className="space-y-3">
            {items.map((it) => {
              const labels = (it.subparts ?? []).filter(s => !s.label.startsWith("_")).map(s => s.label.toLowerCase());
              const ans = it.answer.toLowerCase();
              const missing = labels.filter(l => !ans.includes(`(${l})`));
              const editing = edits[it.id] ?? it.answer;
              return (
                <div key={it.id} className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
                  <div className="flex items-start justify-between mb-2 gap-3">
                    <div className="text-xs text-slate-500">
                      <span className="font-bold text-slate-700">Q{it.questionNum}</span>
                      {" · "}
                      <span>{it.paperTitle}</span>
                      {it.level && <span> · P{it.level}</span>}
                      {it.subject && <span> · {it.subject}</span>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-[10px] font-extrabold uppercase tracking-widest bg-rose-100 text-rose-700 rounded-full px-2 py-0.5">
                        Missing: {missing.map(l => `(${l})`).join(", ")}
                      </span>
                    </div>
                  </div>

                  {it.stem && (
                    <p className="text-sm text-slate-800 mb-2 whitespace-pre-wrap">{it.stem}</p>
                  )}
                  <div className="text-xs text-slate-600 mb-3 space-y-0.5">
                    {(it.subparts ?? []).filter(s => !s.label.startsWith("_")).map(s => (
                      <div key={s.label}><strong>({s.label})</strong> {s.text}</div>
                    ))}
                  </div>

                  <label className="block">
                    <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">Answer field</span>
                    <textarea
                      value={editing}
                      onChange={(e) => setEdits(prev => ({ ...prev, [it.id]: e.target.value }))}
                      rows={6}
                      className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 text-sm font-mono focus:outline-none focus:border-rose-500"
                    />
                  </label>

                  <div className="flex items-center gap-2 mt-3">
                    <button
                      onClick={() => markHandled(it.id, edits[it.id] ?? it.answer)}
                      disabled={saving.has(it.id)}
                      className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 disabled:opacity-50"
                    >
                      {saving.has(it.id) ? "Saving…" : "Save & mark handled"}
                    </button>
                    <button
                      onClick={() => markHandled(it.id /* no answer change */)}
                      disabled={saving.has(it.id)}
                      className="px-3 py-1.5 rounded-lg bg-white border border-slate-300 text-slate-700 text-xs font-bold hover:bg-slate-100 disabled:opacity-50"
                      title="Clear the [solve on demand] flag without changing the answer"
                    >
                      Mark handled (no edit)
                    </button>
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
    </div>
  );
}
