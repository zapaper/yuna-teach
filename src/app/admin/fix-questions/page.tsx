"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import AdminNav from "@/components/AdminNav";

type BrokenQ = {
  id: string;
  questionNum: string;
  paperId: string;
  paperTitle: string;
  subject: string | null;
  stem: string | null;
  answer: string | null;
  options: string[] | null;
  imageData: string;
  topic: string | null;
  reasons: string[];
};

export default function FixQuestionsPage() {
  return (
    <Suspense>
      <FixQuestionsContent />
    </Suspense>
  );
}

function FixQuestionsContent() {
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [items, setItems] = useState<BrokenQ[]>([]);
  const [loading, setLoading] = useState(false);
  const [idx, setIdx] = useState(0);

  const [stem, setStem] = useState("");
  const [answer, setAnswer] = useState("");
  const [options, setOptions] = useState<string[]>(["", "", "", ""]);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`).then(r => setAllowed(r.ok)).catch(() => setAllowed(false));
  }, [userId]);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/broken-questions");
      const data = await res.json();
      setItems(data.items ?? []);
      setIdx(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (allowed) loadList(); }, [allowed, loadList]);

  // Hydrate editable fields when current item changes
  useEffect(() => {
    const q = items[idx];
    if (!q) return;
    setStem(q.stem ?? "");
    setAnswer(q.answer ?? "");
    setOptions(Array.isArray(q.options) && q.options.length === 4 ? q.options : ["", "", "", ""]);
  }, [idx, items]);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  }

  const current = items[idx];

  async function save(opts: { advance: boolean; removeFromList: boolean }) {
    if (!current) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      if (stem !== (current.stem ?? "")) body.transcribedStem = stem.trim() || null;
      if (answer !== (current.answer ?? "")) body.answer = answer.trim() || null;
      const hasAnyOpt = options.some(o => o.trim().length > 0);
      const cleanOpts = options.map(o => o.trim());
      const origOpts = Array.isArray(current.options) ? current.options : null;
      if (hasAnyOpt && JSON.stringify(cleanOpts) !== JSON.stringify(origOpts)) {
        body.transcribedOptions = cleanOpts;
      }
      if (Object.keys(body).length === 0) {
        flash("Nothing changed");
        if (opts.advance) setIdx(i => Math.min(items.length - 1, i + 1));
        return;
      }
      const res = await fetch(`/api/exam/questions/${current.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) { flash("Save failed"); return; }
      flash("Saved");
      if (opts.removeFromList) {
        setItems(prev => {
          const next = prev.filter((_, i) => i !== idx);
          return next;
        });
        setIdx(i => Math.min(Math.max(0, items.length - 2), i));
      } else if (opts.advance) {
        setIdx(i => Math.min(items.length - 1, i + 1));
      }
    } finally {
      setSaving(false);
    }
  }

  if (allowed === null) return <div className="min-h-screen flex items-center justify-center bg-slate-50"><div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" /></div>;
  if (!allowed) return <div className="min-h-screen flex items-center justify-center bg-slate-50"><p className="text-slate-500 text-sm">Access denied.</p></div>;

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24">
        <div className="bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between">
          <div>
            <Link href={`/admin?userId=${userId}`} className="text-xs text-slate-400 hover:text-slate-600">← Admin</Link>
            <h1 className="text-lg font-bold text-slate-800">Fix Broken Questions</h1>
            <p className="text-xs text-slate-400">Questions with missing stem / answer / source sentence</p>
          </div>
          <button onClick={loadList} disabled={loading}
            className="px-3 py-1.5 rounded-lg bg-slate-800 text-white text-xs font-bold disabled:opacity-50">
            {loading ? "Scanning…" : "Rescan"}
          </button>
        </div>

        {loading && <div className="p-8 text-center text-sm text-slate-400">Scanning…</div>}

        {!loading && items.length === 0 && (
          <div className="p-8 text-center text-sm text-slate-400">🎉 No broken questions.</div>
        )}

        {!loading && current && (
          <div className="max-w-3xl mx-auto px-4 py-5 space-y-4">
            {/* Navigation */}
            <div className="flex items-center justify-between">
              <button onClick={() => setIdx(i => Math.max(0, i - 1))} disabled={idx === 0}
                className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-bold text-slate-600 disabled:opacity-30">
                ← Prev
              </button>
              <p className="text-xs text-slate-500 font-bold">{idx + 1} of {items.length}</p>
              <button onClick={() => setIdx(i => Math.min(items.length - 1, i + 1))} disabled={idx >= items.length - 1}
                className="px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-bold text-slate-600 disabled:opacity-30">
                Next →
              </button>
            </div>

            <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-slate-500">{current.subject} · {current.paperTitle}</p>
                  <p className="text-base font-bold text-slate-800">Q{current.questionNum}{current.topic ? ` · ${current.topic}` : ""}</p>
                </div>
                <a href={`/exam/${current.paperId}/transcribe-edit?userId=${userId}`} target="_blank" rel="noopener"
                  className="text-[10px] font-bold uppercase tracking-wider text-blue-600 hover:underline shrink-0">Open paper ↗</a>
              </div>
              <div className="flex gap-1.5 flex-wrap">
                {current.reasons.map(r => (
                  <span key={r} className="text-[10px] font-bold px-2 py-0.5 rounded bg-red-50 text-red-700 uppercase tracking-wider">{r.replace(/_/g, " ")}</span>
                ))}
              </div>

              {current.imageData && current.imageData.length > 100 && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={current.imageData.startsWith("data:") ? current.imageData : `data:image/jpeg;base64,${current.imageData}`}
                  alt="question" className="w-full rounded-lg border border-slate-200" />
              )}

              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block mb-1">Stem</label>
                <textarea value={stem} onChange={e => setStem(e.target.value)} rows={4}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-800 focus:border-slate-500 outline-none resize-y" />
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block mb-1">Answer</label>
                <input value={answer} onChange={e => setAnswer(e.target.value)}
                  placeholder={`e.g. "2" for MCQ, or full worked answer for OEQ`}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-800 focus:border-slate-500 outline-none" />
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-500 block mb-1">MCQ options (leave blank for non-MCQ)</label>
                <div className="space-y-1.5">
                  {options.map((o, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="w-6 text-xs text-slate-500 font-bold">({i + 1})</span>
                      <input value={o} onChange={e => setOptions(prev => prev.map((x, j) => j === i ? e.target.value : x))}
                        className="flex-1 border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm focus:border-slate-500 outline-none" />
                    </div>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-2">
                <button onClick={() => save({ advance: false, removeFromList: false })} disabled={saving}
                  className="py-2.5 rounded-xl bg-green-600 text-white text-sm font-bold disabled:opacity-50">
                  {saving ? "Saving…" : "Save"}
                </button>
                <button onClick={() => save({ advance: true, removeFromList: true })} disabled={saving}
                  className="py-2.5 rounded-xl bg-slate-800 text-white text-sm font-bold disabled:opacity-50">
                  Save & Next →
                </button>
              </div>
              <button onClick={() => setIdx(i => Math.min(items.length - 1, i + 1))}
                className="w-full py-2 rounded-xl border border-slate-200 text-slate-500 text-xs font-medium">
                Skip (don&apos;t save)
              </button>
            </div>
          </div>
        )}

        {toast && (
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-slate-800 text-white text-sm px-4 py-2 rounded-xl shadow-lg z-50">{toast}</div>
        )}
      </div>
    </div>
  );
}
