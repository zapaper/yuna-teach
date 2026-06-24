"use client";

// Compo detail — OCR text + wrong-word markup + critique + recommendations.
// Two view modes: "marked" (wrong words crossed out in red, suggestions
// shown alongside) and "clean" (the suggestions applied — original kid
// words in black, corrections + recommended additions in green, for the
// kid to practice copying).

import { useEffect, useState, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

type WrongWord = {
  original: string;
  suggestion: string;
  kind: "stroke" | "meaning" | "misuse" | "omission";
  reason: string;
};

type Critique = {
  contentScore: number;  contentNotes: string;
  vocabScore: number;    vocabNotes: string;
  sentenceScore: number; sentenceNotes: string;
  overallScore: number;  overallSummary: string;
  benchmarkYears: string[];
};

type Recommendations = {
  structural: Array<{
    piece: string; issue: string; suggestion: string;
    exampleFromModel?: { year: string; snippet: string; bucket: string };
  }>;
  language: Array<{
    phraseCn: string; phraseEn?: string; fromYear?: string;
    bucket: string; whyItHelps: string;
  }>;
  elevatedDraft?: string;
};

type Row = {
  id: string;
  label: string | null;
  studentTopic: string | null;
  optionType: string | null;
  status: "uploaded" | "analysing" | "ready" | "failed";
  errorMessage: string | null;
  ocrText: string | null;
  ocrQuestionText: string | null;
  wrongWords: WrongWord[] | null;
  critique: Critique | null;
  recommendations: Recommendations | null;
  analysedAt: string | null;
  createdAt: string;
};

export default function CompoDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const [row, setRow] = useState<Row | null>(null);
  const [view, setView] = useState<"marked" | "clean" | "elevated">("marked");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/compo/${id}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setRow(data.row);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    refresh();
    const interval = setInterval(() => {
      if (row?.status === "analysing" || row?.status === "uploaded") refresh();
    }, 4000);
    return () => clearInterval(interval);
  }, [refresh, row?.status]);

  const reanalyse = async () => {
    await fetch(`/api/admin/compo/${id}/analyse`, { method: "POST" });
    await refresh();
  };

  const ocrText = row?.ocrText ?? "";
  const wrongWords = row?.wrongWords ?? [];

  const markedHtml = useMemo(() => renderMarked(ocrText, wrongWords), [ocrText, wrongWords]);
  const cleanHtml  = useMemo(() => renderClean(ocrText, wrongWords),  [ocrText, wrongWords]);
  const elevatedHtml = useMemo(
    () => renderElevated(row?.recommendations?.elevatedDraft ?? ""),
    [row?.recommendations?.elevatedDraft],
  );

  if (!row && !error) return <p className="p-6 text-sm text-slate-500">Loading…</p>;
  if (error)         return <p className="p-6 text-sm text-red-600">{error}</p>;
  if (!row)          return null;

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-5">
      <div>
        <Link href="/admin/compo" className="text-sm text-slate-500 hover:underline">← Compo</Link>
        <div className="flex items-end justify-between mt-2">
          <div>
            <h1 className="text-xl font-bold text-slate-900">{row.label ?? "(no label)"}</h1>
            {row.studentTopic && <p className="text-sm text-slate-600">{row.studentTopic}</p>}
            <p className="text-xs text-slate-500 mt-1">
              uploaded {new Date(row.createdAt).toLocaleString("en-SG", { dateStyle: "medium", timeStyle: "short" })}
              {row.analysedAt && <> · analysed {new Date(row.analysedAt).toLocaleString("en-SG", { dateStyle: "medium", timeStyle: "short" })}</>}
              {row.optionType && <> · {row.optionType}</>}
            </p>
          </div>
          <button
            onClick={reanalyse}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100 text-slate-700 hover:bg-slate-200"
          >
            Re-analyse
          </button>
        </div>
      </div>

      {row.status === "analysing" && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
          Analysing… OCR + wrong-word check + 40-mark critique + recommendations. This takes 1-2 minutes.
        </div>
      )}
      {row.status === "failed" && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">
          <strong>Failed:</strong> {row.errorMessage ?? "(no message)"}
        </div>
      )}

      {/* View toggle */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => setView("marked")}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium ${view === "marked" ? "bg-slate-900 text-white" : "bg-white border border-slate-300 text-slate-700"}`}
        >
          Marked-up (errors in red)
        </button>
        <button
          onClick={() => setView("clean")}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium ${view === "clean" ? "bg-slate-900 text-white" : "bg-white border border-slate-300 text-slate-700"}`}
        >
          Clean rewrite (corrections in green)
        </button>
        <button
          onClick={() => setView("elevated")}
          disabled={!row.recommendations?.elevatedDraft}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium disabled:opacity-50 ${view === "elevated" ? "bg-slate-900 text-white" : "bg-white border border-slate-300 text-slate-700"}`}
          title={row.recommendations?.elevatedDraft ? "" : "Elevated draft not generated yet"}
        >
          Elevated to 35-40 (upgrades in green)
        </button>
      </div>

      <div className="grid grid-cols-3 gap-5">
        {/* Main composition view */}
        <div className="col-span-2">
          <h2 className="text-sm font-semibold text-slate-800 mb-2">作文</h2>
          <div
            className="bg-white border border-slate-200 rounded-2xl p-6 text-base leading-loose whitespace-pre-wrap text-slate-900"
            style={{ fontFamily: "'Noto Serif SC', 'PingFang SC', 'Microsoft YaHei', serif" }}
            dangerouslySetInnerHTML={{ __html:
              view === "marked"   ? markedHtml :
              view === "clean"    ? cleanHtml  :
                                    elevatedHtml }}
          />
          {row.ocrQuestionText && (
            <details className="mt-4">
              <summary className="text-xs text-slate-500 cursor-pointer">Question / picture-series OCR</summary>
              <pre className="mt-2 text-xs bg-slate-50 p-3 rounded-lg whitespace-pre-wrap">{row.ocrQuestionText}</pre>
            </details>
          )}
        </div>

        {/* Critique + recommendations side panel */}
        <div className="col-span-1 space-y-4">
          {row.critique && <CritiqueCard c={row.critique} />}
          {row.recommendations && <RecommendationsCard r={row.recommendations} />}
          {row.wrongWords && row.wrongWords.length > 0 && <WrongWordsCard ws={row.wrongWords} />}
        </div>
      </div>
    </div>
  );
}

// ─── Renderers ───────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type Range = { start: number; end: number; original: string; suggestion: string };

function findRanges(ocr: string, ws: WrongWord[]): Range[] {
  // Longer originals first so e.g. a 2-character "厉害" doesn't get
  // shadowed by a 1-character substring matched earlier.
  const sorted = [...ws].sort((a, b) => b.original.length - a.original.length);
  const ranges: Range[] = [];
  for (const w of sorted) {
    if (!w.original) continue;
    const idx = ocr.indexOf(w.original);
    if (idx < 0) continue;
    // Reject overlap with an already-claimed range.
    if (ranges.some(r => idx < r.end && idx + w.original.length > r.start)) continue;
    ranges.push({ start: idx, end: idx + w.original.length, original: w.original, suggestion: w.suggestion });
  }
  return ranges.sort((a, b) => a.start - b.start);
}

function renderMarked(ocr: string, ws: WrongWord[]): string {
  const ranges = findRanges(ocr, ws);
  let out = "";
  let pos = 0;
  for (const r of ranges) {
    out += escapeHtml(ocr.slice(pos, r.start));
    out += `<span style="color:#b91c1c;text-decoration:line-through">${escapeHtml(r.original)}</span>`;
    out += `<span style="color:#b91c1c;font-weight:600">[${escapeHtml(r.suggestion)}]</span>`;
    pos = r.end;
  }
  out += escapeHtml(ocr.slice(pos));
  return out;
}

function renderClean(ocr: string, ws: WrongWord[]): string {
  const ranges = findRanges(ocr, ws);
  let out = "";
  let pos = 0;
  for (const r of ranges) {
    out += escapeHtml(ocr.slice(pos, r.start));
    out += `<span style="color:#047857;font-weight:700">${escapeHtml(r.suggestion)}</span>`;
    pos = r.end;
  }
  out += escapeHtml(ocr.slice(pos));
  return out;
}

// Elevated draft renderer — AI emits text with `[+inserted+]` markers
// around new content. Plain text (kid's words) stays in default
// (black) color; marked text gets the green-bold treatment, same
// visual language as the Clean rewrite view.
function renderElevated(text: string): string {
  if (!text) return "<em style=\"color:#94a3b8\">Elevated draft not generated yet.</em>";
  const parts = text.split(/\[\+([\s\S]*?)\+\]/);
  return parts.map((p, i) =>
    i % 2 === 0
      ? escapeHtml(p)
      : `<span style="color:#047857;font-weight:700">${escapeHtml(p)}</span>`
  ).join("");
}

// ─── Side cards ──────────────────────────────────────────────────────

function CritiqueCard({ c }: { c: Critique }) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-800">40-mark rubric</h3>
        <div className="text-xl font-bold text-slate-900">{c.overallScore}<span className="text-slate-500 text-sm">/40</span></div>
      </div>
      <div className="mt-3 space-y-3 text-sm">
        <div>
          <div className="flex justify-between font-medium text-slate-700">
            <span>内容 Content</span><span>{c.contentScore}/20</span>
          </div>
          <p className="text-slate-600 text-xs mt-0.5">{c.contentNotes}</p>
        </div>
        <div>
          <div className="flex justify-between font-medium text-slate-700">
            <span>词汇好句 Vocab &amp; phrases</span><span>{c.vocabScore}/10</span>
          </div>
          <p className="text-slate-600 text-xs mt-0.5">{c.vocabNotes}</p>
        </div>
        <div>
          <div className="flex justify-between font-medium text-slate-700">
            <span>句子结构 Sentence &amp; org</span><span>{c.sentenceScore}/10</span>
          </div>
          <p className="text-slate-600 text-xs mt-0.5">{c.sentenceNotes}</p>
        </div>
        <div className="pt-3 border-t border-slate-100">
          <p className="text-xs text-slate-700 italic">{c.overallSummary}</p>
          {c.benchmarkYears.length > 0 && (
            <p className="text-[10px] text-slate-400 mt-1">benchmarked vs PSLE {c.benchmarkYears.join(", ")}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function RecommendationsCard({ r }: { r: Recommendations }) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
      <h3 className="text-sm font-semibold text-slate-800">Recommendations</h3>
      {r.structural.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Structure</h4>
          <ul className="space-y-2 text-sm">
            {r.structural.map((s, i) => (
              <li key={i} className="bg-amber-50 border border-amber-100 rounded-lg px-2 py-2">
                <div className="font-medium text-slate-800">{s.piece}</div>
                <div className="text-xs text-slate-600">{s.issue}</div>
                <div className="text-xs text-slate-700 mt-1"><em>→ {s.suggestion}</em></div>
                {s.exampleFromModel && (
                  <div className="text-xs text-slate-500 mt-1 italic">
                    PSLE {s.exampleFromModel.year}: 「{s.exampleFromModel.snippet}」
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {r.language.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Language upgrades</h4>
          <ul className="space-y-2 text-sm">
            {r.language.map((l, i) => (
              <li key={i} className="bg-emerald-50 border border-emerald-100 rounded-lg px-2 py-2">
                <div className="font-medium text-emerald-900">{l.phraseCn}</div>
                {l.phraseEn && <div className="text-xs text-slate-500">{l.phraseEn}</div>}
                <div className="text-xs text-slate-700 mt-1">{l.whyItHelps}</div>
                <div className="text-[10px] text-slate-400 mt-1">
                  {l.bucket}{l.fromYear ? ` · PSLE ${l.fromYear}` : ""}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function WrongWordsCard({ ws }: { ws: WrongWord[] }) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4">
      <h3 className="text-sm font-semibold text-slate-800">用字检查 Wrong words ({ws.length})</h3>
      <ul className="mt-2 space-y-1 text-sm">
        {ws.map((w, i) => (
          <li key={i} className="flex items-baseline gap-2">
            <span className="text-red-700 line-through font-medium">{w.original}</span>
            <span className="text-slate-400">→</span>
            <span className="text-emerald-700 font-medium">{w.suggestion}</span>
            <span className="text-[10px] text-slate-400 ml-1">{w.kind}</span>
            <span className="text-xs text-slate-500 ml-auto">{w.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
