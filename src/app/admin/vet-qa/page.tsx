"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import AdminNav from "@/components/AdminNav";

export default function VetQAWrapper() {
  return <Suspense fallback={<div className="min-h-screen flex items-center justify-center bg-slate-50"><div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" /></div>}><VetQAPage /></Suspense>;
}

type SubpartEntry = { label: string; text: string; diagramBase64?: string | null };
type FlaggedItem = {
  questionId: string;
  paperId: string;
  paperTitle: string;
  subject: string;
  questionNum: string;
  syllabusTopic: string | null;
  transcribedStem: string | null;
  transcribedOptions: unknown;
  transcribedSubparts: SubpartEntry[] | null;
  answer: string | null;
  imageData: string | null;
  diagramImageData: string | null;
  marksAvailable: number | null;
  reason: string;
};

function VetQAPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";

  const [items, setItems] = useState<FlaggedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [idx, setIdx] = useState(0);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "math" | "science" | "english">("all");

  // Editable fields for current item
  const [stem, setStem] = useState("");
  const [answer, setAnswer] = useState("");
  const [options, setOptions] = useState<string[]>(["", "", "", ""]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/vet-qa");
      if (!res.ok) { router.push(`/admin?userId=${userId}`); return; }
      const data = await res.json();
      setItems(data.items ?? []);
      setIdx(0);
    } finally {
      setLoading(false);
    }
  }, [router, userId]);

  useEffect(() => { load(); }, [load]);

  // Filter items by subject
  const filtered = filter === "all" ? items : items.filter(it => it.subject.toLowerCase().includes(filter));
  const current = filtered[idx] ?? null;

  // Sync editable fields when current changes
  useEffect(() => {
    if (!current) return;
    setStem(current.transcribedStem ?? "");
    setAnswer(current.answer ?? "");
    const opts = Array.isArray(current.transcribedOptions) ? (current.transcribedOptions as string[]) : [];
    const padded = [...opts];
    while (padded.length < 4) padded.push("");
    setOptions(padded.slice(0, 4));
  }, [current]);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2000);
  }

  async function handleSave() {
    if (!current || saving) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      if (stem !== (current.transcribedStem ?? "")) body.transcribedStem = stem.trim() || null;
      if (answer !== (current.answer ?? "")) body.answer = answer.trim() || null;
      const hasOpts = options.some(o => o.trim());
      if (hasOpts) body.transcribedOptions = options.map(o => o.trim());

      if (Object.keys(body).length > 0) {
        const res = await fetch(`/api/exam/questions/${current.questionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) { flash("Save failed"); return; }
      }

      // Clear audit flag
      await fetch("/api/admin/vet-qa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paperId: current.paperId, questionId: current.questionId }),
      });

      // Remove from local list and advance
      setItems(prev => prev.filter(it => it.questionId !== current.questionId));
      flash("Saved & cleared");
    } finally {
      setSaving(false);
    }
  }

  async function handleSkip() {
    if (!current) return;
    // Clear flag without editing
    await fetch("/api/admin/vet-qa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paperId: current.paperId, questionId: current.questionId }),
    });
    setItems(prev => prev.filter(it => it.questionId !== current.questionId));
    flash("Skipped");
  }

  function handleNext() { setIdx(i => Math.min(filtered.length - 1, i + 1)); }
  function handlePrev() { setIdx(i => Math.max(0, i - 1)); }

  const isMcq = options.some(o => o.trim());

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24">
        {/* Header */}
        <div className="bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between">
          <div>
            <Link href={`/admin?userId=${userId}`} className="text-xs text-slate-400 hover:text-slate-600">&larr; Admin</Link>
            <h1 className="text-lg font-bold text-slate-800">Vet Q&A</h1>
            <p className="text-xs text-slate-400">{filtered.length} flagged questions remaining</p>
          </div>
          <div className="flex gap-1">
            {(["all", "math", "science", "english"] as const).map(f => (
              <button key={f} onClick={() => { setFilter(f); setIdx(0); }}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${filter === f ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}>
                {f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {loading && <div className="p-8 text-center text-sm text-slate-400">Loading…</div>}

        {!loading && filtered.length === 0 && (
          <div className="p-16 text-center">
            <span className="material-symbols-outlined text-4xl text-green-400 mb-3 block">task_alt</span>
            <p className="font-bold text-slate-700">All clear!</p>
            <p className="text-sm text-slate-400">No flagged questions to review.</p>
          </div>
        )}

        {!loading && current && (
          <div className="max-w-3xl mx-auto px-4 py-6">
            {/* Progress */}
            <div className="flex items-center justify-between mb-4">
              <button onClick={handlePrev} disabled={idx === 0}
                className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-500 text-sm font-bold disabled:opacity-30">
                &larr; Prev
              </button>
              <span className="text-sm font-bold text-slate-500">{idx + 1} / {filtered.length}</span>
              <button onClick={handleNext} disabled={idx >= filtered.length - 1}
                className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-500 text-sm font-bold disabled:opacity-30">
                Next &rarr;
              </button>
            </div>

            {/* Card */}
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
              {/* Flag reason banner */}
              <div className="bg-red-50 border-b border-red-200 px-5 py-3">
                <p className="text-xs font-bold text-red-600 uppercase tracking-wider mb-1">AI Flag</p>
                <p className="text-sm text-red-800 leading-relaxed">{current.reason}</p>
              </div>

              {/* Paper context */}
              <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-slate-800">Q{current.questionNum} · {current.syllabusTopic ?? ""}</p>
                  <p className="text-xs text-slate-400">{current.paperTitle}</p>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <a href={`/exam/${current.paperId}/edit?userId=${userId}`} target="_blank" rel="noopener"
                    className="text-[10px] font-bold text-blue-600 bg-blue-50 px-2 py-1 rounded hover:bg-blue-100 truncate max-w-[200px]"
                    title={current.paperTitle}>
                    Edit: {current.paperTitle.split(" · ").slice(-2).join(" ")} ↗
                  </a>
                  <a href={`/exam/${current.paperId}/transcribe-edit?userId=${userId}#q-${current.questionId}`} target="_blank" rel="noopener"
                    className="text-[10px] font-bold text-slate-500 bg-slate-100 px-2 py-1 rounded hover:bg-slate-200">
                    Clean Edit ↗
                  </a>
                </div>
              </div>

              {/* Question image */}
              {current.imageData && (
                <div className="px-5 py-3 border-b border-slate-100">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Question Image</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={current.imageData} alt={`Q${current.questionNum}`}
                    className="max-h-48 rounded-lg border border-slate-200" />
                </div>
              )}

              {/* Diagram */}
              {current.diagramImageData && (
                <div className="px-5 py-3 border-b border-slate-100">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Diagram</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`data:image/jpeg;base64,${current.diagramImageData}`} alt="Diagram"
                    className="max-h-40 rounded-lg border border-slate-200" />
                </div>
              )}

              {/* Editable stem */}
              <div className="px-5 py-3 border-b border-slate-100">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Question Stem</p>
                <textarea
                  value={stem}
                  onChange={e => setStem(e.target.value)}
                  rows={Math.min(8, Math.max(3, (stem.match(/\n/g)?.length ?? 0) + 2))}
                  className="w-full text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400 resize-y"
                  placeholder="Question stem…"
                />
              </div>

              {/* Sub-parts (a), (b), (c)... */}
              {current.transcribedSubparts && current.transcribedSubparts.filter(s => !s.label.startsWith("_")).length > 0 && (
                <div className="px-5 py-3 border-b border-slate-100">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Sub-parts</p>
                  <div className="space-y-2">
                    {current.transcribedSubparts.filter(s => !s.label.startsWith("_")).map(sp => (
                      <div key={sp.label} className="flex items-start gap-2">
                        <span className="text-xs font-bold text-amber-600 mt-1 shrink-0">({sp.label})</span>
                        <p className="text-sm text-slate-700 leading-relaxed">{sp.text}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Editable options (MCQ) */}
              {(isMcq || current.answer?.match(/^\(?[1-4]\)?$/)) && (
                <div className="px-5 py-3 border-b border-slate-100">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Options</p>
                  <div className="space-y-2">
                    {[0, 1, 2, 3].map(i => (
                      <div key={i} className="flex items-center gap-2">
                        <span className="text-xs font-bold text-slate-400 w-5 shrink-0">({i + 1})</span>
                        <input
                          value={options[i] ?? ""}
                          onChange={e => {
                            const next = [...options];
                            next[i] = e.target.value;
                            setOptions(next);
                          }}
                          className="flex-1 text-sm px-2 py-1.5 rounded-lg border border-slate-200 bg-white focus:outline-none focus:border-blue-400"
                          placeholder={`Option ${i + 1}`}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Editable answer */}
              <div className="px-5 py-3 border-b border-slate-100">
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Answer Key</p>
                <textarea
                  value={answer}
                  onChange={e => setAnswer(e.target.value)}
                  rows={Math.min(6, Math.max(2, (answer.match(/\n/g)?.length ?? 0) + 2))}
                  className="w-full text-sm font-mono bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-blue-400 resize-y"
                  placeholder="Answer…"
                />
                {current.marksAvailable && (
                  <p className="text-[10px] text-slate-400 mt-1">{current.marksAvailable} mark{current.marksAvailable > 1 ? "s" : ""}</p>
                )}
              </div>

              {/* Actions */}
              <div className="px-5 py-4 flex gap-3">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex-1 py-3 rounded-xl bg-[#003366] text-white font-bold text-sm hover:bg-[#001e40] transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-base">save</span>
                  {saving ? "Saving…" : "Save & Clear Flag"}
                </button>
                <button
                  onClick={handleSkip}
                  className="px-6 py-3 rounded-xl border-2 border-slate-200 text-slate-500 font-bold text-sm hover:bg-slate-50 transition-colors"
                >
                  Skip, as is
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Toast */}
        {toast && (
          <div className="fixed bottom-8 left-1/2 -translate-x-1/2 bg-[#001e40] text-white text-sm font-bold px-5 py-3 rounded-2xl shadow-xl z-50 animate-fade-in-up">
            {toast}
          </div>
        )}
      </div>
    </div>
  );
}
