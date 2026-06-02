"use client";

import { useState } from "react";

type SectionType = "booklet-a" | "grammar-cloze" | "editing" | "comp-cloze" | "comp-oeq";

const SECTIONS: { type: SectionType; label: string; note: string; ready: boolean }[] = [
  { type: "booklet-a", label: "Booklet A (Sequential MCQ)", note: "Grammar / Vocab / Vocab Cloze / Visual Text MCQs — sequential numbering", ready: true },
  { type: "grammar-cloze", label: "Grammar Cloze", note: "Inline blanks. Box = ±5% top/bottom, ±6% L/R around the Q number", ready: true },
  { type: "editing", label: "Editing", note: "Q number → +15% right, ±5% top/bottom", ready: true },
  { type: "comp-cloze", label: "Comprehension Cloze", note: "Same as Grammar Cloze (±5% top/bottom, ±6% L/R)", ready: true },
  { type: "comp-oeq", label: "Comprehension OEQ", note: "Sequential — yEnd derived from next question", ready: true },
];

type RunResult = {
  ok: boolean;
  updated?: number;
  warnings?: string[];
  perSection?: Array<{ label: string; updated: number }>;
  error?: string;
  state?: Record<string, unknown>;
};

type State = Record<string, unknown>;

export default function EnglishNormalExtractPanel({ paperId, initialState }: { paperId: string; initialState: State }) {
  const [state, setState] = useState<State>(initialState);
  const [busy, setBusy] = useState<SectionType | null>(null);
  const [lastResult, setLastResult] = useState<{ sectionType: SectionType; result: RunResult } | null>(null);

  async function run(sectionType: SectionType) {
    setBusy(sectionType);
    setLastResult(null);
    const url = `/api/admin/exam/${paperId}/normal-extract-english`;
    console.log("[normal-extract] POST", url, { sectionType });
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sectionType }),
      });
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; }
      catch { json = { error: `Non-JSON response (${res.status}): ${text.slice(0, 200)}` }; }
      console.log("[normal-extract] response", res.status, json);
      const result: RunResult = res.ok
        ? { ok: true, ...json }
        : { ok: false, error: (json.error as string) ?? `HTTP ${res.status}`, ...json };
      setLastResult({ sectionType, result });
      if (json.state) setState(json.state as State);
    } catch (err) {
      console.error("[normal-extract] fetch failed", err);
      setLastResult({ sectionType, result: { ok: false, error: err instanceof Error ? err.message : String(err) } });
    } finally {
      setBusy(null);
    }
  }

  const sectionKeyMap: Record<SectionType, string> = {
    "booklet-a": "bookletA",
    "grammar-cloze": "grammarCloze",
    "editing": "editing",
    "comp-cloze": "compCloze",
    "comp-oeq": "compOeq",
  };

  return (
    <div className="space-y-2">
      {SECTIONS.map(sec => {
        const isDone = !!state[sectionKeyMap[sec.type]];
        const isBusy = busy === sec.type;
        return (
          <div key={sec.type} className="flex items-center gap-3 p-3 rounded-xl border border-slate-200 bg-slate-50">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-slate-700">{sec.label}</span>
                {isDone && (
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-green-50 text-green-700">Done</span>
                )}
                {!sec.ready && (
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-700">Stub</span>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-0.5">{sec.note}</p>
            </div>
            <button
              type="button"
              onClick={() => run(sec.type)}
              disabled={isBusy || busy !== null}
              className={`shrink-0 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                isDone
                  ? "bg-violet-100 text-violet-700 hover:bg-violet-200"
                  : "bg-violet-500 text-white hover:bg-violet-600"
              } disabled:opacity-50`}
            >
              {isBusy ? "Running…" : isDone ? "Re-extract" : "Extract"}
            </button>
          </div>
        );
      })}

      {lastResult && (
        <div className={`mt-3 p-3 rounded-xl border ${
          lastResult.result.ok ? "bg-green-50 border-green-200" : "bg-red-50 border-red-200"
        }`}>
          <p className="text-xs font-bold text-slate-700">
            {lastResult.sectionType}: {lastResult.result.ok ? `${lastResult.result.updated ?? 0} questions updated` : "Failed"}
          </p>
          {lastResult.result.error && (
            <p className="text-xs text-red-700 mt-1">{lastResult.result.error}</p>
          )}
          {lastResult.result.perSection && lastResult.result.perSection.length > 0 && (
            <ul className="mt-2 space-y-0.5">
              {lastResult.result.perSection.map((s, i) => (
                <li key={i} className="text-xs text-slate-600">
                  <span className="font-medium">{s.label}</span>: {s.updated} updated
                </li>
              ))}
            </ul>
          )}
          {lastResult.result.warnings && lastResult.result.warnings.length > 0 && (
            <details className="mt-2">
              <summary className="text-xs cursor-pointer text-amber-700">
                {lastResult.result.warnings.length} warning(s) — click to expand
              </summary>
              <ul className="mt-1 space-y-0.5 pl-3">
                {lastResult.result.warnings.map((w, i) => (
                  <li key={i} className="text-[11px] text-amber-700">• {w}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
