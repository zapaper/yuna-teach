"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import AdminNav from "@/components/AdminNav";
import MathText from "@/components/MathText";

type Candidate = {
  id: string;
  questionNum: string;
  transcribedStem: string | null;
  transcribedOptions: unknown;
  answer: string | null;
  syllabusTopic: string | null;
  paper: { id: string; title: string; level: string | null; examType: string | null };
};

// Convert plain mixed numbers ("4 5/6") and bare fractions ("5/6")
// inside a string into LaTeX math segments. Conservative — skips
// dates / division-style "10/2" by requiring the fraction to appear
// inside the same word boundary as a preceding integer (mixed) or
// as a standalone "N/M" surrounded by spaces / start / end.
function convertToLatex(text: string): string {
  if (!text) return text;
  // Mixed number: "4 5/6" → "$4\frac{5}{6}$"
  let out = text.replace(/(\b\d+)\s+(\d+)\/(\d+)\b/g, "$$$1\\frac{$2}{$3}$$");
  // Bare fraction at word boundary: "5/6" → "$\frac{5}{6}$"
  // Skip dates: 1/1/2024 has 3 parts (the regex with /g and \b
  // boundaries already rejects this since the trailing /YYYY would
  // leave a digit-slash continuation that breaks the \b). For
  // safety, only match exactly "N/M" with a single slash.
  out = out.replace(/\b(\d+)\/(\d+)\b(?!\/)/g, (full, a, b, offset, full2) => {
    // Skip if directly after "$" (already in math) or immediately
    // adjacent to another digit-slash on either side (likely date).
    const before = (full2 as string).slice(Math.max(0, offset - 1), offset);
    if (before === "$" || before === "{") return full;
    return `$\\frac{${a}}{${b}}$`;
  });
  return out;
}

export default function LatexFractionPage() {
  return (
    <Suspense>
      <Content />
    </Suspense>
  );
}

function Content() {
  const sp = useSearchParams();
  const userId = sp.get("userId") ?? "";
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [items, setItems] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [idx, setIdx] = useState(0);
  const [editStem, setEditStem] = useState("");
  const [editOptions, setEditOptions] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`).then(r => setAllowed(r.ok)).catch(() => setAllowed(false));
  }, [userId]);

  useEffect(() => {
    if (!allowed) return;
    setLoading(true);
    fetch("/api/admin/latex-candidates")
      .then(r => r.json())
      .then(d => { setItems(d.candidates ?? []); })
      .finally(() => setLoading(false));
  }, [allowed]);

  // Re-seed the edit textareas with the proposed conversion every
  // time the admin advances to a new candidate. Admin can hand-tweak
  // before approving.
  const current = items[idx];
  const currentOptions = useMemo(() => {
    if (!current) return [] as string[];
    const opts = current.transcribedOptions as unknown;
    if (!Array.isArray(opts)) return [];
    return opts.map(o => (typeof o === "string" ? o : ""));
  }, [current]);

  useEffect(() => {
    if (!current) return;
    setEditStem(convertToLatex(current.transcribedStem ?? ""));
    setEditOptions(currentOptions.map(o => convertToLatex(o)));
    setError(null);
  }, [current, currentOptions]);

  async function approve() {
    if (!current) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/exam/questions/${current.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transcribedStem: editStem,
          transcribedOptions: editOptions,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Save failed");
        return;
      }
      // Drop this item from the local list and stay on the same idx
      // so the next item slides into place.
      setItems(prev => prev.filter((_, i) => i !== idx));
      setIdx(i => Math.max(0, Math.min(i, items.length - 2)));
    } catch {
      setError("Save failed");
    } finally {
      setSaving(false);
    }
  }

  function skip() {
    setIdx(i => Math.min(items.length - 1, i + 1));
  }
  function back() {
    setIdx(i => Math.max(0, i - 1));
  }

  if (allowed === null) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" /></div>;
  }
  if (!allowed) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><p className="text-slate-500 text-sm">Access denied.</p></div>;
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24 lg:pb-0">
        <div className="bg-white border-b border-slate-200 px-4 py-3">
          <h1 className="text-lg font-bold text-slate-800">Convert to LaTeX fraction</h1>
          <p className="text-xs text-slate-400">
            Math MCQ questions whose stem or options contain a mixed-number / bare-fraction pattern likely to be misread by students.
          </p>
        </div>

        <div className="max-w-5xl mx-auto px-4 py-6">
          {loading ? (
            <div className="text-center py-12"><div className="animate-spin inline-block rounded-full h-6 w-6 border-2 border-slate-200 border-t-slate-500" /></div>
          ) : items.length === 0 ? (
            <div className="text-center py-12 text-slate-500 text-sm">No candidates left — every Math MCQ either has no fractions to convert, or has already been LaTeX'd.</div>
          ) : !current ? null : (
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm">
              {/* Header row */}
              <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-xs font-bold text-slate-400 uppercase tracking-wider shrink-0">{idx + 1} / {items.length}</span>
                  <p className="text-xs text-slate-500 truncate">
                    <span className="font-bold text-slate-700">Q{current.questionNum}</span> · {current.paper.title}{current.paper.level ? ` (${current.paper.level})` : ""}{current.paper.examType ? ` · ${current.paper.examType}` : ""}{current.syllabusTopic ? ` · ${current.syllabusTopic}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button onClick={back} disabled={idx === 0} className="px-3 py-1.5 rounded-lg text-xs font-bold border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40">Back</button>
                  <button onClick={skip} disabled={saving} className="px-3 py-1.5 rounded-lg text-xs font-bold border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40">Skip</button>
                  <button onClick={approve} disabled={saving} className="px-4 py-1.5 rounded-lg text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">{saving ? "Saving…" : "Approve"}</button>
                </div>
              </div>

              {error && <div className="px-5 py-2 bg-red-50 border-b border-red-100 text-xs text-red-700">{error}</div>}

              {/* Side-by-side: original (left) vs edited preview (right) */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-0 divide-y lg:divide-y-0 lg:divide-x divide-slate-100">
                {/* Left: original */}
                <div className="px-5 py-4">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Original</p>
                  <div className="text-sm text-slate-800 whitespace-pre-wrap font-mono mb-3 bg-slate-50 rounded-lg p-3 border border-slate-100">
                    {current.transcribedStem}
                  </div>
                  <div className="space-y-1.5">
                    {currentOptions.map((opt, i) => (
                      <div key={i} className="flex items-start gap-2 text-sm">
                        <span className="text-xs font-bold text-slate-400 shrink-0 mt-0.5">({i + 1})</span>
                        <span className={`text-slate-700 font-mono ${current.answer?.replace(/[().]/g, "").trim() === String(i + 1) ? "font-bold text-emerald-700" : ""}`}>{opt}</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] text-slate-400 mt-3">
                    Answer: <span className="font-bold text-emerald-700">{current.answer}</span>
                  </p>
                </div>

                {/* Right: edited preview + textareas */}
                <div className="px-5 py-4">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">After conversion (preview)</p>
                  <div className="text-sm text-slate-800 whitespace-pre-wrap mb-3 bg-emerald-50/50 rounded-lg p-3 border border-emerald-100">
                    <MathText text={editStem} />
                  </div>
                  <div className="space-y-1.5 mb-4">
                    {editOptions.map((opt, i) => (
                      <div key={i} className="flex items-start gap-2 text-sm">
                        <span className="text-xs font-bold text-slate-400 shrink-0 mt-0.5">({i + 1})</span>
                        <span className={`text-slate-700 ${current.answer?.replace(/[().]/g, "").trim() === String(i + 1) ? "font-bold text-emerald-700" : ""}`}>
                          <MathText text={opt} />
                        </span>
                      </div>
                    ))}
                  </div>

                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Stem (editable)</p>
                  <textarea
                    value={editStem}
                    onChange={e => setEditStem(e.target.value)}
                    rows={3}
                    className="w-full text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 mb-3 focus:outline-none focus:border-slate-400 resize-y"
                  />
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Options (editable)</p>
                  <div className="space-y-1">
                    {editOptions.map((opt, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <span className="text-xs font-bold text-slate-400 w-6 shrink-0">({i + 1})</span>
                        <input
                          value={opt}
                          onChange={e => setEditOptions(prev => prev.map((p, pi) => pi === i ? e.target.value : p))}
                          className="flex-1 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:border-slate-400"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
