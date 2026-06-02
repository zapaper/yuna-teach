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

type Bound = {
  id: string;
  questionNum: string;
  pageIndex: number | null;
  yStartPct: number | null;
  yEndPct: number | null;
  xStartPct: number | null;
  xEndPct: number | null;
  status: "updated" | "not_detected" | "no_page";
};

type RunResult = {
  ok: boolean;
  updated?: number;
  warnings?: string[];
  perSection?: Array<{ label: string; updated: number }>;
  bounds?: Bound[];
  error?: string;
  state?: Record<string, unknown>;
};

type State = Record<string, unknown>;

// Aspect ratio used for sizing crop previews. Real images may differ
// slightly but A4 (1:1.414) is correct for almost all PSLE scans we
// see. Off-aspect papers will show crops shifted by a small amount;
// the visible bbox numbers still come from the actual data.
const PAGE_ASPECT = 1.414;

function CropPreview({
  pageUrl,
  yStartPct, yEndPct,
  xStartPct, xEndPct,
  baseWidth = 220,
}: {
  pageUrl: string;
  yStartPct: number; yEndPct: number;
  xStartPct: number | null; xEndPct: number | null;
  baseWidth?: number;
}) {
  const xS = xStartPct ?? 0;
  const xE = xEndPct ?? 100;
  const xRange = Math.max(1, xE - xS);
  const yRange = Math.max(0.5, yEndPct - yStartPct);
  // Scale the full image up so the cropped x-range fills baseWidth.
  const renderedW = baseWidth * 100 / xRange;
  const renderedH = renderedW * PAGE_ASPECT;
  const cropH = renderedH * yRange / 100;
  const offsetTop = -renderedH * yStartPct / 100;
  const offsetLeft = -renderedW * xS / 100;
  return (
    <div style={{ width: baseWidth, height: cropH, overflow: "hidden", position: "relative", background: "#f1f5f9" }}>
      <img
        src={pageUrl}
        alt=""
        style={{ width: renderedW, height: renderedH, position: "absolute", top: offsetTop, left: offsetLeft, maxWidth: "none" }}
      />
    </div>
  );
}

function BoundsGrid({ paperId, bounds }: { paperId: string; bounds: Bound[] }) {
  if (bounds.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="text-xs font-semibold text-slate-600 mb-2">Per-question crops</p>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
        {bounds.map(b => {
          const ok = b.status === "updated" && b.pageIndex != null && b.yStartPct != null && b.yEndPct != null;
          const pageUrl = b.pageIndex != null ? `/api/exam/${paperId}/pages?page=${b.pageIndex}` : "";
          return (
            <div key={b.id} className={`rounded-lg border ${ok ? "border-slate-200 bg-white" : "border-red-200 bg-red-50"} overflow-hidden`}>
              <div className="px-2 py-1 flex items-center justify-between gap-1">
                <span className="text-xs font-bold text-slate-700">Q{b.questionNum}</span>
                <span className="text-[10px] text-slate-500">{b.pageIndex != null ? `p${b.pageIndex + 1}` : "—"}</span>
              </div>
              {ok ? (
                <CropPreview
                  pageUrl={pageUrl}
                  yStartPct={b.yStartPct as number}
                  yEndPct={b.yEndPct as number}
                  xStartPct={b.xStartPct}
                  xEndPct={b.xEndPct}
                />
              ) : (
                <div className="px-2 py-3 text-[11px] text-red-700">
                  {b.status === "not_detected" ? "Not detected" : "No page"}
                </div>
              )}
              <div className="px-2 py-1 text-[10px] text-slate-500 font-mono">
                {b.yStartPct != null && b.yEndPct != null ? `y ${b.yStartPct.toFixed(1)}–${b.yEndPct.toFixed(1)}` : "—"}
                {b.xStartPct != null && b.xEndPct != null && ` · x ${b.xStartPct.toFixed(1)}–${b.xEndPct.toFixed(1)}`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

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
          {lastResult.result.bounds && lastResult.result.bounds.length > 0 && (
            <BoundsGrid paperId={paperId} bounds={lastResult.result.bounds} />
          )}
        </div>
      )}
    </div>
  );
}
