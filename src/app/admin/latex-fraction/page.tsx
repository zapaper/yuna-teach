"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import AdminNav from "@/components/AdminNav";
import MathText from "@/components/MathText";

type Subpart = { label: string; text: string };

type Candidate = {
  id: string;
  questionNum: string;
  isMcq: boolean;
  transcribedStem: string | null;
  transcribedOptions: unknown;
  transcribedSubparts: unknown;
  answer: string | null;
  syllabusTopic: string | null;
  paper: { id: string; title: string; level: string | null; examType: string | null };
};

// Convert mixed numbers and bare fractions inside a string to LaTeX
// math segments. Conservative — only matches explicit `N/M` / `N M/N`
// patterns at word boundaries so dates like "1/1/2024" stay alone.
function convertToLatex(text: string): string {
  if (!text) return text;
  // Mixed number: "4 5/6" → "$4\frac{5}{6}$"
  let out = text.replace(/(\b\d+)\s+(\d+)\/(\d+)\b/g, "$$$1\\frac{$2}{$3}$$");
  // Bare fraction at word boundary: "5/6" → "$\frac{5}{6}$"
  out = out.replace(/(?<!\/|\d|\$|\{)\b(\d+)\/(\d+)\b(?!\/)/g, "$\\frac{$1}{$2}$");
  return out;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map(x => (typeof x === "string" ? x : ""));
}

function asSubpartArray(v: unknown): Subpart[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((sp): sp is Record<string, unknown> => !!sp && typeof sp === "object")
    .map(sp => ({
      label: typeof sp.label === "string" ? sp.label : "",
      text: typeof sp.text === "string" ? sp.text : "",
    }));
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
  const [editSubparts, setEditSubparts] = useState<Subpart[]>([]);
  const [editAnswer, setEditAnswer] = useState("");
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

  const current = items[idx];
  const currentOptions = useMemo(() => asStringArray(current?.transcribedOptions), [current]);
  const currentSubparts = useMemo(() => asSubpartArray(current?.transcribedSubparts), [current]);

  useEffect(() => {
    if (!current) return;
    setEditStem(convertToLatex(current.transcribedStem ?? ""));
    setEditOptions(currentOptions.map(o => convertToLatex(o)));
    setEditSubparts(currentSubparts.map(sp => ({ label: sp.label, text: convertToLatex(sp.text) })));
    setEditAnswer(convertToLatex(current.answer ?? ""));
    setError(null);
  }, [current, currentOptions, currentSubparts]);

  async function approve() {
    if (!current) return;
    setSaving(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        transcribedStem: editStem,
      };
      if (current.isMcq) {
        body.transcribedOptions = editOptions;
      }
      if (currentSubparts.length > 0) {
        // Preserve original ordering and any non-subpart entries we
        // didn't render (sentinels like _drawable / _subref-…).
        const orig = Array.isArray(current.transcribedSubparts) ? current.transcribedSubparts : [];
        const merged = orig.map(o => {
          if (!o || typeof o !== "object") return o;
          const label = (o as { label?: unknown }).label;
          if (typeof label !== "string") return o;
          const editedHit = editSubparts.find(s => s.label === label);
          if (!editedHit) return o;
          return { ...(o as object), text: editedHit.text };
        });
        body.transcribedSubparts = merged;
      }
      if (editAnswer !== (current.answer ?? "")) {
        body.answer = editAnswer;
      }
      const res = await fetch(`/api/exam/questions/${current.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Save failed");
        return;
      }
      setItems(prev => prev.filter((_, i) => i !== idx));
      setIdx(i => Math.max(0, Math.min(i, items.length - 2)));
    } catch {
      setError("Save failed");
    } finally {
      setSaving(false);
    }
  }

  function skip() { setIdx(i => Math.min(items.length - 1, i + 1)); }
  function back() { setIdx(i => Math.max(0, i - 1)); }

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
            Math questions (MCQ + OEQ) whose stem, options, subparts, or answer contain a fraction or mixed-number pattern likely to be misread.
          </p>
        </div>

        <div className="max-w-5xl mx-auto px-4 py-6">
          {loading ? (
            <div className="text-center py-12"><div className="animate-spin inline-block rounded-full h-6 w-6 border-2 border-slate-200 border-t-slate-500" /></div>
          ) : items.length === 0 ? (
            <div className="text-center py-12 text-slate-500 text-sm">No candidates left.</div>
          ) : !current ? null : (
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm">
              <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 gap-2 flex-wrap">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-xs font-bold text-slate-400 uppercase tracking-wider shrink-0">{idx + 1} / {items.length}</span>
                  <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${current.isMcq ? "bg-blue-50 text-blue-700" : "bg-amber-50 text-amber-700"}`}>
                    {current.isMcq ? "MCQ" : "OEQ"}
                  </span>
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

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-0 divide-y lg:divide-y-0 lg:divide-x divide-slate-100">
                {/* Left: original */}
                <div className="px-5 py-4">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Original</p>
                  <div className="text-sm text-slate-800 whitespace-pre-wrap font-mono mb-3 bg-slate-50 rounded-lg p-3 border border-slate-100">
                    {current.transcribedStem}
                  </div>
                  {current.isMcq && currentOptions.length > 0 && (
                    <div className="space-y-1.5 mb-3">
                      {currentOptions.map((opt, i) => (
                        <div key={i} className="flex items-start gap-2 text-sm">
                          <span className="text-xs font-bold text-slate-400 shrink-0 mt-0.5">({i + 1})</span>
                          <span className={`text-slate-700 font-mono ${current.answer?.replace(/[().]/g, "").trim() === String(i + 1) ? "font-bold text-emerald-700" : ""}`}>{opt}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {currentSubparts.length > 0 && (
                    <div className="space-y-1 mb-3">
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Subparts</p>
                      {currentSubparts.map(sp => (
                        <div key={sp.label} className="flex items-start gap-2 text-sm">
                          <span className="text-xs font-bold text-amber-600 shrink-0 mt-0.5">({sp.label})</span>
                          <span className="text-slate-700 font-mono whitespace-pre-wrap">{sp.text}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {current.answer && (
                    <p className="text-xs text-slate-500 mt-2 whitespace-pre-wrap">
                      Answer key: <span className="font-mono text-emerald-700">{current.answer}</span>
                    </p>
                  )}
                </div>

                {/* Right: edited preview + textareas */}
                <div className="px-5 py-4">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">After conversion (preview)</p>
                  <div className="text-sm text-slate-800 whitespace-pre-wrap mb-3 bg-emerald-50/50 rounded-lg p-3 border border-emerald-100">
                    <MathText text={editStem} />
                  </div>
                  {current.isMcq && editOptions.length > 0 && (
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
                  )}
                  {editSubparts.length > 0 && (
                    <div className="space-y-1.5 mb-4">
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">Subparts (preview)</p>
                      {editSubparts.map(sp => (
                        <div key={sp.label} className="flex items-start gap-2 text-sm">
                          <span className="text-xs font-bold text-amber-600 shrink-0 mt-0.5">({sp.label})</span>
                          <span className="text-slate-700 whitespace-pre-wrap"><MathText text={sp.text} /></span>
                        </div>
                      ))}
                    </div>
                  )}
                  {editAnswer && (
                    <p className="text-xs text-slate-500 mb-4 whitespace-pre-wrap">
                      Answer key: <span className="text-emerald-700"><MathText text={editAnswer} /></span>
                    </p>
                  )}

                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Stem (editable)</p>
                  <textarea
                    value={editStem}
                    onChange={e => setEditStem(e.target.value)}
                    rows={4}
                    className="w-full text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 mb-3 focus:outline-none focus:border-slate-400 resize-y"
                  />
                  {current.isMcq && editOptions.length > 0 && (
                    <>
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Options (editable)</p>
                      <div className="space-y-1 mb-3">
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
                    </>
                  )}
                  {editSubparts.length > 0 && (
                    <>
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Subparts (editable)</p>
                      <div className="space-y-1 mb-3">
                        {editSubparts.map((sp, i) => (
                          <div key={sp.label} className="flex items-start gap-2">
                            <span className="text-xs font-bold text-amber-600 w-6 shrink-0 mt-1.5">({sp.label})</span>
                            <textarea
                              value={sp.text}
                              onChange={e => setEditSubparts(prev => prev.map((p, pi) => pi === i ? { ...p, text: e.target.value } : p))}
                              rows={2}
                              className="flex-1 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:border-slate-400 resize-y"
                            />
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  {(current.answer || editAnswer) && (
                    <>
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">Answer key (editable)</p>
                      <textarea
                        value={editAnswer}
                        onChange={e => setEditAnswer(e.target.value)}
                        rows={2}
                        className="w-full text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:border-slate-400 resize-y"
                      />
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
