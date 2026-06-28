"use client";

// Parent-facing composition detail page. Mirrors /admin/compo/[id]
// except: parent-themed colours, larger Score, no inline edit mode,
// no right-click alternatives, back link goes to /essay-coach list.

import { useEffect, useState, useCallback, useMemo, Suspense } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { fetchJsonSafe } from "@/lib/client-fetch";

const API_BASE = "/api/essay-coach";

// Chinese pipeline kinds (handwriting/字 issues) + English pipeline
// kinds (grammar/spelling/syntax). "awkward" is shared.
type WrongWord = {
  original: string;
  suggestion: string;
  kind:
    | "stroke" | "meaning" | "misuse" | "omission"
    | "spelling" | "grammar" | "word-choice" | "punctuation"
    | "awkward";
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
  cleanRewriteScore?: number;
  benchmarkYears: string[];
};

// English critique shape — stored in the same `critique` JSON column
// but with a different layout. Detect via `component` field presence.
type EnglishAxis = { score: number; max: number; notes: string };
type EnglishRubric = {
  component: "continuous" | "situational";
  primary: EnglishAxis;
  language: EnglishAxis;
  overallScore: number;
  whyChanged?: string;
};
type EnglishCritique = EnglishRubric & {
  overallSummary: string;
  cleanRewrite?: EnglishRubric;
  benchmarkYears: string[];
};
function isEnglishCritique(c: Critique | EnglishCritique | null | undefined): c is EnglishCritique {
  return !!c && typeof (c as EnglishCritique).component === "string";
}

type PhraseSwap = {
  originalText: string;
  bucket: string;
  subType?: string;
  originalEn: string;
  alternatives: Array<{ cn: string; en: string; pattern?: string }>;
};

type Recommendations = {
  structural: Array<{
    piece: string; pieceEn?: string;
    issue: string; issueEn?: string;
    suggestion: string; suggestionEn?: string;
    exampleFromModel?: { year: string; snippet: string; bucket?: string };
  }>;
  language: Array<{
    // English pipeline emits `phrase`; Chinese emits `phraseCn`.
    // Both renderers read `phrase ?? phraseCn`.
    phrase?: string;
    phraseCn?: string;
    phraseEn?: string;
    fromYear?: string;
    bucket?: string;
    whyItHelps: string;
  }>;
  elevatedDraft?: string;
  elevatedDraftScore?: number;
  // Chinese: RubricBreakdown shape. English: EnglishRubric shape.
  elevatedDraftRubric?: RubricBreakdown | EnglishRubric;
  elevatedDraftSwaps?: PhraseSwap[];
};

// Admin-only: saved cross-essay coaching tip (BatchCoachTip row).
// Surfaces in an expandable card above the view toggle when the
// signed-in user is admin AND there's at least one tip covering
// this attempt. Same shape as the admin compo detail page uses.
type BatchTipBucket = {
  title: string;
  titleEn?: string;
  color: "blue" | "emerald" | "amber" | "rose" | "violet" | "sky";
  advice: Array<{
    tip: string;
    tipEn?: string;
    why: string;
    whyEn?: string;
    examples: Array<{ from: string; before: string; after: string }>;
  }>;
};
type BatchTipAnalysis = {
  buckets: BatchTipBucket[];
  overview: string;
  overviewEn?: string;
  essaysAnalysed: number;
  language: "chinese" | "english" | "mixed";
};
type BatchTip = {
  id: string;
  createdAt: string;
  language: string | null;
  attemptIds: string[];
  analysis: BatchTipAnalysis;
};

type Row = {
  id: string;
  label: string | null;
  studentTopic: string | null;
  optionType: string | null;
  language: "chinese" | "english" | null;
  englishComponent: "continuous" | "situational" | null;
  status: "uploaded" | "analysing" | "ready" | "failed";
  errorMessage: string | null;
  compareToMarkings: boolean;
  ocrText: string | null;
  ocrTextWithMarkings: string | null;
  ocrQuestionText: string | null;
  wrongWords: WrongWord[] | null;
  critique: Critique | EnglishCritique | null;
  recommendations: Recommendations | null;
  analysedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export default function EssayCoachDetailPage() {
  return (
    <Suspense>
      <DetailContent />
    </Suspense>
  );
}

function DetailContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const id = params.id as string;
  const parentId = params.parentId as string;
  const studentQs = searchParams.get("student");
  const listHref = `/essay-coach/${parentId}${studentQs ? `?student=${studentQs}` : ""}`;

  const [row, setRow] = useState<Row | null>(null);
  const [tips, setTips] = useState<BatchTip[]>([]);
  const [view, setView] = useState<"marked" | "clean" | "elevated">("marked");
  const [error, setError] = useState<string | null>(null);
  const [reanalysing, setReanalysing] = useState(false);

  const refresh = useCallback(async () => {
    const result = await fetchJsonSafe<{ row: Row; tips?: BatchTip[] }>(`${API_BASE}/${id}`);
    if (result.ok) {
      setRow(result.data.row);
      setTips(result.data.tips ?? []);
      setError(prev => prev && prev.includes("restarting") ? null : prev);
    } else if (!result.transient) {
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

  const reanalyse = async () => {
    if (reanalysing) return;
    setReanalysing(true);
    setError(null);
    setRow(prev => prev ? {
      ...prev,
      status: "analysing",
      errorMessage: null,
      ocrText: null,
      ocrQuestionText: null,
      wrongWords: null,
      critique: null,
      recommendations: null,
    } : prev);
    try {
      const result = await fetchJsonSafe(`${API_BASE}/${id}/analyse`, { method: "POST" });
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
  const [highlight, setHighlight] = useState<"both" | "wrong" | "awkward">("both");
  const visibleForHighlight = useMemo(() => {
    if (highlight === "awkward") return wrongWords.filter(w => w.kind === "awkward");
    if (highlight === "wrong")   return wrongWords.filter(w =>
      w.kind === "stroke" || w.kind === "meaning" || w.kind === "misuse" || w.kind === "omission"
    );
    return wrongWords;
  }, [wrongWords, highlight]);

  const isEnglishRow = row?.language === "english";
  const markedHtml = useMemo(() => renderMarked(ocrText, visibleForHighlight, isEnglishRow), [ocrText, visibleForHighlight, isEnglishRow]);
  const cleanHtml  = useMemo(() => renderClean(ocrText, visibleForHighlight),  [ocrText, visibleForHighlight]);

  const elevatedDraft = row?.recommendations?.elevatedDraft ?? "";
  const elevatedSwaps = row?.recommendations?.elevatedDraftSwaps ?? [];
  const [substitutions, setSubstitutions] = useState<Map<string, string>>(new Map());
  useEffect(() => { setSubstitutions(new Map()); }, [elevatedDraft]);

  if (!row && !error) {
    return (
      <div className="min-h-screen bg-[#f8f9ff] flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-[#0040a0]" />
      </div>
    );
  }
  if (error) return <div className="min-h-screen bg-[#f8f9ff] p-6 text-sm text-red-700">{error}</div>;
  if (!row) return null;

  return (
    <div className="min-h-screen bg-[#f8f9ff]">
      <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-5">
        {/* Header */}
        <div>
          <Link
            href={listHref}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#0040a0] bg-[#eff4ff] hover:bg-[#dfe9ff] px-3 py-1.5 rounded-lg transition-colors print:hidden"
          >
            <span className="material-symbols-outlined text-base">arrow_back</span>
            <span>Back</span>
          </Link>
          {/* On mobile the title takes its own row above the action
              buttons so it isn't squashed by the right-side controls.
              From sm: side-by-side again. */}
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between mt-2 gap-3">
            <div className="min-w-0">
              <EditableLabel
                value={row.label}
                onSave={async (next) => {
                  const trimmed = next.trim();
                  const result = await fetchJsonSafe<{ row: Row }>(`${API_BASE}/${id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ label: trimmed.length === 0 ? null : trimmed }),
                  });
                  if (result.ok) setRow(result.data.row);
                  else setError(result.error);
                }}
              />
              {row.studentTopic && <p className="text-sm text-[#43474f] mt-0.5">{row.studentTopic}</p>}
              <p className="text-xs text-[#737780] mt-1">
                uploaded {new Date(row.createdAt).toLocaleString("en-SG", { dateStyle: "medium", timeStyle: "short" })}
                {row.analysedAt && <> · analysed {new Date(row.analysedAt).toLocaleString("en-SG", { dateStyle: "medium", timeStyle: "short" })}</>}
                {row.optionType && <> · {row.optionType}</>}
              </p>
            </div>
            <div className="flex flex-wrap gap-2 print:hidden sm:shrink-0">
              {/* Word / PDF / Delete are hidden while the analyser is
                  running — exporting an in-progress essay or deleting
                  it mid-run reads as a foot-gun. Re-analyse stays
                  visible (and double-purposes as the "Re-analysing…"
                  progress indicator). The orchestrator is fire-and-
                  forget on the server, so pressing back during the
                  run is safe — the pipeline keeps running and the
                  next visit picks up the latest state. */}
              {row.status === "ready" && (
                <>
                  <button
                    onClick={() => {
                      const url = `${API_BASE}/${id}/export-docx?view=${view}`;
                      window.location.href = url;
                    }}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#eff4ff] text-[#0040a0] hover:bg-[#dfe9ff]"
                    title="Download as Word"
                  >
                    Word
                  </button>
                  <button
                    onClick={() => {
                      const orig = document.title;
                      document.title = exportName(row.label, view);
                      setTimeout(() => {
                        window.print();
                        setTimeout(() => { document.title = orig; }, 1000);
                      }, 0);
                    }}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#eff4ff] text-[#0040a0] hover:bg-[#dfe9ff]"
                    title="Use 'Save as PDF' in the print dialog"
                  >
                    PDF
                  </button>
                </>
              )}
              {(() => {
                const STUCK_MS = 5 * 60 * 1000;
                const isAnalysing = row.status === "analysing";
                const ageMs = isAnalysing ? Date.now() - new Date(row.updatedAt).getTime() : 0;
                const isStuck = isAnalysing && ageMs > STUCK_MS;
                const disabled = reanalysing || (isAnalysing && !isStuck);
                const label =
                  reanalysing                ? "Re-analysing…" :
                  isStuck                    ? "Restart (stuck)" :
                  row.status === "analysing" ? "Re-analysing…" :
                                               "Re-analyse";
                const cls = isStuck
                  ? "px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-100 text-amber-800 hover:bg-amber-200"
                  : "px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#eff4ff] text-[#0040a0] hover:bg-[#dfe9ff] disabled:opacity-60 disabled:cursor-not-allowed";
                return (
                  <button onClick={reanalyse} disabled={disabled} className={cls}>
                    {label}
                  </button>
                );
              })()}
              {row.status === "ready" && (
                <button
                  onClick={async () => {
                    if (!confirm(`Delete '${row.label ?? "this essay"}'? Removes uploaded pages + AI output. Cannot be undone.`)) return;
                    const res = await fetchJsonSafe(`${API_BASE}/${id}`, { method: "DELETE" });
                    if (res.ok) window.location.href = listHref;
                    else setError(res.error);
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-50 text-red-700 hover:bg-red-100"
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        </div>

        {(row.status === "analysing" || row.status === "uploaded") && (
          <ProgressTracker row={row} />
        )}
        {row.status === "failed" && !reanalysing && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-800">
            <strong>Something went wrong:</strong> {row.errorMessage ?? "(no detail)"}. Tap <em>Re-analyse</em> to retry.
          </div>
        )}

        {/* Saved Lumi's tips that cover this attempt — admin only
            today (endpoint returns [] for non-admin). Collapsed by
            default; expanding reveals the bucketed advice. */}
        {tips.length > 0 && (
          <div className="space-y-2 print:hidden">
            {tips.map(t => <BatchTipCard key={t.id} tip={t} />)}
          </div>
        )}

        {/* View tabs — shortened labels + flex-1 on mobile so all
            three fit in a single row even on a narrow phone. From sm
            they go back to natural width. */}
        {row.status === "ready" && (
          <div className="flex gap-2 print:hidden">
            <button
              onClick={() => setView("marked")}
              className={`flex-1 sm:flex-none px-2 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm font-semibold ${view === "marked" ? "bg-[#001e40] text-white" : "bg-white border border-slate-300 text-[#001e40]"}`}
            >
              Original
            </button>
            <button
              onClick={() => setView("clean")}
              className={`flex-1 sm:flex-none px-2 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm font-semibold ${view === "clean" ? "bg-[#001e40] text-white" : "bg-white border border-slate-300 text-[#001e40]"}`}
            >
              Clean rewrite
            </button>
            <button
              onClick={() => setView("elevated")}
              disabled={!row.recommendations?.elevatedDraft}
              className={`flex-1 sm:flex-none px-2 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm font-semibold disabled:opacity-50 ${view === "elevated" ? "bg-[#001e40] text-white" : "bg-white border border-slate-300 text-[#001e40]"}`}
              title={row.recommendations?.elevatedDraft ? "" : "Enhanced draft not generated yet"}
            >
              Enhanced to 32-36 (upgrades in green)
            </button>
          </div>
        )}

        {/* English: drop the highlight filter altogether — the
            strikethrough + red-replacement inline is already enough.
            Chinese keeps the 3-way chip because awkward-phrasing
            rewrites are a separate category worth filtering. */}
        {view === "marked" && wrongWords.length > 0 && row.status === "ready" && row.language !== "english" && (
          <div className="flex items-center gap-2 flex-wrap print:hidden text-xs">
            <span className="text-[#43474f] font-medium">Highlight:</span>
            <button
              onClick={() => setHighlight("both")}
              className={`px-2.5 py-1 rounded-md font-semibold ${highlight === "both" ? "bg-[#001e40] text-white" : "bg-white border border-slate-300 text-[#43474f] hover:bg-slate-50"}`}
            >
              All
            </button>
            <button
              onClick={() => setHighlight("wrong")}
              className={`px-2.5 py-1 rounded-md font-semibold ${highlight === "wrong" ? "bg-rose-600 text-white" : "bg-white border border-slate-300 text-[#43474f] hover:bg-slate-50"}`}
            >
              Wrong words
            </button>
            <button
              onClick={() => setHighlight("awkward")}
              className={`px-2.5 py-1 rounded-md font-semibold ${highlight === "awkward" ? "bg-amber-600 text-white" : "bg-white border border-slate-300 text-[#43474f] hover:bg-slate-50"}`}
            >
              Awkward phrasing
            </button>
          </div>
        )}

        {row.status === "ready" && (() => { const isEnglish = row.language === "english"; const essayFont = isEnglish ? "'Georgia', 'Times New Roman', serif" : "'Noto Serif SC', 'PingFang SC', 'Microsoft YaHei', serif"; const essayHeading = isEnglish ? "Composition" : "作文"; return (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 print:grid-cols-1 print:gap-0">
            <div className="lg:col-span-2 print:col-span-1">
              <h2 className="text-sm font-semibold text-[#001e40] mb-2">{essayHeading}</h2>
              {view === "elevated" ? (
                <div
                  className="bg-white border border-slate-200 rounded-2xl p-6 text-base leading-loose whitespace-pre-wrap text-[#001e40]"
                  style={{ fontFamily: essayFont }}
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
                  className="bg-white border border-slate-200 rounded-2xl p-6 text-base leading-loose whitespace-pre-wrap text-[#001e40]"
                  style={{ fontFamily: essayFont }}
                  dangerouslySetInnerHTML={{ __html: view === "marked" ? markedHtml : cleanHtml }}
                />
              )}
              <WordCountFooter
                view={view}
                ocrText={ocrText}
                elevatedDraft={row?.recommendations?.elevatedDraft ?? null}
                isEnglish={isEnglish}
              />
              {row.compareToMarkings && row.ocrTextWithMarkings && (
                <div className="mt-4 print:hidden">
                  <div className="text-xs font-semibold text-amber-900 mb-2 flex items-center gap-2">
                    <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
                    Teacher-marked OCR (red/green corrections preserved)
                  </div>
                  <div
                    className="bg-amber-50/40 border border-amber-200 rounded-2xl p-5 text-sm leading-relaxed whitespace-pre-wrap text-[#001e40]"
                    style={{ fontFamily: essayFont }}
                    dangerouslySetInnerHTML={{ __html: renderMarkingsOcr(row.ocrTextWithMarkings) }}
                  />
                  <p className="mt-2 text-[11px] text-[#737780] italic">
                    ~~strikethrough~~ = teacher crossed out · <strong>bold</strong> = teacher added.
                  </p>
                </div>
              )}
            </div>

            <div className="lg:col-span-1 print:col-span-1 space-y-4 print:mt-12 print:space-y-8">
              {row.critique && (
                isEnglishCritique(row.critique)
                  ? <EnglishCritiqueCard c={row.critique} r={row.recommendations} view={view} />
                  : <CritiqueCard c={row.critique as Critique} r={row.recommendations} view={view} />
              )}
              {row.recommendations && <RecommendationsCard r={row.recommendations} />}
              {/* Wrong-words / awkward-phrase list is a critique of the
                  original draft — it has nothing to teach on the Clean
                  rewrite (errors already applied) or the Enhanced
                  draft (different prose entirely). Keep it on the
                  Original tab only. */}
              {view === "marked" && row.wrongWords && row.wrongWords.length > 0 && <WrongWordsCard ws={row.wrongWords} />}
            </div>
          </div>
        ); })()}
      </div>
    </div>
  );
}

// ─── Renderers (mirror of admin/compo) ──────────────────────────────

function renderMarkingsOcr(text: string): string {
  const re = /(~~[\s\S]+?~~)|(\*\*[\s\S]+?\*\*)|(\[[^\]]+\])/g;
  const out: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(escapeHtml(text.slice(last, m.index)));
    if (m[1]) {
      out.push(`<span style="color:#b91c1c;text-decoration:line-through">${escapeHtml(m[1].slice(2, -2))}</span>`);
    } else if (m[2]) {
      out.push(`<span style="color:#047857;font-weight:700">${escapeHtml(m[2].slice(2, -2))}</span>`);
    } else if (m[3]) {
      out.push(`<span style="color:#a16207;font-style:italic;font-size:0.85em">${escapeHtml(m[3])}</span>`);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(escapeHtml(text.slice(last)));
  return out.join("");
}

function exportName(label: string | null | undefined, view: "marked" | "clean" | "elevated"): string {
  const title = (label ?? "").trim() || "Composition";
  const suffix =
    view === "marked"   ? "v1: original" :
    view === "clean"    ? "v2: clean rewrite" :
                          "v3: enhanced";
  return `${title} ${suffix}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function diffSuggestion(original: string, suggestion: string): Array<{ char: string; isNew: boolean }> {
  const m = original.length;
  const n = suggestion.length;
  if (m === 0) return [...suggestion].map(c => ({ char: c, isNew: true }));
  if (n === 0) return [];
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (original[i - 1] === suggestion[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const out: Array<{ char: string; isNew: boolean }> = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (original[i - 1] === suggestion[j - 1]) { out.push({ char: suggestion[j - 1], isNew: false }); i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) { i--; }
    else { out.push({ char: suggestion[j - 1], isNew: true }); j--; }
  }
  while (j > 0) { out.push({ char: suggestion[j - 1], isNew: true }); j--; }
  return out.reverse();
}

function renderSuggestion(original: string, suggestion: string, kind: string | undefined, color: string): string {
  if (kind === "awkward") {
    return `<span style="color:${color};font-weight:700">${escapeHtml(suggestion)}</span>`;
  }
  const diff = diffSuggestion(original, suggestion);
  return diff.map(d => d.isNew
    ? `<strong style="color:${color}">${escapeHtml(d.char)}</strong>`
    : `<span style="color:${color}">${escapeHtml(d.char)}</span>`
  ).join("");
}

type Edit = { op: "keep" | "remove" | "insert"; char: string };
function diffEdits(original: string, suggestion: string): Edit[] {
  const m = original.length;
  const n = suggestion.length;
  if (m === 0) return [...suggestion].map(c => ({ op: "insert" as const, char: c }));
  if (n === 0) return [...original].map(c => ({ op: "remove" as const, char: c }));
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (original[i - 1] === suggestion[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const out: Edit[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (original[i - 1] === suggestion[j - 1]) {
      out.push({ op: "keep", char: original[i - 1] });
      i--; j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      out.push({ op: "remove", char: original[i - 1] });
      i--;
    } else {
      out.push({ op: "insert", char: suggestion[j - 1] });
      j--;
    }
  }
  while (i > 0) { out.push({ op: "remove", char: original[i - 1] }); i--; }
  while (j > 0) { out.push({ op: "insert", char: suggestion[j - 1] }); j--; }
  return out.reverse();
}

type Range = { start: number; end: number; original: string; suggestion: string; kind: string };

function findRanges(ocr: string, ws: WrongWord[]): Range[] {
  const sorted = [...ws].sort((a, b) => b.original.length - a.original.length);
  const ranges: Range[] = [];
  for (const w of sorted) {
    if (!w.original) continue;
    const idx = ocr.indexOf(w.original);
    if (idx < 0) continue;
    if (ranges.some(r => idx < r.end && idx + w.original.length > r.start)) continue;
    ranges.push({ start: idx, end: idx + w.original.length, original: w.original, suggestion: w.suggestion, kind: w.kind });
  }
  return ranges.sort((a, b) => a.start - b.start);
}

function renderMarked(ocr: string, ws: WrongWord[], isEnglish = false): string {
  const ranges = findRanges(ocr, ws);
  let out = "";
  let pos = 0;
  for (const r of ranges) {
    out += escapeHtml(ocr.slice(pos, r.start));
    // English ALWAYS uses whole-word strikethrough + bold replacement,
    // same as the "awkward" branch. The character-level diff with red
    // circles makes sense for Chinese (one wrong stroke in a 2-3 char
    // 词) but is noise on English words like "recieve" → "receive".
    if (isEnglish || r.kind === "awkward") {
      out += `<span style="color:#b91c1c;text-decoration:line-through">${escapeHtml(r.original)}</span>`;
      out += ` <span style="color:#b91c1c;font-weight:700">${escapeHtml(r.suggestion)}</span>`;
    } else {
      const edits = diffEdits(r.original, r.suggestion);
      for (const e of edits) {
        if (e.op === "keep") {
          out += escapeHtml(e.char);
        } else if (e.op === "remove") {
          out += `<span style="display:inline-block;border:1.5px solid #b91c1c;border-radius:50%;padding:0 3px;color:#b91c1c;line-height:1;margin:0 1px;vertical-align:baseline">${escapeHtml(e.char)}</span>`;
        } else {
          out += `<span style="color:#b91c1c;font-weight:700">${escapeHtml(e.char)}</span>`;
        }
      }
    }
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
    out += renderSuggestion(r.original, r.suggestion, r.kind, "#047857");
    pos = r.end;
  }
  out += escapeHtml(ocr.slice(pos));
  return out;
}

function parseMarkedSegment(seg: string): { text: string; bucket: string | null } {
  const m = seg.match(/^([\s\S]*)\|([a-z]+)$/);
  if (m) return { text: m[1], bucket: m[2] };
  return { text: seg, bucket: null };
}

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
  if (!draft) return <em className="text-slate-400">Enhanced draft not generated yet.</em>;
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
          return <span key={i} style={{ color: "#047857", fontWeight: 700 }}>{displayed}</span>;
        }
        const key = `${i}-${text}`;
        const isOpen = openKey === key;
        return (
          <span
            key={i}
            role="button"
            tabIndex={0}
            onClick={() => setOpenKey(isOpen ? null : key)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setOpenKey(isOpen ? null : key);
              }
            }}
            title="Tap to see alternatives"
            style={{
              color: "#047857",
              fontWeight: 700,
              background: replacement ? "#d1fae5" : "transparent",
              cursor: "pointer",
              textDecoration: "underline dotted #047857 2px",
              textUnderlineOffset: "3px",
              borderRadius: 2,
              padding: "0 1px",
              position: "relative",
            }}
          >
            {displayed}
            {isOpen && (
              <PhrasePopup
                swap={swap}
                currentPick={replacement ?? null}
                onPick={(alt) => {
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
  swap, currentPick, onPick, onClose,
}: {
  swap: PhraseSwap;
  currentPick: string | null;
  onPick: (cn: string | null) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest?.("[data-phrase-popup]") && !t.closest?.("[role=button][title='Tap to see alternatives']")) {
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);
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
                {alt.pattern && (
                  <div style={{ color: "#0369a1", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600, marginBottom: 2 }}>{alt.pattern}</div>
                )}
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

// ─── Helpers ───────────────────────────────────────────────────────

function stripMarkers(text: string): string {
  return text.replace(/\[\+([\s\S]*?)\+\]/g, (_m, body) =>
    body.replace(/\|[a-z]+$/, ""),
  );
}

function countChars(text: string): { cjk: number; total: number } {
  const cleaned = text.replace(/\s+/g, "");
  let cjk = 0;
  for (const c of text) {
    const code = c.codePointAt(0) ?? 0;
    if ((code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF)) cjk++;
  }
  return { cjk, total: cleaned.length };
}

// English word count: split on whitespace, drop empty tokens. We strip
// the [+...+] / |bucket markers FIRST when called on an elevated draft
// (that happens at the caller via stripMarkers).
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function WordCountFooter({
  view, ocrText, elevatedDraft, isEnglish,
}: {
  view: "marked" | "clean" | "elevated";
  ocrText: string;
  elevatedDraft: string | null;
  isEnglish: boolean;
}) {
  const currentLabel =
    view === "marked"   ? "Original (with errors marked)"  :
    view === "clean"    ? "Original (errors corrected)"    :
                          "Enhanced draft";

  if (isEnglish) {
    // English: words is the marker's primary signal. PSLE Continuous
    // Writing rubric calls 150 the minimum; 500-600 is the band where
    // top-band development can be shown.
    const originalWords = countWords(ocrText);
    const elevatedWords = elevatedDraft ? countWords(stripMarkers(elevatedDraft)) : null;
    const currentWords = view === "elevated" && elevatedWords != null ? elevatedWords : originalWords;
    const advice =
      currentWords < 150 ? "below the 150-word PSLE minimum — content can't be developed." :
      currentWords < 350 ? "shorter than the 500-600 word ideal — limits development for top-band scoring." :
      currentWords < 500 ? "slightly under the 500-600 word ideal — adding 1-2 paragraphs of description / dialogue would help reach the top band." :
      currentWords <= 700 ? "in the 500-700 word sweet spot for top-band scoring." :
      "comfortably above the ideal range.";
    return (
      <div className="mt-2 flex flex-col gap-1 text-[11px] text-[#737780] px-2">
        <span>
          <span className="font-semibold text-[#43474f]">{currentLabel}:</span>{" "}
          {currentWords} words
          {view === "elevated" && elevatedWords != null && (
            <span className="text-slate-400"> (original was {originalWords})</span>
          )}
        </span>
        <span className="italic">{advice}</span>
      </div>
    );
  }

  // Chinese: CJK character count remains the primary signal.
  const original = countChars(ocrText);
  const elevated = elevatedDraft ? countChars(stripMarkers(elevatedDraft)) : null;
  const current = view === "elevated" && elevated ? elevated : original;
  return (
    <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-[#737780] px-2">
      <span>
        <span className="font-semibold text-[#43474f]">{currentLabel}:</span>{" "}
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
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsedSec = Math.floor((now - startedAt) / 1000);
  const updatedAgeMs = now - new Date(row.updatedAt).getTime();
  const isStuck = row.status === "analysing" && updatedAgeMs > 5 * 60 * 1000;
  const mm = Math.floor(elapsedSec / 60);
  const ss = (elapsedSec % 60).toString().padStart(2, "0");
  const ocrDone = !!row.ocrText && row.ocrText.length > 0;
  const wrongWordsDone = row.wrongWords !== null;
  const critiqueDone = row.critique !== null;
  const recsDone = row.recommendations !== null && row.recommendations.structural !== undefined;

  const isEnglish = row.language === "english";
  let stageNum = 1;
  let label = "Pulling out the reading glasses… 🤓";
  if (ocrDone && !wrongWordsDone) {
    stageNum = 2;
    label = isEnglish ? "Hunting for sneaky typos… 🔍" : "Hunting for sneaky 错字… 🔍";
  } else if (wrongWordsDone && !critiqueDone) {
    stageNum = 3;
    label = isEnglish ? "Channeling our inner PSLE marker… ✍️" : "Channeling our inner 阅卷老师… ✍️";
  } else if (critiqueDone && !recsDone) {
    stageNum = 4;
    label = "Brainstorming upgrade ideas… 💡";
  } else if (recsDone) {
    stageNum = 5;
    label = isEnglish ? "Sprinkling some powerful phrases… ✨" : "Sprinkling some 好词好句 magic… ✨";
  }

  if (isStuck) {
    const stuckMins = Math.floor(updatedAgeMs / 60000);
    return (
      <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 space-y-1">
        <div className="flex items-center gap-2 text-sm text-rose-900 font-medium">
          <span>🛑 Stuck — no progress for {stuckMins} min.</span>
        </div>
        <div className="text-xs text-rose-700">Tap the amber <strong>Restart (stuck)</strong> button above to retry.</div>
      </div>
    );
  }
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-sm text-amber-900">
        <span className="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
        <span className="font-medium">Step {stageNum}/5</span>
        <span className="text-amber-800">— {label}</span>
      </div>
      <div className="text-xs text-amber-700 font-mono">{mm}:{ss}</div>
    </div>
  );
}

function CritiqueCard({
  c, r, view,
}: {
  c: Critique;
  r?: Recommendations | null;
  view: "marked" | "clean" | "elevated";
}) {
  // This card only runs for Chinese rows (caller branches via
  // isEnglishCritique). The elevatedDraftRubric union still includes
  // EnglishRubric, so cast back to the Chinese shape here.
  const elevatedChineseRubric = r?.elevatedDraftRubric as RubricBreakdown | undefined;
  const active: RubricBreakdown =
    view === "elevated" ? (elevatedChineseRubric ?? makeFallback(r?.elevatedDraftScore ?? c.overallScore)) :
    view === "clean"    ? (c.cleanRewrite ?? makeFallback(c.cleanRewriteScore ?? c.overallScore)) :
                          c;

  const panelLabel =
    view === "elevated" ? "Rubric — Enhanced draft" :
    view === "clean"    ? "Rubric — After corrections" :
                          "Rubric — As submitted";

  const deltaBadge =
    view !== "marked" && active.overallScore !== c.overallScore ? (
      <span className={`ml-2 text-xs font-semibold ${active.overallScore > c.overallScore ? "text-emerald-700" : "text-rose-700"}`}>
        {active.overallScore > c.overallScore ? "+" : ""}{(active.overallScore - c.overallScore).toFixed(1)} vs. original
      </span>
    ) : null;

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-[#001e40]">{panelLabel}</h3>
        {/* Score is the headline number — parents asked for it bigger. */}
        <div className="text-3xl font-extrabold text-[#001e40] leading-none">
          {active.overallScore}<span className="text-[#737780] text-base font-bold">/40</span>
          <span className="text-[#737780] text-base font-bold ml-1.5">({Math.round((active.overallScore / 40) * 100)}%)</span>
        </div>
      </div>
      {deltaBadge && <div className="mt-1 text-right">{deltaBadge}</div>}
      <div className="mt-3 space-y-3 text-sm">
        {!isFallbackRubric(active) && (
          <>
            <div>
              <div className="flex justify-between font-medium text-[#43474f]">
                <span>内容 Content</span><span>{active.contentScore}/20</span>
              </div>
              <p className="text-[#43474f] text-xs mt-0.5">{active.contentNotes}</p>
              {active.contentNotesEn && <p className="text-[#737780] text-xs italic mt-0.5">{active.contentNotesEn}</p>}
            </div>
            <div>
              <div className="flex justify-between font-medium text-[#43474f]">
                <span>词汇好句 Vocab &amp; phrases</span><span>{active.vocabScore}/10</span>
              </div>
              <p className="text-[#43474f] text-xs mt-0.5">{active.vocabNotes}</p>
              {active.vocabNotesEn && <p className="text-[#737780] text-xs italic mt-0.5">{active.vocabNotesEn}</p>}
            </div>
            <div>
              <div className="flex justify-between font-medium text-[#43474f]">
                <span>句子结构 Sentence &amp; org</span><span>{active.sentenceScore}/10</span>
              </div>
              <p className="text-[#43474f] text-xs mt-0.5">{active.sentenceNotes}</p>
              {active.sentenceNotesEn && <p className="text-[#737780] text-xs italic mt-0.5">{active.sentenceNotesEn}</p>}
            </div>
          </>
        )}

        <div className="pt-3 border-t border-slate-100">
          {view === "marked" ? (
            <>
              <p className="text-xs text-[#43474f] italic">{c.overallSummary}</p>
              {c.overallSummaryEn && <p className="text-[11px] text-[#737780] italic mt-0.5">{c.overallSummaryEn}</p>}
            </>
          ) : (
            <>
              <div className="text-[10px] uppercase tracking-wide text-emerald-700 font-semibold mb-1">
                Why this score
              </div>
              {active.whyChanged && <p className="text-xs text-[#43474f]">{active.whyChanged}</p>}
              {active.whyChangedEn && <p className="text-[11px] text-[#737780] italic mt-0.5">{active.whyChangedEn}</p>}
              {!active.whyChanged && !active.whyChangedEn && (
                <p className="text-xs text-[#737780] italic">
                  No detailed breakdown returned for this view — re-analyse to refresh.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// English-pipeline critique renderer. Two axes only — primary is
// either "Content" (Continuous) or "Task fulfilment" (Situational).
// Total max is /36 for Continuous, /14 for Situational. The Chinese
// equivalent above stays unchanged.
function EnglishCritiqueCard({
  c, r, view,
}: {
  c: EnglishCritique;
  r?: Recommendations | null;
  view: "marked" | "clean" | "elevated";
}) {
  const primaryLabel = c.component === "continuous" ? "Content" : "Task fulfilment";
  // recommendations.elevatedDraftRubric — when row came from English
  // pipeline this is an EnglishRubric; the cast is safe because both
  // are stored in the same JSON column.
  const elevatedRubric = r?.elevatedDraftRubric as unknown as EnglishRubric | undefined;
  const fallback = (overall: number): EnglishRubric => ({
    component: c.component,
    primary: { score: 0, max: c.primary.max, notes: "" },
    language: { score: 0, max: c.language.max, notes: "" },
    overallScore: overall,
  });
  const active: EnglishRubric =
    view === "elevated" ? (elevatedRubric ?? fallback(Number(r?.elevatedDraftScore ?? c.overallScore))) :
    view === "clean"    ? (c.cleanRewrite ?? fallback(Number(c.overallScore))) :
                          c;
  const overallMax = c.primary.max + c.language.max;
  const panelLabel =
    view === "elevated" ? "Rubric — Enhanced draft" :
    view === "clean"    ? "Rubric — After corrections" :
                          "Rubric — As submitted";
  const deltaBadge =
    view !== "marked" && active.overallScore !== c.overallScore ? (
      <span className={`ml-2 text-xs font-semibold ${active.overallScore > c.overallScore ? "text-emerald-700" : "text-rose-700"}`}>
        {active.overallScore > c.overallScore ? "+" : ""}{(active.overallScore - c.overallScore).toFixed(1)} vs. original
      </span>
    ) : null;
  const isFallback = active.primary.score === 0 && active.language.score === 0 && !active.primary.notes && !active.language.notes;
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-[#001e40]">{panelLabel}</h3>
        <div className="text-3xl font-extrabold text-[#001e40] leading-none">
          {active.overallScore}<span className="text-[#737780] text-base font-bold">/{overallMax}</span>
          <span className="text-[#737780] text-base font-bold ml-1.5">({Math.round((active.overallScore / overallMax) * 100)}%)</span>
        </div>
      </div>
      {deltaBadge && <div className="mt-1 text-right">{deltaBadge}</div>}
      <div className="mt-3 space-y-3 text-sm">
        {!isFallback && (
          <>
            <div>
              <div className="flex justify-between font-medium text-[#43474f]">
                <span>{primaryLabel}</span><span>{active.primary.score}/{active.primary.max}</span>
              </div>
              <p className="text-[#43474f] text-xs mt-0.5">{active.primary.notes}</p>
            </div>
            <div>
              <div className="flex justify-between font-medium text-[#43474f]">
                <span>Language</span><span>{active.language.score}/{active.language.max}</span>
              </div>
              <p className="text-[#43474f] text-xs mt-0.5">{active.language.notes}</p>
            </div>
          </>
        )}
        <div className="pt-3 border-t border-slate-100">
          {view === "marked" ? (
            <p className="text-xs text-[#43474f] italic">{c.overallSummary}</p>
          ) : (
            <>
              <div className="text-[10px] uppercase tracking-wide text-emerald-700 font-semibold mb-1">
                Why this score
              </div>
              {active.whyChanged
                ? <p className="text-xs text-[#43474f]">{active.whyChanged}</p>
                : <p className="text-xs text-[#737780] italic">No detailed breakdown returned for this view — re-analyse to refresh.</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function makeFallback(overallScore: number): RubricBreakdown {
  return {
    contentScore: 0, contentNotes: "", contentNotesEn: "",
    vocabScore: 0,   vocabNotes: "",   vocabNotesEn: "",
    sentenceScore: 0, sentenceNotes: "", sentenceNotesEn: "",
    overallScore,
  };
}

function isFallbackRubric(r: RubricBreakdown): boolean {
  return r.contentScore === 0 && r.vocabScore === 0 && r.sentenceScore === 0
    && !r.contentNotes && !r.vocabNotes && !r.sentenceNotes;
}

function RecommendationsCard({ r }: { r: Recommendations }) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
      <h3 className="text-sm font-semibold text-[#001e40]">Recommendations</h3>
      {r.structural.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-[#737780] uppercase tracking-wide mb-1">Structure</h4>
          <ul className="space-y-2 text-sm">
            {r.structural.map((s, i) => (
              <li key={i} className="bg-amber-50 border border-amber-100 rounded-lg px-2 py-2">
                <div className="font-medium text-[#001e40]">
                  {s.piece}
                  {s.pieceEn && <span className="ml-1.5 text-[#737780] font-normal italic">— {s.pieceEn}</span>}
                </div>
                <div className="text-xs text-[#43474f]">{s.issue}</div>
                {s.issueEn && <div className="text-xs text-[#737780] italic">{s.issueEn}</div>}
                <div className="text-xs text-[#43474f] mt-1"><em>→ {s.suggestion}</em></div>
                {s.suggestionEn && <div className="text-xs text-[#737780] italic mt-0.5">→ {s.suggestionEn}</div>}
                {s.exampleFromModel && (
                  <div className="text-xs text-[#737780] mt-1 italic">
                    「{s.exampleFromModel.snippet}」
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {r.language.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-[#737780] uppercase tracking-wide mb-1">Language upgrades</h4>
          <ul className="space-y-2 text-sm">
            {r.language.map((l, i) => (
              <li key={i} className="bg-emerald-50 border border-emerald-100 rounded-lg px-2 py-2">
                <div className="font-medium text-emerald-900">{l.phrase ?? l.phraseCn}</div>
                {l.phraseEn && <div className="text-xs text-[#737780]">{l.phraseEn}</div>}
                <div className="text-xs text-[#43474f] mt-1">{l.whyItHelps}</div>
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
      <h3 className="text-sm font-semibold text-[#001e40]">Wrong words / Awkward phrase ({ws.length})</h3>
      <ul className="mt-2 space-y-1 text-sm">
        {ws.map((w, i) => (
          <li key={i} className="flex items-baseline gap-2">
            <span className="text-red-700 line-through font-medium">{w.original}</span>
            <span className="text-[#737780]">→</span>
            <span
              className="text-emerald-700"
              dangerouslySetInnerHTML={{ __html: renderSuggestion(w.original, w.suggestion, w.kind, "#047857") }}
            />
            <span className="text-[10px] text-[#737780] ml-1">{w.kind}</span>
            <span className="text-xs text-[#43474f] ml-auto">{w.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Inline-editable label — same UX pattern as the admin compo detail
// page: click to turn the heading into a textarea; Enter / blur saves
// via the parent's onSave (which PATCHes /api/essay-coach/[id]);
// Escape reverts. Styled in the parent-app palette so it sits flush
// with the rest of the header.
function EditableLabel({
  value,
  onSave,
}: {
  value: string | null;
  onSave: (next: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  // Keep draft in sync when the row refreshes from the server, but
  // never stomp the user's in-flight typing.
  useEffect(() => { if (!editing) setDraft(value ?? ""); }, [value, editing]);

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter")  { e.preventDefault(); setEditing(false); void onSave(draft); }
          if (e.key === "Escape") { e.preventDefault(); setEditing(false); setDraft(value ?? ""); }
        }}
        onBlur={() => { setEditing(false); if (draft !== (value ?? "")) void onSave(draft); }}
        placeholder="Label this composition"
        className="text-xl sm:text-2xl font-extrabold text-[#001e40] bg-yellow-50 border-b-2 border-yellow-400 outline-none w-full max-w-lg px-1"
      />
    );
  }
  const isEmpty = !value;
  return (
    <h1
      onClick={() => setEditing(true)}
      className={`text-xl sm:text-2xl font-extrabold cursor-text hover:bg-slate-50 rounded px-1 -ml-1 inline-block break-words ${isEmpty ? "text-[#737780] italic" : "text-[#001e40]"}`}
      title="Click to edit"
    >
      {value ?? "(no label — tap to add)"}
    </h1>
  );
}

// Saved cross-essay coaching tip — collapsed by default. Same shape
// as the admin compo detail page renders. Click the header to expand
// and read the bucketed advice.
const BATCH_TIP_PALETTE: Record<BatchTipBucket["color"], { border: string; headerBg: string; headerText: string; chip: string }> = {
  blue:    { border: "border-blue-200",    headerBg: "bg-blue-50",    headerText: "text-blue-900",    chip: "bg-blue-100 text-blue-800" },
  emerald: { border: "border-emerald-200", headerBg: "bg-emerald-50", headerText: "text-emerald-900", chip: "bg-emerald-100 text-emerald-800" },
  amber:   { border: "border-amber-200",   headerBg: "bg-amber-50",   headerText: "text-amber-900",   chip: "bg-amber-100 text-amber-800" },
  rose:    { border: "border-rose-200",    headerBg: "bg-rose-50",    headerText: "text-rose-900",    chip: "bg-rose-100 text-rose-800" },
  violet:  { border: "border-violet-200",  headerBg: "bg-violet-50",  headerText: "text-violet-900",  chip: "bg-violet-100 text-violet-800" },
  sky:     { border: "border-sky-200",     headerBg: "bg-sky-50",     headerText: "text-sky-900",     chip: "bg-sky-100 text-sky-800" },
};
function BatchTipCard({ tip }: { tip: BatchTip }) {
  const [open, setOpen] = useState(false);
  const a = tip.analysis;
  const isChinese = (tip.language ?? "english") === "chinese";
  return (
    <div className="bg-white border-2 border-violet-200 rounded-2xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full px-4 py-3 flex items-center justify-between gap-3 hover:bg-violet-50 transition-colors text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wide font-bold text-violet-700">
            {isChinese ? "Lumi 的建议" : "Lumi's tip"} ({a.essaysAnalysed} {isChinese ? "篇作文" : `essay${a.essaysAnalysed === 1 ? "" : "s"}`})
          </div>
          {a.overview && (
            <p className="text-sm text-[#001e40] mt-0.5 line-clamp-2" style={isChinese ? { fontFamily: "'Noto Serif SC', 'PingFang SC', 'Microsoft YaHei', serif" } : undefined}>
              {a.overview}
            </p>
          )}
        </div>
        <span className="text-violet-600 text-lg shrink-0">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-violet-100 pt-3">
          <div className="flex items-center justify-between gap-2 text-xs text-[#737780]">
            <span>Saved {new Date(tip.createdAt).toLocaleString("en-SG", { dateStyle: "medium", timeStyle: "short" })}</span>
            <a
              href={`/print/batch-tip/${tip.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700"
            >
              🖨 Print this
            </a>
          </div>
          {a.overviewEn && a.overviewEn !== a.overview && (
            <p className="text-xs text-[#737780] italic">{a.overviewEn}</p>
          )}
          <div className="space-y-3">
            {a.buckets.map((b, bi) => {
              const palette = BATCH_TIP_PALETTE[b.color] ?? BATCH_TIP_PALETTE.blue;
              return (
                <div key={bi} className={`border ${palette.border} rounded-xl overflow-hidden`}>
                  <div className={`${palette.headerBg} px-4 py-2 flex items-center justify-between gap-2`}>
                    <div className="min-w-0">
                      <h4 className={`font-bold text-sm ${palette.headerText}`}>{b.title}</h4>
                      {b.titleEn && b.titleEn !== b.title && (
                        <div className="text-[10px] text-slate-500 font-medium mt-0.5">{b.titleEn}</div>
                      )}
                    </div>
                    <span className={`text-[10px] font-semibold uppercase tracking-wide ${palette.chip} px-2 py-0.5 rounded shrink-0`}>
                      {b.advice.length} {isChinese ? "条" : `tip${b.advice.length === 1 ? "" : "s"}`}
                    </span>
                  </div>
                  <div className="px-4 py-3 space-y-3 bg-white">
                    {b.advice.map((adv, ai) => (
                      <div key={ai}>
                        <div className="text-sm font-bold text-[#001e40]">{adv.tip}</div>
                        {adv.tipEn && adv.tipEn !== adv.tip && (
                          <div className="text-xs text-slate-500 mt-0.5">{adv.tipEn}</div>
                        )}
                        {adv.why && <p className="text-xs text-[#43474f] mt-1">{adv.why}</p>}
                        {adv.whyEn && adv.whyEn !== adv.why && (
                          <p className="text-[11px] text-slate-400 italic mt-0.5">{adv.whyEn}</p>
                        )}
                        {adv.examples.length > 0 && (
                          <div className="mt-2 space-y-1.5">
                            {adv.examples.map((e, ei) => (
                              <div key={ei} className="text-xs bg-slate-50 rounded-md px-2.5 py-2 space-y-1">
                                {e.from && <div className="text-[10px] text-[#737780] uppercase tracking-wide">{e.from}</div>}
                                <div className="flex items-start gap-1.5">
                                  <span className="text-rose-500 font-bold shrink-0">−</span>
                                  <span className="text-[#43474f] italic">&ldquo;{e.before}&rdquo;</span>
                                </div>
                                <div className="flex items-start gap-1.5">
                                  <span className="text-emerald-600 font-bold shrink-0">+</span>
                                  <span className="text-[#001e40] font-medium">&ldquo;{e.after}&rdquo;</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
