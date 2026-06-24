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
  contentScore: number;  contentNotes: string;  contentNotesEn?: string;
  vocabScore: number;    vocabNotes: string;    vocabNotesEn?: string;
  sentenceScore: number; sentenceNotes: string; sentenceNotesEn?: string;
  overallScore: number;  overallSummary: string; overallSummaryEn?: string;
  cleanRewriteScore?: number;
  benchmarkYears: string[];
};

type Recommendations = {
  structural: Array<{
    piece: string; pieceEn?: string;
    issue: string; issueEn?: string;
    suggestion: string; suggestionEn?: string;
    exampleFromModel?: { year: string; snippet: string; bucket: string };
  }>;
  language: Array<{
    phraseCn: string; phraseEn?: string; fromYear?: string;
    bucket: string; whyItHelps: string;
  }>;
  elevatedDraft?: string;
  elevatedDraftScore?: number;
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
          <div className="flex gap-2">
            <button
              onClick={() => window.print()}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100 text-slate-700 hover:bg-slate-200"
              title="Use 'Save as PDF' in the print dialog"
            >
              Export to PDF
            </button>
            <button
              onClick={reanalyse}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100 text-slate-700 hover:bg-slate-200"
            >
              Re-analyse
            </button>
          </div>
        </div>
      </div>

      {(row.status === "analysing" || row.status === "uploaded") && (
        <ProgressTracker row={row} />
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
          <WordCountFooter
            view={view}
            ocrText={ocrText}
            elevatedDraft={row?.recommendations?.elevatedDraft ?? null}
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
          {row.critique && <CritiqueCard c={row.critique} r={row.recommendations} />}
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

// Strip the [+ ... +] markers so the count reflects the actual text
// the kid would write, not the edit markers.
function stripMarkers(text: string): string {
  return text.replace(/\[\+([\s\S]*?)\+\]/g, "$1");
}

// Chinese "word count" = count of Chinese characters (CJK Unified
// Ideographs) since Chinese isn't whitespace-delimited. Also report
// total characters (incl. punctuation + ASCII) so the parent can see
// both numbers — PSLE guidance is typically ≥ 150 chars at P5,
// ≥ 200 at P6.
function countChars(text: string): { cjk: number; total: number } {
  const cleaned = text.replace(/\s+/g, "");
  let cjk = 0;
  for (const c of text) {
    const code = c.codePointAt(0) ?? 0;
    // CJK Unified Ideographs (basic + extension A) — covers nearly
    // every primary-school Chinese character.
    if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF)) cjk++;
  }
  return { cjk, total: cleaned.length };
}

function WordCountFooter({
  view,
  ocrText,
  elevatedDraft,
}: {
  view: "marked" | "clean" | "elevated";
  ocrText: string;
  elevatedDraft: string | null;
}) {
  const original = countChars(ocrText);
  const elevated = elevatedDraft ? countChars(stripMarkers(elevatedDraft)) : null;
  const currentLabel =
    view === "marked"   ? "Original (with errors marked)"  :
    view === "clean"    ? "Original (errors corrected)"    :
                          "Elevated draft";
  const current = view === "elevated" && elevated ? elevated : original;
  return (
    <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-slate-500 px-2">
      <span>
        <span className="font-semibold text-slate-700">{currentLabel}:</span>{" "}
        {current.cjk} Chinese chars · {current.total} total
      </span>
      {view === "elevated" && elevated && (
        <span className="text-slate-400">
          (original was {original.cjk} CJK / {original.total} total)
        </span>
      )}
    </div>
  );
}

type Stage = {
  num: number;
  label: string;
  detail: string;
  done: boolean;
  current: boolean;
};

function ProgressTracker({ row }: { row: Row }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const startedAt = new Date(row.createdAt).getTime();
  const elapsedSec = Math.floor((now - startedAt) / 1000);
  const mm = Math.floor(elapsedSec / 60);
  const ss = (elapsedSec % 60).toString().padStart(2, "0");

  const ocrDone = !!row.ocrText && row.ocrText.length > 0;
  const wrongWordsDone = row.wrongWords !== null;
  const critiqueDone = row.critique !== null;
  const recsDone = row.recommendations !== null && row.recommendations.structural !== undefined;
  const elevDone = !!row.recommendations?.elevatedDraft;

  // The current stage is the first one not yet done.
  const stages: Stage[] = [
    { num: 1, label: "OCR", detail: ocrDone ? `${row.ocrText!.length} chars transcribed` : "reading composition with Gemini 3.1-pro…", done: ocrDone, current: false },
    { num: 2, label: "Wrong-word check", detail: wrongWordsDone ? `${row.wrongWords!.length} issue(s) flagged (错别字 / 漏字 / 用词)` : "scanning for 错别字 / 漏字 / 用词不当…", done: wrongWordsDone, current: false },
    { num: 3, label: "40-mark rubric critique", detail: critiqueDone ? `${row.critique!.overallScore}/40 (benchmarked vs 10 years of 40/40 PSLE essays, 2016-2025)` : "scoring against 10-year PSLE 40/40 corpus (20 model essays)…", done: critiqueDone, current: false },
    { num: 4, label: "Recommendations", detail: recsDone ? `${row.recommendations!.structural.length} structural + ${row.recommendations!.language.length} language` : "structural gaps + language upgrades from the playbook…", done: recsDone, current: false },
    { num: 5, label: "Elevated draft (35-40 target)", detail: elevDone ? `~${row.recommendations!.elevatedDraftScore ?? "?"}/40, ${row.recommendations!.elevatedDraft!.length} chars` : "rewriting in upper-primary voice while keeping the kid's plot…", done: elevDone, current: false },
  ];
  const currentIdx = stages.findIndex(s => !s.done);
  if (currentIdx >= 0) stages[currentIdx].current = true;

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 space-y-2">
      <div className="flex justify-between items-center">
        <div className="text-sm font-semibold text-amber-900">
          Analysing… (typically 1-2 min)
        </div>
        <div className="text-xs text-amber-700 font-mono">elapsed {mm}:{ss}</div>
      </div>
      <ul className="space-y-1.5">
        {stages.map(s => (
          <li key={s.num} className="flex items-start gap-2 text-xs">
            <span className={`mt-0.5 flex-shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full text-[10px] font-bold ${
              s.done    ? "bg-emerald-500 text-white" :
              s.current ? "bg-amber-500 text-white animate-pulse" :
                          "bg-slate-200 text-slate-500"
            }`}>
              {s.done ? "✓" : s.num}
            </span>
            <div className="flex-1">
              <div className={s.done ? "text-slate-700 font-medium" : s.current ? "text-amber-900 font-medium" : "text-slate-500"}>
                Stage {s.num}/5 — {s.label}
              </div>
              <div className={`text-[11px] ${s.done ? "text-emerald-700" : s.current ? "text-amber-700" : "text-slate-400"}`}>
                {s.detail}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CritiqueCard({ c, r }: { c: Critique; r?: Recommendations | null }) {
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
          {c.contentNotesEn && <p className="text-slate-500 text-xs italic mt-0.5">{c.contentNotesEn}</p>}
        </div>
        <div>
          <div className="flex justify-between font-medium text-slate-700">
            <span>词汇好句 Vocab &amp; phrases</span><span>{c.vocabScore}/10</span>
          </div>
          <p className="text-slate-600 text-xs mt-0.5">{c.vocabNotes}</p>
          {c.vocabNotesEn && <p className="text-slate-500 text-xs italic mt-0.5">{c.vocabNotesEn}</p>}
        </div>
        <div>
          <div className="flex justify-between font-medium text-slate-700">
            <span>句子结构 Sentence &amp; org</span><span>{c.sentenceScore}/10</span>
          </div>
          <p className="text-slate-600 text-xs mt-0.5">{c.sentenceNotes}</p>
          {c.sentenceNotesEn && <p className="text-slate-500 text-xs italic mt-0.5">{c.sentenceNotesEn}</p>}
        </div>
        <div className="pt-3 border-t border-slate-100">
          <p className="text-xs text-slate-700 italic">{c.overallSummary}</p>
          {c.overallSummaryEn && <p className="text-[11px] text-slate-500 italic mt-0.5">{c.overallSummaryEn}</p>}
          {c.benchmarkYears.length > 0 && (
            <p className="text-[10px] text-slate-400 mt-1">benchmarked vs PSLE {c.benchmarkYears.join(", ")}</p>
          )}
        </div>
        {/* Projected scores for the two rewrites. */}
        <div className="pt-3 border-t border-slate-100 space-y-1">
          {c.cleanRewriteScore !== undefined && c.cleanRewriteScore !== c.overallScore && (
            <div className="flex justify-between text-xs">
              <span className="text-emerald-700 font-medium">If errors fixed (Clean rewrite)</span>
              <span className="text-emerald-800 font-bold">{c.cleanRewriteScore}/40</span>
            </div>
          )}
          {r?.elevatedDraftScore !== undefined && (
            <div className="flex justify-between text-xs">
              <span className="text-emerald-700 font-medium">Elevated draft (35-40 target)</span>
              <span className="text-emerald-800 font-bold">{r.elevatedDraftScore}/40</span>
            </div>
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
                <div className="font-medium text-slate-800">
                  {s.piece}
                  {s.pieceEn && <span className="ml-1.5 text-slate-500 font-normal italic">— {s.pieceEn}</span>}
                </div>
                <div className="text-xs text-slate-600">{s.issue}</div>
                {s.issueEn && <div className="text-xs text-slate-500 italic">{s.issueEn}</div>}
                <div className="text-xs text-slate-700 mt-1"><em>→ {s.suggestion}</em></div>
                {s.suggestionEn && <div className="text-xs text-slate-500 italic mt-0.5">→ {s.suggestionEn}</div>}
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
                  {l.bucket}
                  {l.fromYear && l.fromYear.trim() && /^\d{4}$/.test(l.fromYear.trim()) ? ` · PSLE ${l.fromYear}` : ""}
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
