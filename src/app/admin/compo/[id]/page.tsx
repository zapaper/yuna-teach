"use client";

// Compo detail — OCR text + wrong-word markup + critique + recommendations.
// Two view modes: "marked" (wrong words crossed out in red, suggestions
// shown alongside) and "clean" (the suggestions applied — original kid
// words in black, corrections + recommended additions in green, for the
// kid to practice copying).

import { useEffect, useState, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { fetchJsonSafe } from "@/lib/client-fetch";

type WrongWord = {
  original: string;
  suggestion: string;
  kind: "stroke" | "meaning" | "misuse" | "omission";
  reason: string;
};

type RubricBreakdown = {
  contentScore: number;  contentNotes: string;  contentNotesEn?: string;
  vocabScore: number;    vocabNotes: string;    vocabNotesEn?: string;
  sentenceScore: number; sentenceNotes: string; sentenceNotesEn?: string;
  overallScore: number;
  whyChanged?: string;
  whyChangedEn?: string;
};

type Critique = RubricBreakdown & {
  overallSummary: string; overallSummaryEn?: string;
  cleanRewrite?: RubricBreakdown;
  cleanRewriteScore?: number; // legacy aggregate
  benchmarkYears: string[];
};

type PhraseSwap = {
  originalText: string;
  bucket: string;
  subType?: string;
  originalEn: string;
  alternatives: Array<{ cn: string; en: string }>;
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
  elevatedDraftRubric?: RubricBreakdown;
  elevatedDraftSwaps?: PhraseSwap[];
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
    const result = await fetchJsonSafe<{ row: Row }>(`/api/admin/compo/${id}`);
    if (result.ok) {
      setRow(result.data.row);
      setError(prev => prev && prev.includes("restarting") ? null : prev);
    } else if (!result.transient) {
      // 502/503/504 are deploy-induced; swallow them during the
      // status-conditional poll so the user doesn't see a flash
      // of error during every push.
      setError(result.error);
    }
  }, [id]);

  useEffect(() => {
    refresh();
    const interval = setInterval(() => {
      if (row?.status === "analysing" || row?.status === "uploaded") refresh();
    }, 4000);
    return () => clearInterval(interval);
  }, [refresh, row?.status]);

  const [reanalysing, setReanalysing] = useState(false);
  const reanalyse = async () => {
    if (reanalysing) return;
    setReanalysing(true);
    setError(null);
    // Optimistic flip so the in-line tracker shows immediately,
    // before the network round-trip + server flip lands.
    setRow(prev => prev ? { ...prev, status: "analysing", errorMessage: null } : prev);
    try {
      const result = await fetchJsonSafe(`/api/admin/compo/${id}/analyse`, { method: "POST" });
      // 202 + transient 5xx both treated as ok for re-analyse — the
      // endpoint flips status server-side before the orchestrator
      // even starts, so the next refresh will pick it up.
      if (!result.ok && !result.transient && result.status !== 202) {
        throw new Error(result.error);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await refresh();
    } finally {
      setReanalysing(false);
    }
  };

  const ocrText = row?.ocrText ?? "";
  const wrongWords = row?.wrongWords ?? [];

  const markedHtml = useMemo(() => renderMarked(ocrText, wrongWords), [ocrText, wrongWords]);
  const cleanHtml  = useMemo(() => renderClean(ocrText, wrongWords),  [ocrText, wrongWords]);

  // Client-side substitutions the user has applied via the popup
  // dropdown. Keyed by the original phrase text. Persists for this
  // page session only.
  const [substitutions, setSubstitutions] = useState<Map<string, string>>(new Map());
  const elevatedDraft = row?.recommendations?.elevatedDraft ?? "";
  const elevatedSwaps = row?.recommendations?.elevatedDraftSwaps ?? [];
  // Reset substitutions when the underlying draft changes (re-analyse).
  useEffect(() => { setSubstitutions(new Map()); }, [elevatedDraft]);

  if (!row && !error) return <p className="p-6 text-sm text-slate-500">Loading…</p>;
  if (error)         return <p className="p-6 text-sm text-red-600">{error}</p>;
  if (!row)          return null;

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-5">
      <div>
        <Link href="/admin/compo" className="text-sm text-slate-500 hover:underline">← 作文 Helper</Link>
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
              disabled={reanalysing || row.status === "analysing"}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {reanalysing || row.status === "analysing" ? "Re-analysing…" : "Re-analyse"}
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
          title={row.recommendations?.elevatedDraft ? "" : "Enhanced draft not generated yet"}
        >
          Enhanced to 35-40 (upgrades in green)
        </button>
      </div>

      <div className="grid grid-cols-3 gap-5">
        {/* Main composition view */}
        <div className="col-span-2">
          <h2 className="text-sm font-semibold text-slate-800 mb-2">作文</h2>
          {view === "elevated" ? (
            <div
              className="bg-white border border-slate-200 rounded-2xl p-6 text-base leading-loose whitespace-pre-wrap text-slate-900"
              style={{ fontFamily: "'Noto Serif SC', 'PingFang SC', 'Microsoft YaHei', serif" }}
            >
              <ElevatedDraftView
                draft={elevatedDraft}
                swaps={elevatedSwaps}
                substitutions={substitutions}
                onSubstitute={(orig, replacement) => {
                  setSubstitutions(prev => {
                    const next = new Map(prev);
                    if (replacement) next.set(orig, replacement);
                    else next.delete(orig);
                    return next;
                  });
                }}
              />
            </div>
          ) : (
            <div
              className="bg-white border border-slate-200 rounded-2xl p-6 text-base leading-loose whitespace-pre-wrap text-slate-900"
              style={{ fontFamily: "'Noto Serif SC', 'PingFang SC', 'Microsoft YaHei', serif" }}
              dangerouslySetInnerHTML={{ __html: view === "marked" ? markedHtml : cleanHtml }}
            />
          )}
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
          {row.critique && <CritiqueCard c={row.critique} r={row.recommendations} view={view} />}
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

// Parse a single [+...+] segment for an optional |bucket trailer.
// Returns { text, bucket } where bucket is null for un-tagged spans.
function parseMarkedSegment(seg: string): { text: string; bucket: string | null } {
  const m = seg.match(/^([\s\S]*)\|([a-z]+)$/);
  if (m) return { text: m[1], bucket: m[2] };
  return { text: seg, bucket: null };
}

// React component: renders the elevated draft with kid-words in
// default colour and AI insertions in bold green. Insertions tagged
// with a bucket (|opening, |idiom, etc.) become clickable buttons
// that open a popup with the current phrase's English meaning + a
// dropdown of context-fit alternatives. Picking an alternative
// substitutes the phrase in client state.
function ElevatedDraftView({
  draft,
  swaps,
  substitutions,
  onSubstitute,
}: {
  draft: string;
  swaps: PhraseSwap[];
  substitutions: Map<string, string>;
  onSubstitute: (originalText: string, replacement: string | null) => void;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  if (!draft) {
    return <em className="text-slate-400">Enhanced draft not generated yet.</em>;
  }
  const swapByText = new Map(swaps.map(s => [s.originalText, s] as const));
  const parts = draft.split(/\[\+([\s\S]*?)\+\]/);
  return (
    <>
      {parts.map((seg, i) => {
        if (i % 2 === 0) return <span key={i}>{seg}</span>;
        const { text, bucket } = parseMarkedSegment(seg);
        const swap = swapByText.get(text);
        const replacement = substitutions.get(text);
        const displayed = replacement ?? text;
        if (!bucket || !swap) {
          // Plain green-bold insertion — no alternatives, not clickable.
          return (
            <span key={i} style={{ color: "#047857", fontWeight: 700 }}>{displayed}</span>
          );
        }
        const key = `${i}-${text}`;
        const isOpen = openKey === key;
        return (
          <span key={i} style={{ position: "relative", display: "inline" }}>
            <button
              type="button"
              onClick={() => setOpenKey(isOpen ? null : key)}
              style={{
                color: "#047857",
                fontWeight: 700,
                background: replacement ? "#d1fae5" : "transparent",
                border: 0,
                borderBottom: "2px dotted #047857",
                cursor: "pointer",
                padding: "0 2px",
                font: "inherit",
              }}
              title={`${bucket}: click to see alternatives`}
            >
              {displayed}
            </button>
            {isOpen && (
              <PhrasePopup
                swap={swap}
                currentPick={replacement ?? null}
                onPick={(alt) => {
                  // Picking the same as original = remove substitution.
                  onSubstitute(text, alt && alt !== text ? alt : null);
                  setOpenKey(null);
                }}
                onClose={() => setOpenKey(null)}
              />
            )}
          </span>
        );
      })}
    </>
  );
}

function PhrasePopup({
  swap,
  currentPick,
  onPick,
  onClose,
}: {
  swap: PhraseSwap;
  currentPick: string | null;
  onPick: (cn: string | null) => void;
  onClose: () => void;
}) {
  // Click-outside to close.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest?.("[data-phrase-popup]") && !t.closest?.("button[title^=" + JSON.stringify(swap.bucket) + "]")) {
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose, swap.bucket]);
  return (
    <div
      data-phrase-popup
      style={{
        position: "absolute",
        top: "100%",
        left: 0,
        marginTop: 4,
        zIndex: 50,
        background: "white",
        border: "1px solid #cbd5e1",
        borderRadius: 8,
        boxShadow: "0 8px 20px rgba(0,0,0,0.12)",
        padding: 12,
        minWidth: 280,
        maxWidth: 420,
        fontSize: 13,
        fontWeight: 400,
        color: "#0f172a",
        whiteSpace: "normal",
        textAlign: "left",
      }}
    >
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", color: "#64748b", marginBottom: 4 }}>
        {swap.bucket}
        {swap.subType && (
          <span style={{ marginLeft: 6, textTransform: "none", letterSpacing: 0, color: "#94a3b8" }}>
            · {swap.subType}
          </span>
        )}
      </div>
      <div style={{ fontWeight: 600, color: "#047857" }}>{swap.originalText}</div>
      {swap.originalEn && <div style={{ fontStyle: "italic", color: "#475569", fontSize: 12, marginTop: 2 }}>{swap.originalEn}</div>}
      <div style={{ borderTop: "1px solid #e2e8f0", margin: "10px 0 6px" }} />
      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>
        {swap.alternatives.length} alternative{swap.alternatives.length === 1 ? "" : "s"}:
      </div>
      <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        {swap.alternatives.map((alt, idx) => {
          const isPicked = currentPick === alt.cn;
          return (
            <li key={idx}>
              <button
                type="button"
                onClick={() => onPick(alt.cn)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "6px 8px",
                  border: "1px solid " + (isPicked ? "#10b981" : "#e2e8f0"),
                  borderRadius: 6,
                  background: isPicked ? "#ecfdf5" : "white",
                  cursor: "pointer",
                  font: "inherit",
                }}
              >
                <div style={{ color: "#0f172a" }}>{alt.cn}</div>
                {alt.en && <div style={{ color: "#64748b", fontSize: 11, fontStyle: "italic", marginTop: 2 }}>{alt.en}</div>}
              </button>
            </li>
          );
        })}
      </ul>
      {currentPick && (
        <button
          type="button"
          onClick={() => onPick(null)}
          style={{
            marginTop: 8,
            fontSize: 11,
            color: "#64748b",
            background: "transparent",
            border: 0,
            cursor: "pointer",
            textDecoration: "underline",
          }}
        >
          Revert to original
        </button>
      )}
    </div>
  );
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
                          "Enhanced draft";
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

  // The current stage is the first field that hasn't been populated.
  // Show ONLY that line — no checklist, no carry-over.
  const ocrDone = !!row.ocrText && row.ocrText.length > 0;
  const wrongWordsDone = row.wrongWords !== null;
  const critiqueDone = row.critique !== null;
  const recsDone = row.recommendations !== null && row.recommendations.structural !== undefined;

  let stageNum = 1;
  let label = "Reading composition (OCR)…";
  if (ocrDone && !wrongWordsDone)        { stageNum = 2; label = "Scanning for 错别字 / 漏字 / 用词不当…"; }
  else if (wrongWordsDone && !critiqueDone) { stageNum = 3; label = "Scoring against the 40-mark rubric…"; }
  else if (critiqueDone && !recsDone)    { stageNum = 4; label = "Drafting structural + language recommendations…"; }
  else if (recsDone)                     { stageNum = 5; label = "Rewriting to the 35-40 target band…"; }

  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-sm text-amber-900">
        <span className="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
        <span className="font-medium">Stage {stageNum}/5</span>
        <span className="text-amber-800">— {label}</span>
      </div>
      <div className="text-xs text-amber-700 font-mono">{mm}:{ss}</div>
    </div>
  );
}

function CritiqueCard({
  c,
  r,
  view,
}: {
  c: Critique;
  r?: Recommendations | null;
  view: "marked" | "clean" | "elevated";
}) {
  // Pick the rubric breakdown for the active view. Falls back to the
  // original critique if the sub-breakdown isn't populated (older
  // rows pre-date cleanRewrite / elevatedDraftRubric).
  const active: RubricBreakdown =
    view === "elevated" ? (r?.elevatedDraftRubric ?? makeFallback(r?.elevatedDraftScore ?? c.overallScore)) :
    view === "clean"    ? (c.cleanRewrite ?? makeFallback(c.cleanRewriteScore ?? c.overallScore)) :
                          c;

  const panelLabel =
    view === "elevated" ? "Rubric — Enhanced draft" :
    view === "clean"    ? "Rubric — After corrections" :
                          "Rubric — As submitted";

  const deltaBadge =
    view !== "marked" && active.overallScore !== c.overallScore ? (
      <span className={`ml-2 text-[11px] font-semibold ${active.overallScore > c.overallScore ? "text-emerald-700" : "text-rose-700"}`}>
        {active.overallScore > c.overallScore ? "+" : ""}{(active.overallScore - c.overallScore).toFixed(1)} vs. original
      </span>
    ) : null;

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-800">{panelLabel}</h3>
        <div className="text-xl font-bold text-slate-900">
          {active.overallScore}<span className="text-slate-500 text-sm">/40</span>
          {deltaBadge}
        </div>
      </div>
      <div className="mt-3 space-y-3 text-sm">
        <div>
          <div className="flex justify-between font-medium text-slate-700">
            <span>内容 Content</span><span>{active.contentScore}/20</span>
          </div>
          <p className="text-slate-600 text-xs mt-0.5">{active.contentNotes}</p>
          {active.contentNotesEn && <p className="text-slate-500 text-xs italic mt-0.5">{active.contentNotesEn}</p>}
        </div>
        <div>
          <div className="flex justify-between font-medium text-slate-700">
            <span>词汇好句 Vocab &amp; phrases</span><span>{active.vocabScore}/10</span>
          </div>
          <p className="text-slate-600 text-xs mt-0.5">{active.vocabNotes}</p>
          {active.vocabNotesEn && <p className="text-slate-500 text-xs italic mt-0.5">{active.vocabNotesEn}</p>}
        </div>
        <div>
          <div className="flex justify-between font-medium text-slate-700">
            <span>句子结构 Sentence &amp; org</span><span>{active.sentenceScore}/10</span>
          </div>
          <p className="text-slate-600 text-xs mt-0.5">{active.sentenceNotes}</p>
          {active.sentenceNotesEn && <p className="text-slate-500 text-xs italic mt-0.5">{active.sentenceNotesEn}</p>}
        </div>

        {/* "Why this score" — for the Clean / Elevated views, surface
            the delta-vs-original explanation. For the Original view,
            show the overall summary as before. */}
        <div className="pt-3 border-t border-slate-100">
          {view === "marked" ? (
            <>
              <p className="text-xs text-slate-700 italic">{c.overallSummary}</p>
              {c.overallSummaryEn && <p className="text-[11px] text-slate-500 italic mt-0.5">{c.overallSummaryEn}</p>}
            </>
          ) : (
            <>
              <div className="text-[10px] uppercase tracking-wide text-emerald-700 font-semibold mb-1">
                Why this score
              </div>
              {active.whyChanged && <p className="text-xs text-slate-700">{active.whyChanged}</p>}
              {active.whyChangedEn && <p className="text-[11px] text-slate-500 italic mt-0.5">{active.whyChangedEn}</p>}
              {!active.whyChanged && !active.whyChangedEn && (
                <p className="text-xs text-slate-400 italic">
                  No detailed breakdown returned for this view — re-analyse to refresh.
                </p>
              )}
            </>
          )}
          {c.benchmarkYears.length > 0 && view === "marked" && (
            <p className="text-[10px] text-slate-400 mt-1">benchmarked vs PSLE {c.benchmarkYears.join(", ")}</p>
          )}
        </div>
      </div>
    </div>
  );
}

// Stub-out a RubricBreakdown when the AI didn't return one (older rows,
// fallback path). Caller picks the overall score; the axes are zeroed
// out so the UI doesn't lie about per-axis breakdowns it can't show.
function makeFallback(overallScore: number): RubricBreakdown {
  return {
    contentScore: 0, contentNotes: "", contentNotesEn: "",
    vocabScore: 0,   vocabNotes: "",   vocabNotesEn: "",
    sentenceScore: 0, sentenceNotes: "", sentenceNotesEn: "",
    overallScore,
  };
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
