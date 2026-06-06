"use client";

import { useState } from "react";
import { ExamPaperDetail, ExamQuestionItem } from "@/types";
import ImageCropModal from "./ImageCropModal";

interface Props {
  paper: ExamPaperDetail;
  pageImages: string[];
  onSave: (questionId: string, data: Record<string, unknown>) => Promise<void>;
  onDelete?: (questionId: string) => void;
  onSaveOcr?: (sectionName: string, ocrText: string) => Promise<void>;
  onRegenerateOcr?: (sectionName: string) => Promise<void>;
  saving: string | null;
}

// Group questions by syllabusTopic into sections
type SectionOcrEntry = { ocrText?: string; pageIndices?: number[]; passagePageIndices?: number[]; passageOcrText?: string };

/** Group questions by section.
 *
 *  Default behaviour (English / Math / Science): one entry per
 *  distinct syllabusTopic — unchanged from the original.
 *
 *  When sectionOcrTexts contains MULTIPLE keys for the same base
 *  syllabusTopic (e.g. Chinese "阅读理解 MCQ" + "阅读理解 MCQ
 *  (pp10-10)" from the 五-A split, or two 阅读理解 OEQ entries
 *  for A组 and B组), split the topic group by pageIndex: each
 *  OCR key gets the questions whose pageIndex falls inside its
 *  pageIndices. Each split renders as its own collapsible section
 *  with its own passage. Without this, only the first ocr-key
 *  entry was matched and the second passage/sub-section silently
 *  disappeared from /edit.
 *
 *  sectionOcrTexts is optional — when missing, fall back to the
 *  default per-topic grouping. */
function groupBySection(
  questions: ExamQuestionItem[],
  sectionOcrTexts?: Record<string, SectionOcrEntry>,
): Array<{ name: string; ocrKey: string; questions: ExamQuestionItem[] }> {
  const sections: Array<{ name: string; ocrKey: string; questions: ExamQuestionItem[] }> = [];
  const sectionMap = new Map<string, ExamQuestionItem[]>();
  const order: string[] = [];
  for (const q of questions) {
    const topic = q.syllabusTopic || "Other";
    if (!sectionMap.has(topic)) {
      sectionMap.set(topic, []);
      order.push(topic);
    }
    sectionMap.get(topic)!.push(q);
  }

  // Map each topic to its candidate OCR keys (exact match + "Topic (pp…)" suffix dedup).
  function keysForTopic(topic: string): string[] {
    if (!sectionOcrTexts) return [topic];
    const exact = Object.keys(sectionOcrTexts).filter(k => k === topic);
    const suffixed = Object.keys(sectionOcrTexts).filter(k => k.startsWith(`${topic} (pp`) || k.startsWith(`${topic} (dup`));
    return [...exact, ...suffixed];
  }

  for (const topic of order) {
    const groupQs = sectionMap.get(topic)!;
    const candidateKeys = keysForTopic(topic);

    if (candidateKeys.length <= 1) {
      sections.push({ name: topic, ocrKey: candidateKeys[0] ?? topic, questions: groupQs });
      continue;
    }

    // Multi-key topic — split by pageIndex overlap with each key's pageIndices.
    const claimed = new Set<string>();
    for (const key of candidateKeys) {
      const pageSet = new Set((sectionOcrTexts![key]?.pageIndices ?? []) as number[]);
      const matching = groupQs.filter(q => !claimed.has(q.id) && pageSet.has(q.pageIndex));
      for (const q of matching) claimed.add(q.id);
      if (matching.length > 0) {
        sections.push({ name: topic, ocrKey: key, questions: matching });
      }
    }
    // Leftovers — questions whose pageIndex didn't match any key's pageIndices.
    const leftovers = groupQs.filter(q => !claimed.has(q.id));
    if (leftovers.length > 0) {
      // Append to the first split (or as its own block when no splits matched).
      const firstSplit = sections.find(s => s.name === topic);
      if (firstSplit) firstSplit.questions.push(...leftovers);
      else sections.push({ name: topic, ocrKey: candidateKeys[0] ?? topic, questions: leftovers });
    }
  }
  // After splits, sections built from a topic that appears in TWO
  // non-contiguous spans (e.g. Chinese 阅读理解 MCQ at section 三
  // and again at section 五-A, with 完成对话 in between) get pushed
  // in topic-order, not paper order. Re-sort by the first question's
  // orderIndex so the UI matches the printed paper sequence.
  sections.sort((a, b) => {
    const aFirst = a.questions[0]?.orderIndex ?? 0;
    const bFirst = b.questions[0]?.orderIndex ?? 0;
    return aFirst - bFirst;
  });
  return sections;
}

// For Chinese papers we GROUP from the chineseSections metadata
// instead of per-question syllabusTopic — the metadata already has
// the user-facing layout (e.g. 阅读理解 A merges Q30-32 MCQ + Q33
// OEQ on shared passage A). Per-question syllabusTopic would split
// Q33 into its own 阅读理解 OEQ block, which doesn't match what the
// quiz renders.
type ChineseSecMeta = { label: string; startIndex: number; endIndex: number; passage?: string; passageImageData?: string };
function groupFromChineseMetadata(
  questions: ExamQuestionItem[],
  chineseSections: ChineseSecMeta[],
  sectionOcrTexts?: Record<string, SectionOcrEntry>,
): Array<{ name: string; ocrKey: string; questions: ExamQuestionItem[] }> {
  const out: Array<{ name: string; ocrKey: string; questions: ExamQuestionItem[] }> = [];
  for (const sec of chineseSections) {
    const qs = questions.slice(sec.startIndex, sec.endIndex + 1);
    if (qs.length === 0) continue;
    // Find the OCR key. Priority order:
    //   1. Among all keys whose label matches this section's
    //      syllabusTopic (or our renamed label), pick the one whose
    //      pageIndices overlap THIS section's question pages. Critical
    //      for 阅读理解 A — its underlying topic is 阅读理解 MCQ,
    //      which matches TWO OCR keys (section 三 on page 7 and
    //      五-A on page 10). Without the page overlap check the
    //      naive "first match wins" picks section 三's OCR and the
    //      /edit view shows Q21-25 text under 五-A.
    //   2. Exact section.label match (covers 短文填空 / 完成对话 /
    //      语文应用 MCQ where there's only one OCR key per topic).
    //   3. Exact match for the question's syllabusTopic (last-resort
    //      single key with no page-index data).
    const ocrKeys = Object.keys(sectionOcrTexts ?? {});
    const firstTopic = qs[0].syllabusTopic ?? "";
    const pageSet = new Set(qs.map(q => q.pageIndex));
    let ocrKey: string | null = null;
    // Step 1: page-overlap match among candidate keys for this topic.
    if (firstTopic) {
      const candidates = ocrKeys.filter(k => k === firstTopic || k.startsWith(firstTopic + " ("));
      for (const k of candidates) {
        const pi = (sectionOcrTexts?.[k]?.pageIndices ?? []) as number[];
        if (pi.some(p => pageSet.has(p))) { ocrKey = k; break; }
      }
    }
    // Step 2: exact label match.
    if (!ocrKey && ocrKeys.includes(sec.label)) ocrKey = sec.label;
    // Step 3: exact topic match (no page data).
    if (!ocrKey && firstTopic && ocrKeys.includes(firstTopic)) ocrKey = firstTopic;
    out.push({ name: sec.label, ocrKey: ocrKey ?? sec.label, questions: qs });
  }
  return out;
}

export default function EnglishEditView({ paper, pageImages, onSave, onDelete, onSaveOcr, onRegenerateOcr, saving }: Props) {
  const metadata = paper.metadata;
  const ocrTexts = metadata?.sectionOcrTexts ?? {};
  const auditFlags = ((metadata as { auditFlags?: Record<string, string> } | null)?.auditFlags ?? {}) as Record<string, string>;
  // Chinese papers: route through the metadata-driven grouping so the
  // edit view matches what the quiz renders (merged 阅读理解 A etc.).
  // English papers keep the syllabusTopic-based grouping unchanged.
  const chineseSections = (metadata as { chineseSections?: ChineseSecMeta[] } | null)?.chineseSections;
  const sections = chineseSections
    ? groupFromChineseMetadata(paper.questions, chineseSections, ocrTexts)
    : groupBySection(paper.questions, ocrTexts);

  const [expandedSection, setExpandedSection] = useState<string | null>(sections[0]?.name ?? null);
  const [editingOcr, setEditingOcr] = useState<string | null>(null);
  const [ocrDrafts, setOcrDrafts] = useState<Record<string, string>>({});
  const [editingPassage, setEditingPassage] = useState<string | null>(null);
  const [passageDrafts, setPassageDrafts] = useState<Record<string, string>>({});
  const [reextractPages, setReextractPages] = useState<Record<string, string>>({});
  const [reextracting, setReextracting] = useState<string | null>(null);
  const [reextractResult, setReextractResult] = useState<Record<string, string>>({});
  const [passagePages, setPassagePages] = useState<Record<string, string>>({});
  const [reextractingPassage, setReextractingPassage] = useState<string | null>(null);
  const [passageResult, setPassageResult] = useState<Record<string, string>>({});
  // Cropped-passage-image upload (Chinese 阅读理解 sections with
  // infographics that don't OCR well as text). When set, the section's
  // metadata.chineseSections[i].passageImageData carries a data URL
  // and the OCR-text panel hides in favour of the image.
  const [uploadingPassageImage, setUploadingPassageImage] = useState<string | null>(null);
  const [passageImageError, setPassageImageError] = useState<Record<string, string>>({});

  // OCR audit (Chinese papers only): client kicks /api/exam/[id]/audit-ocr
  // which re-OCRs each section's first page with 2.5-pro and asks a vision
  // judge to list the transcription errors in the existing flash output.
  type AuditError = { snippet: string; correction: string; note: string };
  type AuditJudge = { winner: string; errors_in_a: AuditError[]; errors_in_b: AuditError[]; summary: string };
  type AuditFinding = { sectionLabel: string; pageIndex: number; distance: number; skipped?: string; judge?: AuditJudge | null };
  const [auditRunning, setAuditRunning] = useState(false);
  const [auditFindings, setAuditFindings] = useState<AuditFinding[] | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);

  const isChinesePaper = ((paper.subject ?? "") as string).toLowerCase().includes("chinese");

  async function runOcrAudit() {
    setAuditRunning(true);
    setAuditError(null);
    setAuditFindings(null);
    try {
      const res = await fetch(`/api/exam/${paper.id}/audit-ocr`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setAuditError(data.error ?? "Audit failed");
      } else {
        setAuditFindings(data.findings ?? []);
      }
    } catch (err) {
      setAuditError((err as Error).message);
    } finally {
      setAuditRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* OCR audit panel — Chinese papers only. Shows a button that
          runs /api/exam/[id]/audit-ocr and then surfaces the specific
          transcription errors the vision judge identified. */}
      {isChinesePaper && (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-slate-800">OCR Audit (2.5-pro vs current)</p>
              <p className="text-xs text-slate-400">Re-OCRs each section with 2.5-pro and asks a vision judge to list transcription errors in the current OCR. Read-only.</p>
            </div>
            <button
              onClick={runOcrAudit}
              disabled={auditRunning}
              className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400"
            >
              {auditRunning ? "Auditing…" : (auditFindings ? "Re-run Audit" : "Run OCR Audit")}
            </button>
          </div>
          {auditError && (
            <p className="mt-3 text-xs text-rose-600">{auditError}</p>
          )}
          {auditFindings && auditFindings.length > 0 && (() => {
            const withErrors = auditFindings.filter(f => (f.judge?.errors_in_a?.length ?? 0) > 0);
            const clean = auditFindings.length - withErrors.length;
            return (
              <div className="mt-4 space-y-3">
                <p className="text-xs font-bold uppercase tracking-wider text-slate-500">
                  {withErrors.length} section{withErrors.length === 1 ? "" : "s"} with transcription errors · {clean} clean
                </p>
                {withErrors.length === 0 ? (
                  <p className="text-xs text-emerald-700 bg-emerald-50 rounded-lg px-3 py-2">No transcription errors detected by the judge.</p>
                ) : (
                  <ul className="space-y-2">
                    {withErrors.map(f => (
                      <li key={f.sectionLabel} className="border border-amber-200 bg-amber-50 rounded-xl px-4 py-3">
                        <div className="flex items-baseline justify-between gap-3">
                          <p className="text-sm font-bold text-amber-900">{f.sectionLabel}</p>
                          <p className="text-[10px] text-amber-700">page {f.pageIndex + 1} · {f.judge?.errors_in_a?.length ?? 0} error{(f.judge?.errors_in_a?.length ?? 0) === 1 ? "" : "s"}</p>
                        </div>
                        {f.judge?.summary && (
                          <p className="text-xs text-amber-800 mt-1">{f.judge.summary}</p>
                        )}
                        <ul className="mt-2 space-y-1">
                          {(f.judge?.errors_in_a ?? []).map((e, i) => (
                            <li key={i} className="text-xs text-slate-700">
                              <span className="font-bold text-rose-700">{e.snippet}</span>
                              <span className="text-slate-400"> → </span>
                              <span className="font-bold text-emerald-700">{e.correction}</span>
                              {e.note && <span className="text-slate-500"> · {e.note}</span>}
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                )}
                {auditFindings.some(f => f.skipped) && (
                  <p className="text-[10px] text-slate-400">
                    Skipped: {auditFindings.filter(f => f.skipped).map(f => `${f.sectionLabel} (${f.skipped})`).join(", ")}
                  </p>
                )}
              </div>
            );
          })()}
        </div>
      )}
      {sections.map(sec => {
        // Use the section's resolved ocrKey (set by groupBySection)
        // so duplicate-name topics each get their own ocrData entry.
        // Fall back to fuzzy match for legacy data that doesn't have
        // the suffixed keys yet.
        // Expand key MUST be per-section-row, not per-ocrKey. Chinese
        // papers can have two rows ("阅读理解 MCQ" + "阅读理解 A") that
        // resolve to the same ocrKey because the questions share a
        // syllabusTopic — keying expand on ocrKey would flip both rows
        // together. sec.name is unique per row.
        const expandKey = sec.name;
        const isExpanded = expandedSection === expandKey;
        const ocrData = ocrTexts[sec.ocrKey] ?? ocrTexts[sec.name] ?? Object.entries(ocrTexts).find(([k]) =>
          k.toLowerCase().replace(/\s+/g, "").includes(sec.name.toLowerCase().replace(/\s+/g, "").slice(0, 10))
        )?.[1] ?? null;
        const sectionPageIndices = ocrData?.pageIndices ?? [];

        return (
          <div key={expandKey} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            {/* Section header */}
            <button
              onClick={() => setExpandedSection(isExpanded ? null : expandKey)}
              className="w-full flex items-center justify-between p-4 hover:bg-slate-50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <SectionBadge name={sec.name} />
                <div className="text-left">
                  <h3 className="font-bold text-sm text-slate-800">
                    {sec.name}
                    {sec.ocrKey !== sec.name && (
                      <span className="text-[10px] font-normal text-slate-400 ml-2">{sec.ocrKey.replace(sec.name, "").trim()}</span>
                    )}
                  </h3>
                  <p className="text-xs text-slate-400">{sec.questions.length} questions</p>
                </div>
              </div>
              <span className={`material-symbols-outlined text-slate-400 transition-transform ${isExpanded ? "rotate-180" : ""}`}>
                expand_more
              </span>
            </button>

            {isExpanded && (
              <div className="border-t border-slate-100">
                {/* Passage page images (Comprehension OEQ) */}
                {ocrData?.passagePageIndices && ocrData.passagePageIndices.length > 0 && (
                  <div className="p-4 bg-amber-50 border-b border-amber-100">
                    <p className="text-[10px] font-bold text-amber-600 uppercase tracking-wider mb-3">
                      Reading Passage (Page {ocrData.passagePageIndices.map(i => i + 1).join(", ")})
                    </p>
                    <div className="flex gap-3 overflow-x-auto pb-2">
                      {ocrData.passagePageIndices.map(pageIdx => (
                        pageImages[pageIdx] && (
                          <img
                            key={`passage-${pageIdx}`}
                            src={pageImages[pageIdx]}
                            alt={`Passage Page ${pageIdx + 1}`}
                            className="h-80 rounded-lg border border-amber-200 shadow-sm shrink-0"
                          />
                        )
                      ))}
                    </div>
                  </div>
                )}

                {/* Re-extract passage from pages */}
                {/* English "comprehension" sections + Chinese 阅读理解
                    sections. The latter share a single syllabusTopic
                    across multiple passage-bound sections, so the admin
                    needs the per-section button to re-OCR each one. */}
                {(sec.name.toLowerCase().includes("comprehension") || sec.name.includes("阅读理解")) && (
                  <div className="p-4 bg-amber-50/50 border-b border-amber-100">
                    <p className="text-[10px] font-bold text-amber-600 uppercase tracking-wider mb-2">Re-extract Passage</p>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        placeholder="e.g. 7,8"
                        value={passagePages[sec.name] ?? ""}
                        onChange={e => setPassagePages(prev => ({ ...prev, [sec.name]: e.target.value }))}
                        className="w-36 px-3 py-1.5 rounded-lg border border-amber-200 text-sm focus:outline-none focus:border-amber-400"
                      />
                      <button
                        disabled={reextractingPassage === sec.name || !(passagePages[sec.name]?.trim())}
                        onClick={async () => {
                          const input = passagePages[sec.name]?.trim();
                          if (!input) return;
                          if (!confirm(`Re-extract the reading passage for "${sec.name}" from the selected pages?`)) return;
                          const indices: number[] = [];
                          for (const part of input.split(",")) {
                            const trimmed = part.trim();
                            if (trimmed.includes("-")) {
                              const [a, b] = trimmed.split("-").map(s => parseInt(s.trim()));
                              if (!isNaN(a) && !isNaN(b)) for (let i = a; i <= b; i++) indices.push(i - 1);
                            } else {
                              const n = parseInt(trimmed);
                              if (!isNaN(n)) indices.push(n - 1);
                            }
                          }
                          if (indices.length === 0) return;
                          setReextractingPassage(sec.name);
                          setPassageResult(prev => ({ ...prev, [sec.name]: "" }));
                          try {
                            const res = await fetch(`/api/exam/${paper.id}/reextract-passage`, {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ pageIndices: indices, sectionName: sec.name }),
                            });
                            const data = await res.json();
                            if (!res.ok) {
                              setPassageResult(prev => ({ ...prev, [sec.name]: `Error: ${data.error}` }));
                            } else {
                              setPassageResult(prev => ({ ...prev, [sec.name]: `Done! Passage extracted (${data.charCount} chars). Reload to see.` }));
                            }
                          } catch {
                            setPassageResult(prev => ({ ...prev, [sec.name]: "Error: request failed" }));
                          } finally {
                            setReextractingPassage(null);
                          }
                        }}
                        className="px-4 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-bold hover:bg-amber-700 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                      >
                        {reextractingPassage === sec.name ? (
                          <><span className="animate-spin rounded-full h-3 w-3 border-2 border-white/30 border-t-white inline-block" /> Extracting...</>
                        ) : (
                          <><span className="material-symbols-outlined text-sm">menu_book</span> Re-extract Passage</>
                        )}
                      </button>
                    </div>
                    {passageResult[sec.name] && (
                      <p className={`text-xs mt-2 font-medium ${passageResult[sec.name].startsWith("Error") ? "text-red-600" : "text-green-600"}`}>
                        {passageResult[sec.name]}
                      </p>
                    )}
                  </div>
                )}

                {/* Cropped passage image (with charts / infographics)
                    — Chinese 阅读理解 only. When set, takes the place
                    of the OCR-text panel below. */}
                {sec.name.includes("阅读理解") && (() => {
                  const passageImageData = chineseSections?.find(c => c.label === sec.name)?.passageImageData;
                  return (
                    <div className="p-4 bg-violet-50/60 border-b border-violet-100">
                      <p className="text-[10px] font-bold text-violet-600 uppercase tracking-wider mb-2">
                        Cropped Passage Image{passageImageData ? " (in use)" : ""}
                      </p>
                      {passageImageData && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={passageImageData} alt={`${sec.name} cropped passage`} className="max-w-full mb-2 rounded-lg border border-violet-200 shadow-sm" />
                      )}
                      <div className="flex items-center gap-2">
                        <label className={`px-4 py-1.5 rounded-lg text-xs font-bold cursor-pointer transition-colors ${uploadingPassageImage === sec.name ? "bg-violet-300 text-white" : "bg-violet-600 text-white hover:bg-violet-700"}`}>
                          {uploadingPassageImage === sec.name ? "Uploading…" : (passageImageData ? "Replace image" : "Upload cropped image")}
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            disabled={uploadingPassageImage === sec.name}
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (!file) return;
                              setUploadingPassageImage(sec.name);
                              setPassageImageError(prev => ({ ...prev, [sec.name]: "" }));
                              try {
                                // Read as data URL.
                                const dataUrl = await new Promise<string>((resolve, reject) => {
                                  const r = new FileReader();
                                  r.onload = () => resolve(String(r.result ?? ""));
                                  r.onerror = () => reject(new Error("Failed to read file"));
                                  r.readAsDataURL(file);
                                });
                                const res = await fetch(`/api/admin/exam/${paper.id}/section-passage-image`, {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ sectionLabel: sec.name, imageBase64: dataUrl }),
                                });
                                if (!res.ok) {
                                  const body = await res.json().catch(() => ({}));
                                  setPassageImageError(prev => ({ ...prev, [sec.name]: body.error ?? `HTTP ${res.status}` }));
                                } else {
                                  // Reload so the new image renders + the
                                  // OCR text panel hides on next mount.
                                  window.location.reload();
                                }
                              } catch (err) {
                                setPassageImageError(prev => ({ ...prev, [sec.name]: (err as Error).message }));
                              } finally {
                                setUploadingPassageImage(null);
                                // Reset the file input so re-uploading the same file works.
                                e.target.value = "";
                              }
                            }}
                          />
                        </label>
                        {passageImageData && (
                          <button
                            onClick={async () => {
                              if (!confirm(`Clear the cropped passage image for "${sec.name}"? The OCR-text passage will be shown again.`)) return;
                              setUploadingPassageImage(sec.name);
                              try {
                                const res = await fetch(`/api/admin/exam/${paper.id}/section-passage-image`, {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ sectionLabel: sec.name, imageBase64: null }),
                                });
                                if (res.ok) window.location.reload();
                              } finally {
                                setUploadingPassageImage(null);
                              }
                            }}
                            className="px-3 py-1.5 rounded-lg text-xs font-medium text-violet-700 hover:bg-violet-100 transition-colors"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                      <p className="text-[10px] text-violet-600 mt-2">
                        For 阅读理解 sections whose passage contains charts / posters / infographics that OCR can&apos;t capture. When set, this image replaces the OCR-text passage in the quiz and review screens.
                      </p>
                      {passageImageError[sec.name] && (
                        <p className="text-xs mt-2 font-medium text-rose-600">Error: {passageImageError[sec.name]}</p>
                      )}
                    </div>
                  );
                })()}

                {/* Passage OCR text (line-numbered table) — editable.
                    Hidden when a cropped passage image is set for this
                    Chinese 阅读理解 section. */}
                {ocrData?.passageOcrText && !(sec.name.includes("阅读理解") && chineseSections?.find(c => c.label === sec.name)?.passageImageData) && (
                  <div className="p-4 bg-amber-50/50 border-b border-amber-100">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-[10px] font-bold text-amber-600 uppercase tracking-wider">
                        Reading Passage
                      </p>
                      <button
                        onClick={() => {
                          if (editingPassage === sec.name) {
                            setEditingPassage(null);
                          } else {
                            setPassageDrafts(prev => ({ ...prev, [sec.name]: ocrData.passageOcrText! }));
                            setEditingPassage(sec.name);
                          }
                        }}
                        className="text-xs text-amber-600 hover:text-amber-800 font-medium"
                      >
                        {editingPassage === sec.name ? "Cancel" : "Edit"}
                      </button>
                    </div>
                    {editingPassage === sec.name ? (
                      <div>
                        <textarea
                          value={passageDrafts[sec.name] ?? ocrData.passageOcrText}
                          onChange={e => setPassageDrafts(prev => ({ ...prev, [sec.name]: e.target.value }))}
                          rows={15}
                          className="w-full text-xs font-mono bg-white border border-amber-200 rounded-xl p-3 focus:outline-none focus:border-amber-400 resize-y"
                        />
                        <div className="flex gap-2 mt-2">
                          {onSaveOcr && (
                            <button
                              onClick={async () => {
                                // Save passageOcrText to sectionOcrTexts metadata
                                const metadata = paper.metadata ?? {};
                                const allOcr = (metadata as Record<string, unknown>).sectionOcrTexts as Record<string, Record<string, unknown>> ?? {};
                                const secOcr = allOcr[sec.name] ?? Object.entries(allOcr).find(([k]) =>
                                  k.toLowerCase().includes(sec.name.toLowerCase().split(" ")[0]))?.[1] ?? {};
                                const secKey = allOcr[sec.name] ? sec.name : Object.keys(allOcr).find(k =>
                                  k.toLowerCase().includes(sec.name.toLowerCase().split(" ")[0])) ?? sec.name;
                                allOcr[secKey] = { ...secOcr, passageOcrText: passageDrafts[sec.name] };
                                await fetch(`/api/exam/${paper.id}`, {
                                  method: "PATCH",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ metadata: { ...metadata, sectionOcrTexts: allOcr } }),
                                });
                                setEditingPassage(null);
                              }}
                              className="px-4 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-bold hover:bg-amber-700 transition-colors"
                            >
                              Save Passage
                            </button>
                          )}
                          <button
                            onClick={() => setEditingPassage(null)}
                            className="px-4 py-1.5 rounded-lg text-slate-400 text-xs font-bold hover:text-slate-600 transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <OcrRichText text={ocrData.passageOcrText} />
                    )}
                  </div>
                )}

                {/* Section page images */}
                {sectionPageIndices.length > 0 && (
                  <div className="p-4 bg-slate-50 border-b border-slate-100">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-3">
                      Exam Pages (Page {sectionPageIndices.map(i => i + 1).join(", ")})
                    </p>
                    <div className="flex gap-3 overflow-x-auto pb-2">
                      {sectionPageIndices.map(pageIdx => (
                        pageImages[pageIdx] && (
                          <img
                            key={pageIdx}
                            src={pageImages[pageIdx]}
                            alt={`Page ${pageIdx + 1}`}
                            className="h-64 rounded-lg border border-slate-200 shadow-sm shrink-0"
                          />
                        )
                      ))}
                    </div>
                  </div>
                )}

                {/* Re-extract section from pages. Input is pre-filled with
                    the section's known page indices (1-indexed) so 语文应用
                    MCQ / 阅读理解 etc. can be re-extracted with one click —
                    no need to look up which pages the section spans. The
                    user can still override the value to point at a different
                    range if the original page mapping is wrong. */}
                <div className="p-4 bg-blue-50/50 border-b border-blue-100">
                  <p className="text-[10px] font-bold text-blue-600 uppercase tracking-wider mb-2">Re-extract from Pages</p>
                  <div className="flex items-center gap-2">
                    {(() => {
                      const sectionDefaultPages = sectionPageIndices.length > 0
                        ? sectionPageIndices.map(i => i + 1).join(",")
                        : "";
                      const effectivePages = reextractPages[sec.name] ?? sectionDefaultPages;
                      return <>
                    <input
                      type="text"
                      placeholder="e.g. 4,5 or 4-6"
                      value={effectivePages}
                      onChange={e => setReextractPages(prev => ({ ...prev, [sec.name]: e.target.value }))}
                      className="w-36 px-3 py-1.5 rounded-lg border border-blue-200 text-sm focus:outline-none focus:border-blue-400"
                    />
                    <button
                      disabled={reextracting === sec.name || !effectivePages.trim()}
                      onClick={async () => {
                        const input = effectivePages.trim();
                        if (!input) return;
                        if (!confirm(`This will re-extract questions for "${sec.name}" from the selected pages and OVERWRITE existing stems/options. Continue?`)) return;
                        // Parse page input: "4,5" or "4-6" → 0-indexed array
                        const indices: number[] = [];
                        for (const part of input.split(",")) {
                          const trimmed = part.trim();
                          if (trimmed.includes("-")) {
                            const [a, b] = trimmed.split("-").map(s => parseInt(s.trim()));
                            if (!isNaN(a) && !isNaN(b)) {
                              for (let i = a; i <= b; i++) indices.push(i - 1); // 1-indexed → 0-indexed
                            }
                          } else {
                            const n = parseInt(trimmed);
                            if (!isNaN(n)) indices.push(n - 1);
                          }
                        }
                        if (indices.length === 0) return;
                        setReextracting(sec.name);
                        setReextractResult(prev => ({ ...prev, [sec.name]: "" }));
                        try {
                          const res = await fetch(`/api/exam/${paper.id}/reextract-section`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ pageIndices: indices, sectionName: sec.name }),
                          });
                          const data = await res.json();
                          if (!res.ok) {
                            setReextractResult(prev => ({ ...prev, [sec.name]: `Error: ${data.error}` }));
                          } else {
                            setReextractResult(prev => ({ ...prev, [sec.name]: `Done! ${data.questionsUpdated}/${data.questionsExtracted} questions updated. Reload to see changes.` }));
                          }
                        } catch {
                          setReextractResult(prev => ({ ...prev, [sec.name]: "Error: request failed" }));
                        } finally {
                          setReextracting(null);
                        }
                      }}
                      className="px-4 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-bold hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                    >
                      {reextracting === sec.name ? (
                        <><span className="animate-spin rounded-full h-3 w-3 border-2 border-white/30 border-t-white inline-block" /> Extracting...</>
                      ) : (
                        <><span className="material-symbols-outlined text-sm">refresh</span> Re-extract</>
                      )}
                    </button>
                      </>;
                    })()}
                  </div>
                  {reextractResult[sec.name] && (
                    <p className={`text-xs mt-2 font-medium ${reextractResult[sec.name].startsWith("Error") ? "text-red-600" : "text-green-600"}`}>
                      {reextractResult[sec.name]}
                    </p>
                  )}
                </div>

                {/* Use page image as passage — Chinese 阅读理解 only.
                    PSLE 华文 sometimes prints the passage as an image
                    (illustration + caption, comic, infographic) where
                    OCR can't capture what the student sees. Admin
                    picks page indices on the source paper; we stamp a
                    [VISUAL_PAGES:paperId:p1,p2] sentinel into the
                    section's passage field and ChineseQuizSection's
                    render path already swaps to image rendering when
                    it sees that prefix. Empty input + Apply = revert
                    to OCR text. */}
                {(paper.subject ?? "").toLowerCase().includes("chinese")
                  && sec.name.includes("阅读理解") && (() => {
                  const cs = (paper.metadata as { chineseSections?: Array<{ label: string; passage?: string }> } | null)?.chineseSections;
                  const csEntry = cs?.find(s => s.label === sec.name);
                  const current = csEntry?.passage ?? "";
                  const isImage = current.startsWith("[VISUAL_") || current.startsWith("data:image");
                  // Pre-fill with current page indices if already set
                  // as an image; otherwise default to the section's
                  // own pages so the admin doesn't have to look them up.
                  const sectionDefaultPages = sectionPageIndices.length > 0
                    ? sectionPageIndices.map(i => i + 1).join(",")
                    : "";
                  const currentPagesIfImage = (() => {
                    const m = current.match(/^\[VISUAL_PAGES:[^:]+:([^\]]+)\]$/);
                    if (!m) return "";
                    return m[1].split(",").map(p => String(parseInt(p) + 1)).join(",");
                  })();
                  const draftKey = `_img:${sec.name}`;
                  const draft = reextractPages[draftKey] ?? (currentPagesIfImage || sectionDefaultPages);
                  return (
                    <div className="p-4 bg-violet-50/50 border-b border-violet-100">
                      <p className="text-[10px] font-bold text-violet-600 uppercase tracking-wider mb-2">
                        Use Page Image as Passage
                        {isImage && <span className="ml-2 px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 text-[10px] font-bold">Currently image-mode</span>}
                      </p>
                      <p className="text-[11px] text-violet-700/80 mb-2">
                        Set this only when the printed passage contains an illustration / caption / comic layout that OCR can&apos;t represent. Leave empty + Apply to revert to OCR text.
                      </p>
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          placeholder="e.g. 20 or 19,20"
                          value={draft}
                          onChange={e => setReextractPages(prev => ({ ...prev, [draftKey]: e.target.value }))}
                          className="w-36 px-3 py-1.5 rounded-lg border border-violet-200 text-sm focus:outline-none focus:border-violet-400"
                        />
                        <button
                          onClick={async () => {
                            const input = draft.trim();
                            const indices: number[] = [];
                            for (const part of input.split(",")) {
                              const trimmed = part.trim();
                              if (trimmed.includes("-")) {
                                const [a, b] = trimmed.split("-").map(s => parseInt(s.trim()));
                                if (!isNaN(a) && !isNaN(b)) {
                                  for (let i = a; i <= b; i++) indices.push(i - 1);
                                }
                              } else {
                                const n = parseInt(trimmed);
                                if (!isNaN(n)) indices.push(n - 1);
                              }
                            }
                            const payload = indices.length === 0
                              ? { sectionLabel: sec.name, pageIndices: null }
                              : { sectionLabel: sec.name, pageIndices: indices };
                            const res = await fetch(`/api/exam/${paper.id}/set-chinese-passage-image`, {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify(payload),
                            });
                            const data = await res.json().catch(() => ({}));
                            if (!res.ok) {
                              alert(`Failed: ${data.error ?? "unknown error"}`);
                              return;
                            }
                            alert(indices.length === 0 ? "Reverted to OCR text. Reload to see changes." : "Applied. Reload to see the image render.");
                          }}
                          className="px-4 py-1.5 rounded-lg bg-violet-600 text-white text-xs font-bold hover:bg-violet-700 transition-colors"
                        >
                          Apply
                        </button>
                      </div>
                    </div>
                  );
                })()}

                {/* OCR text. Some older papers (e.g. PSLE English 2017
                    Comprehension Cloze) have the passage stored in
                    passageOcrText with an empty ocrText. Fall back to
                    passageOcrText for display so the panel isn't blank.
                    Always render the panel when the section is part of
                    sectionOcrTexts — even if both fields are empty —
                    so the admin still has an Edit textarea to paste
                    the passage into (grammar cloze where both OCR
                    fields came back empty). */}
                {ocrData && (() => {
                  const displayOcr = ocrData.ocrText && ocrData.ocrText.trim().length > 0
                    ? ocrData.ocrText
                    : (ocrData.passageOcrText ?? "");
                  return (
                    <div className="p-4 border-b border-slate-100">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">OCR Text</p>
                        <button
                          onClick={() => {
                            if (editingOcr === sec.name) {
                              setEditingOcr(null);
                            } else {
                              setOcrDrafts(prev => ({ ...prev, [sec.name]: displayOcr }));
                              setEditingOcr(sec.name);
                            }
                          }}
                          className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                        >
                          {editingOcr === sec.name ? "Cancel" : (displayOcr ? "Edit" : "Add OCR")}
                        </button>
                      </div>
                      {editingOcr === sec.name ? (
                        <div>
                          <textarea
                            value={ocrDrafts[sec.name] ?? displayOcr}
                            onChange={e => setOcrDrafts(prev => ({ ...prev, [sec.name]: e.target.value }))}
                            rows={12}
                            placeholder={displayOcr ? "" : "Paste the section's OCR text here. For grammar cloze: passage with the inline word bank (A-Q) and numbered blanks (29)–(38)."}
                            className="w-full text-xs font-mono bg-white border border-slate-200 rounded-xl p-3 focus:outline-none focus:border-blue-400 resize-y"
                          />
                          <div className="flex gap-2 mt-2">
                            {onSaveOcr && (
                              <button
                                onClick={async () => {
                                  await onSaveOcr(sec.name, ocrDrafts[sec.name] ?? displayOcr);
                                  setEditingOcr(null);
                                }}
                                className="px-4 py-1.5 rounded-lg bg-[#003366] text-white text-xs font-bold hover:bg-[#001e40] transition-colors"
                              >
                                Update
                              </button>
                            )}
                            <button
                              onClick={() => setEditingOcr(null)}
                              className="px-4 py-1.5 rounded-lg text-slate-400 text-xs font-bold hover:text-slate-600 transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : displayOcr ? (
                        <OcrRichText text={displayOcr} isMcq={sec.name.toLowerCase().includes("mcq")} />
                      ) : (
                        <p className="text-xs italic text-slate-400 py-2">No OCR text. Click <span className="font-semibold">Add OCR</span> to paste it manually.</p>
                      )}
                    </div>
                  );
                })()}

                {/* Chinese 短文填空 quiz preview — mirrors the quiz
                    player's inline 4-option pickers so admins can
                    eyeball the section the way the student sees it.
                    Correct answer is highlighted in green. */}
                {sec.name.includes("短文填空") && (
                  <ShortClozeQuizPreview
                    passage={ocrData?.ocrText ?? ""}
                    questions={sec.questions}
                  />
                )}

                {/* Questions */}
                <div className="p-4">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-3">
                    Questions & Answers
                  </p>
                  <div className="space-y-3">
                    {(() => {
                      // Across the WHOLE Chinese paper, only ONE
                      // question needs an attached image: the long
                      // OEQ inside 阅读理解 A (the merged 五-A MCQ +
                      // OEQ section, Q33 in PSLE 华文). Every other
                      // Chinese question — 语文应用 MCQ, 短文填空,
                      // 阅读理解 MCQ, 完成对话, AND 阅读理解 B OEQ
                      // (Q34-40) — has zero image controls.
                      // English / Math / Science keep the Upload
                      // control on every question (unchanged
                      // behaviour), but never see the Crop button.
                      const sname = sec.name;
                      const isChineseSection =
                        sname.includes("语文应用") ||
                        sname.includes("短文填空") ||
                        sname.includes("完成对话") ||
                        sname.includes("对话填空") ||
                        sname.includes("阅读理解");
                      const isLongOeqSection = sname.includes("阅读理解 A") && !sname.includes("OEQ");
                      // 阅读理解 B is the short-OEQ section (Q34-40
                      // on PSLE 华文). Any OEQ question inside it
                      // gets the per-question Re-extract Answer
                      // button so the editor can point at the right
                      // answer-key page when the auto-extract picks
                      // the wrong region.
                      const isCompBSection = sname.includes("阅读理解 B");
                      return sec.questions.map(q => {
                        const hasOptions = Array.isArray(q.transcribedOptions) && q.transcribedOptions.length > 0;
                        const isLongOeqQuestion = isLongOeqSection && !hasOptions;
                        const isCompBOeqQuestion = isCompBSection && !hasOptions;
                        // Upload image:
                        //   Chinese — only the long OEQ in 阅读理解 A (Q33).
                        //   English / Math / Science — OEQ only. MCQ stems
                        //     never need a diagram upload because the option
                        //     images are the diagrams; the upload control
                        //     was just clutter on MCQ rows.
                        const allowImageUpload = isChineseSection
                          ? isLongOeqQuestion
                          : !hasOptions;
                        const allowImageCrop = isLongOeqQuestion;
                        const allowReextractAnswer = isLongOeqQuestion || isCompBOeqQuestion;
                        return (
                          // Anchor wrapper so /edit's #q-<id> hash
                          // navigation (from See-Answer-Image sweep,
                          // Flagged Q&A) can scroll to this specific
                          // row even inside the sectioned EnglishEditView.
                          <div key={q.id} id={`q-${q.id}`}>
                          <QuestionRow
                            question={q}
                            onSave={onSave}
                            onDelete={onDelete}
                            saving={saving}
                            auditFlag={auditFlags[q.id]}
                            allowImageUpload={allowImageUpload}
                            allowImageCrop={allowImageCrop}
                            allowReextractAnswer={allowReextractAnswer}
                            pageImage={allowImageCrop && q.pageIndex != null ? pageImages[q.pageIndex] : undefined}
                          />
                          </div>
                        );
                      });
                    })()}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Chinese 短文填空 quiz preview — read-only mirror of the
// ChineseQuizSection inline-pickers branch. Renders the passage
// with each **...** blank replaced by a row of 4 option buttons.
// The CORRECT answer is highlighted in green so the admin can
// verify the answer key + passage shape at a glance.
function ShortClozeQuizPreview({
  passage,
  questions,
}: {
  passage: string;
  questions: ExamQuestionItem[];
}) {
  if (!passage) return null;
  const dividerIdx = passage.indexOf("---OPTIONS---");
  const passageOnly = dividerIdx >= 0 ? passage.slice(0, dividerIdx) : passage;
  const sortedQs = [...questions].sort((a, b) =>
    a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true })
  );
  // Walk every **...** occurrence; nth occurrence = nth question.
  const blankRe = /\*\*[^*]*\*\*/g;
  type Seg = { kind: "text" | "blank"; text: string; qIdx: number };
  const segments: Seg[] = [];
  let lastEnd = 0;
  let bi = 0;
  for (const m of passageOnly.matchAll(blankRe)) {
    if (m.index! > lastEnd) segments.push({ kind: "text", text: passageOnly.slice(lastEnd, m.index!), qIdx: -1 });
    segments.push({ kind: "blank", text: m[0], qIdx: bi });
    bi++;
    lastEnd = m.index! + m[0].length;
  }
  if (lastEnd < passageOnly.length) segments.push({ kind: "text", text: passageOnly.slice(lastEnd), qIdx: -1 });
  return (
    <div className="p-4 bg-[#f7faff] border-b border-slate-100">
      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-3">Quiz preview (answer key in green)</p>
      <div className="bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100">
        <p className="text-sm text-slate-500 italic mb-4">阅读短文，从每题的四个选项中选出最合适的答案。</p>
        <div className="leading-loose text-base text-[#0b1c30]">
          {segments.map((seg, i) => {
            if (seg.kind === "text") return <span key={i} className="whitespace-pre-wrap">{seg.text}</span>;
            const q = sortedQs[seg.qIdx];
            if (!q) return <span key={i} className="text-slate-400 border-b border-slate-400 px-3">______</span>;
            const opts = (q.transcribedOptions as string[] | null) ?? ["", "", "", ""];
            const correctRaw = (q.answer ?? "").replace(/[().]/g, "").trim();
            const correctNum = parseInt(correctRaw, 10);
            return (
              <span key={i} className="inline-flex flex-wrap items-center gap-1 align-middle mx-1 my-1 bg-[#eff4ff] border border-[#d3e4fe] rounded-xl px-2 py-1 max-w-full">
                <span className="text-[10px] font-extrabold text-[#003366] bg-white px-1.5 rounded">Q{parseInt(q.questionNum)}</span>
                {[0, 1, 2, 3].map(oi => {
                  const optNum = oi + 1;
                  const isCorrect = !isNaN(correctNum) && correctNum === optNum;
                  const isEmpty = !opts[oi];
                  return (
                    <span
                      key={oi}
                      className={`text-xs font-semibold px-2 py-0.5 rounded-md border ${
                        isCorrect
                          ? "bg-[#006c49] text-white border-[#006c49]"
                          : isEmpty
                            ? "bg-slate-100 text-slate-300 border-slate-200"
                            : "bg-white text-[#001e40] border-[#c3c6d1]"
                      }`}
                      title={isEmpty ? "(option missing)" : opts[oi]}
                    >
                      ({optNum}) {opts[oi] || "—"}
                    </span>
                  );
                })}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SectionBadge({ name }: { name: string }) {
  const n = name.toLowerCase();
  let cls = "bg-slate-100 text-slate-600";
  if (n.includes("grammar mcq")) cls = "bg-blue-100 text-blue-700";
  else if (n.includes("vocabulary mcq")) cls = "bg-blue-100 text-blue-700";
  else if (n.includes("vocabulary cloze")) cls = "bg-sky-100 text-sky-700";
  else if (n.includes("visual text")) cls = "bg-cyan-100 text-cyan-700";
  else if (n.includes("grammar cloze")) cls = "bg-orange-100 text-orange-700";
  else if (n.includes("editing")) cls = "bg-yellow-100 text-yellow-700";
  else if (n.includes("comprehension cloze")) cls = "bg-green-100 text-green-700";
  else if (n.includes("synthesis")) cls = "bg-pink-100 text-pink-700";
  else if (n.includes("comprehension") && n.includes("open")) cls = "bg-purple-100 text-purple-700";
  return <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${cls}`}>{name}</span>;
}

function QuestionRow({
  question: q,
  onSave,
  onDelete,
  saving,
  auditFlag,
  allowImageUpload = true,
  allowImageCrop = false,
  allowReextractAnswer = false,
  pageImage,
}: {
  question: ExamQuestionItem;
  onSave: (questionId: string, data: Record<string, unknown>) => Promise<void>;
  onDelete?: (questionId: string) => void;
  saving: string | null;
  auditFlag?: string;
  /** When false, hide the Upload/Replace/Delete image controls.
   *  Used for Chinese sections 1-4 (语文应用 MCQ / 短文填空 /
   *  阅读理解 MCQ / 完成对话) where no diagram should ever be
   *  attached — only 阅读理解 A's long OEQ Q33 needs one. */
  allowImageUpload?: boolean;
  /** When true, show the in-app "Crop from page" button. Chinese
   *  阅读理解 OEQ / 阅读理解 A / 阅读理解 B sections only — English /
   *  Math / Science don't need the cropper. */
  allowImageCrop?: boolean;
  /** When true, show the "Re-extract Answer from page" control.
   *  Strict superset of allowImageCrop — also true for 阅读理解 B
   *  OEQ questions where the answer key may live on a different
   *  page than the question itself. */
  allowReextractAnswer?: boolean;
  /** Source page image for this question. When present and crop is
   *  allowed, the row shows a "Re-crop from page" button. */
  pageImage?: string;
}) {
  const [cropOpen, setCropOpen] = useState(false);
  const [reextractAnsPages, setReextractAnsPages] = useState("");
  const [reextractAnsBusy, setReextractAnsBusy] = useState(false);
  const [reextractAnsResult, setReextractAnsResult] = useState<string | null>(null);
  const [editAnswer, setEditAnswer] = useState(false);
  const [answerDraft, setAnswerDraft] = useState(q.answer ?? "");
  const [marksDraft, setMarksDraft] = useState(q.marksAvailable != null ? String(q.marksAvailable) : "");
  const [editingStem, setEditingStem] = useState(false);
  const [stemDraft, setStemDraft] = useState(q.transcribedStem ?? "");
  const [redoingTable, setRedoingTable] = useState(false);
  const [showTopicMenu, setShowTopicMenu] = useState(false);
  const [editingOptions, setEditingOptions] = useState(false);
  const [optionsDraft, setOptionsDraft] = useState<string[]>(() => {
    const existing = (q.transcribedOptions as string[] | null) ?? [];
    const padded = [...existing];
    while (padded.length < 4) padded.push("");
    return padded.slice(0, 4);
  });

  return (
    <div className={`flex items-start gap-3 p-3 rounded-xl ${auditFlag ? "bg-red-50 border border-red-200" : "bg-slate-50 border border-slate-100"}`}>
      {/* Question number */}
      <div className="flex flex-col items-center gap-1 shrink-0">
        <span
          className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold ${auditFlag ? "bg-red-100 border border-red-400 text-red-700" : "bg-white border border-slate-200 text-slate-700"}`}
          title={auditFlag ?? undefined}
        >
          {q.questionNum}
        </span>
        {auditFlag && (
          <span className="text-[8px] text-red-600 font-bold" title={auditFlag}>flagged</span>
        )}
        {/* Topic selector */}
        <div className="relative">
          <button
            onClick={() => setShowTopicMenu(!showTopicMenu)}
            className="text-[8px] text-slate-400 hover:text-blue-600 truncate max-w-[70px]"
            title={q.syllabusTopic ?? "Set topic"}
          >
            {q.syllabusTopic ? q.syllabusTopic.slice(0, 12) : "set topic"}
          </button>
          {showTopicMenu && (
            <div className="absolute left-0 top-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-50 w-56 py-1 max-h-64 overflow-y-auto">
              {[
                "Grammar MCQ",
                "Vocabulary MCQ",
                "Vocabulary Cloze MCQ",
                "Visual Text Comprehension MCQ",
                "Grammar Cloze",
                "Editing (Spelling & Grammar)",
                "Comprehension Cloze",
                "Synthesis / Transformation",
                "Comprehension Open Ended",
              ].map(topic => (
                <button
                  key={topic}
                  onClick={async () => {
                    await onSave(q.id, { syllabusTopic: topic });
                    setShowTopicMenu(false);
                  }}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-blue-50 ${q.syllabusTopic === topic ? "font-bold text-blue-600 bg-blue-50" : "text-slate-700"}`}
                >
                  {topic}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 min-w-0">
        {/* Clean extracted question text — render with rich formatting */}
        {(() => {
          let stem = q.transcribedStem ?? "";
          let options = q.transcribedOptions ?? [];
          // If options are empty, try to extract from stem (e.g. "stem text (1) opt1 (2) opt2 (3) opt3 (4) opt4")
          if (options.length === 0 && stem) {
            const optMatch = stem.match(/^(.*?)\s*\(1\)\s+/);
            if (optMatch) {
              const optParts = stem.slice(optMatch[1].length).match(/\(\d\)\s+([^(]*)/g);
              if (optParts && optParts.length >= 4) {
                stem = optMatch[1].trim();
                options = optParts.map(p => p.replace(/^\(\d\)\s+/, "").trim());
              }
            }
          }
          // For Synthesis: split question text from answer area
          // Pattern A: **Word** ____ (starting word)
          // Pattern B: ____ **Word** ____ (joining word in middle —
          //            both inline OR with newline between blanks
          //            and keyword)
          // Try B FIRST because it's the more specific shape; A would
          // otherwise greedily grab from `**keyword**` onwards and
          // strand the leading underscores in the question text.
          let questionText = stem;
          let answerArea = "";
          if (stem && q.syllabusTopic?.toLowerCase().includes("synthesis")) {
            const synthSplitB = stem.match(/^([\s\S]*?)(_{3,}[\s\S]*?\*\*[^*\n]+\*\*[\s\S]*)$/);
            const synthSplitA = !synthSplitB
              ? stem.match(/^([\s\S]*?)(\*\*[^*\n]+\*\*\s*_+[\s\S]*)$/)
              : null;
            const synthSplit = synthSplitB || synthSplitA;
            if (synthSplit) {
              questionText = synthSplit[1].trim();
              answerArea = synthSplit[2].trim();
            }
          }

          return (
            <>
              {questionText && (
                <div className="mb-1">
                  <OcrRichText text={questionText} />
                </div>
              )}
              {answerArea && (
                <div className="mt-2">
                  <OcrRichText text={answerArea} />
                </div>
              )}
              {/* Synthesis answers are stored as a 1-element options array —
                 render them as the transformed-sentence answer, not as a
                 one-option MCQ. */}
              {options.length === 1 && q.syllabusTopic?.toLowerCase().includes("synthesis") && !editingOptions && (
                <div className="mt-2 mb-1 ml-4">
                  <p className="text-[10px] font-bold uppercase text-slate-400 mb-0.5">Transformed answer</p>
                  <p className="text-xs text-slate-700 whitespace-pre-wrap">{options[0]}</p>
                  <button
                    onClick={() => { setOptionsDraft([options[0] ?? "", "", "", ""]); setEditingOptions(true); }}
                    className="text-[10px] text-blue-600 hover:text-blue-800 font-medium mt-1"
                  >Edit answer</button>
                </div>
              )}
              {options.length >= 2 && !editingOptions && (
                <div className="flex flex-col gap-0.5 mt-2 mb-1 ml-4">
                  {options.map((opt, i) => (
                    <span key={i} className="text-xs text-slate-600 inline-flex flex-wrap items-baseline gap-1">
                      <span className="font-bold text-slate-400">({i + 1})</span>
                      <OcrRichText text={opt} />
                    </span>
                  ))}
                  <button
                    onClick={() => {
                      const existing = (q.transcribedOptions as string[] | null) ?? [];
                      const padded = [...existing];
                      while (padded.length < 4) padded.push("");
                      setOptionsDraft(padded.slice(0, 4));
                      setEditingOptions(true);
                    }}
                    className="text-[10px] text-blue-600 hover:text-blue-800 font-medium self-start mt-1"
                  >Edit options</button>
                </div>
              )}
              {editingOptions && (() => {
                const isSynthesisEdit = q.syllabusTopic?.toLowerCase().includes("synthesis") && ((q.transcribedOptions as string[] | null)?.length ?? 0) <= 1;
                const slots = isSynthesisEdit ? [0] : [0, 1, 2, 3];
                return (
                  <div className="mt-2 mb-2 ml-4 space-y-1">
                    {slots.map(i => (
                      <div key={i} className="flex items-center gap-2">
                        {!isSynthesisEdit && <span className="text-xs font-bold text-slate-400 w-5 shrink-0">({i + 1})</span>}
                        <textarea
                          value={optionsDraft[i] ?? ""}
                          onChange={e => {
                            const next = [...optionsDraft];
                            next[i] = e.target.value;
                            setOptionsDraft(next);
                          }}
                          rows={isSynthesisEdit ? 2 : 1}
                          className="flex-1 text-xs px-2 py-1 rounded border border-blue-200 bg-white focus:outline-none focus:border-blue-400 resize-none"
                          placeholder={isSynthesisEdit ? "Transformed sentence" : `Option ${i + 1}`}
                        />
                      </div>
                    ))}
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={async () => {
                          const cleaned = isSynthesisEdit
                            ? [optionsDraft[0]?.trim() ?? ""]
                            : optionsDraft.map(o => o.trim());
                          await onSave(q.id, { transcribedOptions: cleaned });
                          setEditingOptions(false);
                        }}
                        className="px-3 py-1 rounded-lg bg-blue-600 text-white text-[10px] font-bold hover:bg-blue-700"
                      >Save</button>
                      <button
                        onClick={() => setEditingOptions(false)}
                        className="px-3 py-1 rounded-lg text-slate-400 text-[10px] font-bold hover:text-slate-600"
                      >Cancel</button>
                    </div>
                  </div>
                );
              })()}
              {options.length === 0 && !editingOptions && (q.syllabusTopic?.toLowerCase().includes("mcq")) && (
                <button
                  onClick={() => { setOptionsDraft(["", "", "", ""]); setEditingOptions(true); }}
                  className="text-[10px] text-blue-600 hover:text-blue-800 font-medium ml-4 mt-1"
                >+ Add options</button>
              )}
            </>
          );
        })()}
        {/* Edit stem / Redo table buttons */}
        {!editingStem && (
          <div className="flex gap-2 mt-1 mb-2">
            <button
              onClick={() => { setStemDraft(q.transcribedStem ?? ""); setEditingStem(true); }}
              className="text-[10px] text-blue-600 hover:text-blue-800 font-medium"
            >{q.transcribedStem ? "Edit text" : "Add text"}</button>
            {(
              <button
                disabled={redoingTable}
                onClick={async () => {
                  setRedoingTable(true);
                  try {
                    const res = await fetch("/api/exam/redo-question", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ questionId: q.id, action: "redo-table" }),
                    });
                    if (res.ok) {
                      const data = await res.json();
                      if (data.stem) {
                        await onSave(q.id, { transcribedStem: data.stem });
                        setStemDraft(data.stem);
                      }
                    } else {
                      alert("Failed to redo table");
                    }
                  } catch { alert("Failed"); }
                  finally { setRedoingTable(false); }
                }}
                className="text-[10px] text-purple-600 hover:text-purple-800 font-medium disabled:opacity-50"
              >{redoingTable ? "Extracting..." : "Redo table"}</button>
            )}
          </div>
        )}
        {editingStem && (
          <div className="mb-2">
            <textarea
              value={stemDraft}
              onChange={e => setStemDraft(e.target.value)}
              rows={6}
              className="w-full text-xs font-mono bg-white border border-blue-200 rounded-lg p-2 focus:outline-none focus:border-blue-400 resize-y"
            />
            <div className="flex gap-2 mt-1">
              <button
                onClick={async () => {
                  await onSave(q.id, { transcribedStem: stemDraft });
                  setEditingStem(false);
                }}
                className="px-3 py-1 rounded-lg bg-blue-600 text-white text-[10px] font-bold hover:bg-blue-700"
              >Save</button>
              <button
                onClick={() => setEditingStem(false)}
                className="px-3 py-1 rounded-lg text-slate-400 text-[10px] font-bold hover:text-slate-600"
              >Cancel</button>
            </div>
          </div>
        )}

        {/* Image / diagram. Visible whenever imageData is set (so
            admin can verify the current crop), with an Upload control
            below so admin can attach a missing picture (e.g. the
            diagram on the PSLE 华文 五-A Q33 long OEQ). */}
        {q.imageData && (
          <img
            src={q.imageData}
            alt={`Q${q.questionNum}`}
            className="max-h-32 rounded border border-slate-200 mb-2"
          />
        )}
        {allowImageUpload && (
          <div className="flex items-center gap-2 mb-2 text-[10px] flex-wrap">
            {allowImageCrop && pageImage && (
              <button
                type="button"
                onClick={() => setCropOpen(true)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-amber-50 hover:bg-amber-100 text-amber-700 font-bold transition-colors"
                title="Drag a box on the source page to crop the picture"
              >
                <span className="material-symbols-outlined text-xs">crop</span>
                {q.imageData ? "Re-crop from page" : "Crop from page"}
              </button>
            )}
            <label className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-blue-50 hover:bg-blue-100 text-blue-700 font-bold cursor-pointer transition-colors">
              <span className="material-symbols-outlined text-xs">{q.imageData ? "swap_horiz" : "add_photo_alternate"}</span>
              {q.imageData ? "Replace image" : "Upload image"}
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async e => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const dataUrl = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result as string);
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                  });
                  await onSave(q.id, { imageData: dataUrl });
                  e.target.value = "";
                }}
              />
            </label>
            {q.imageData && (
              <button
                type="button"
                onClick={async () => {
                  if (!confirm("Remove this question's image?")) return;
                  await onSave(q.id, { imageData: null });
                }}
                className="px-2 py-1 rounded-md bg-slate-50 hover:bg-red-50 text-slate-500 hover:text-red-600 font-bold transition-colors"
              >
                <span className="material-symbols-outlined text-xs">delete</span>
              </button>
            )}
          </div>
        )}
        {allowImageCrop && pageImage && (
          <ImageCropModal
            open={cropOpen}
            pageImageSrc={pageImage}
            initialBox={q.yStartPct != null && q.yEndPct != null ? { topPct: q.yStartPct, leftPct: 0, rightPct: 100, bottomPct: q.yEndPct } : null}
            onClose={() => setCropOpen(false)}
            onCropped={async dataUrl => {
              await onSave(q.id, { imageData: dataUrl });
              setCropOpen(false);
            }}
          />
        )}

        {/* Answer — OEQ gets its own full-width textarea, MCQ stays inline */}
        {(() => {
          const isMcqQ = !!(q.transcribedOptions && Array.isArray(q.transcribedOptions) && (q.transcribedOptions as string[]).length > 0);
          if (isMcqQ) {
            return (
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold text-slate-400 uppercase shrink-0">Ans:</span>
                {editAnswer ? (
                  <input
                    value={answerDraft}
                    onChange={e => setAnswerDraft(e.target.value)}
                    onBlur={() => {
                      if (answerDraft !== (q.answer ?? "")) onSave(q.id, { answer: answerDraft || null });
                      setEditAnswer(false);
                    }}
                    onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                    autoFocus
                    className="flex-1 text-sm px-2 py-0.5 rounded border border-blue-300 focus:outline-none focus:border-blue-500 bg-white"
                  />
                ) : (
                  <span
                    onClick={() => { setAnswerDraft(q.answer ?? ""); setEditAnswer(true); }}
                    className="text-sm text-slate-700 cursor-pointer hover:text-blue-600 truncate"
                  >
                    {q.answer || <span className="text-slate-300 italic">no answer</span>}
                  </span>
                )}
              </div>
            );
          }
          // OEQ — full-width on its own line
          return (
            <div className="mt-2">
              <p className="text-[10px] font-bold text-slate-400 uppercase mb-1">Answer</p>
              {editAnswer ? (
                <textarea
                  value={answerDraft}
                  onChange={e => setAnswerDraft(e.target.value)}
                  onBlur={() => {
                    if (answerDraft !== (q.answer ?? "")) onSave(q.id, { answer: answerDraft || null });
                    setEditAnswer(false);
                  }}
                  rows={Math.min(8, Math.max(3, (answerDraft.match(/\n/g)?.length ?? 0) + 2))}
                  autoFocus
                  className="w-full text-xs font-mono px-3 py-2 rounded-lg border border-blue-300 focus:outline-none focus:border-blue-500 bg-white resize-y"
                  placeholder="Type the model answer here. Use | to separate sub-parts."
                />
              ) : (
                <div
                  onClick={() => { setAnswerDraft(q.answer ?? ""); setEditAnswer(true); }}
                  className="text-xs text-slate-700 cursor-pointer hover:bg-blue-50 rounded-lg p-2 border border-dashed border-slate-200 whitespace-pre-wrap leading-relaxed min-h-[2rem]"
                >
                  {q.answer
                    ? q.answer.replace(/\s*\|\s*/g, "\n")
                    : <span className="text-slate-300 italic">click to add answer</span>}
                </div>
              )}
            </div>
          );
        })()}

        {/* Re-extract Answer from the answer-key page(s).
            Surfaced for:
              • 阅读理解 A long OEQ (Chinese Q33) — answer key often
                spans multiple lines + a footnote; the auto-extract
                sometimes grabs just the footnote.
              • 阅读理解 B OEQ questions — the answer key for short
                OEQ frequently lives on a page far from the question,
                so the auto-extract may pick the wrong region.
            Every other Chinese question has its answer auto-extracted
            correctly and doesn't need the per-question rerun. */}
        {allowReextractAnswer && (
        <div className="mt-2 flex items-center gap-1 text-[10px]">
          <span className="text-slate-400 font-bold uppercase tracking-wider">Re-extract Ans from page</span>
          <input
            type="text"
            placeholder="e.g. 15 or 15-16"
            value={reextractAnsPages}
            onChange={e => setReextractAnsPages(e.target.value)}
            className="w-24 px-1.5 py-0.5 rounded border border-slate-200 focus:outline-none focus:border-amber-400 text-xs"
          />
          <button
            type="button"
            disabled={reextractAnsBusy || !reextractAnsPages.trim()}
            onClick={async () => {
              const indices: number[] = [];
              for (const part of reextractAnsPages.split(",")) {
                const t = part.trim();
                if (!t) continue;
                if (t.includes("-")) {
                  const [a, b] = t.split("-").map(s => parseInt(s.trim()));
                  if (!isNaN(a) && !isNaN(b)) {
                    for (let i = a; i <= b; i++) indices.push(i - 1);
                  }
                } else {
                  const n = parseInt(t);
                  if (!isNaN(n)) indices.push(n - 1);
                }
              }
              if (indices.length === 0) return;
              setReextractAnsBusy(true);
              setReextractAnsResult(null);
              try {
                const res = await fetch(`/api/exam/questions/${q.id}/reextract-answer`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ pageIndices: indices }),
                });
                const data = await res.json();
                if (!res.ok) {
                  setReextractAnsResult(`Error: ${data.error ?? "Re-extract failed"}`);
                } else {
                  setReextractAnsResult(`Saved. Reload to view.`);
                  await onSave(q.id, { answer: data.answer });
                }
              } catch (err) {
                setReextractAnsResult(`Error: ${err instanceof Error ? err.message : "network"}`);
              } finally {
                setReextractAnsBusy(false);
              }
            }}
            className="px-2 py-0.5 rounded-md bg-amber-50 hover:bg-amber-100 text-amber-700 font-bold disabled:opacity-50 transition-colors"
          >
            {reextractAnsBusy ? "Working…" : "Re-extract"}
          </button>
          {reextractAnsResult && (
            <span className={`text-[10px] ${reextractAnsResult.startsWith("Error") ? "text-red-600" : "text-green-600"}`}>{reextractAnsResult}</span>
          )}
        </div>
        )}
      </div>

      {/* Marks */}
      <div className="shrink-0 flex items-center gap-1">
        <input
          value={marksDraft}
          onChange={e => setMarksDraft(e.target.value.replace(/\D/g, ""))}
          onBlur={() => {
            const val = marksDraft ? Number(marksDraft) : null;
            if (val !== q.marksAvailable) {
              onSave(q.id, { marksAvailable: val });
            }
          }}
          className="w-8 text-xs text-center px-1 py-0.5 rounded border border-slate-200 focus:outline-none focus:border-blue-400"
          placeholder="m"
        />
        <span className="text-[10px] text-slate-400">m</span>
      </div>

      {/* Remove button */}
      {onDelete && (
        <button onClick={() => { if (confirm(`Remove Q${q.questionNum}?`)) onDelete(q.id); }}
          className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors"
          title="Remove question">
          <span className="material-symbols-outlined text-sm">close</span>
        </button>
      )}

      {/* Saving indicator */}
      {saving === q.id && (
        <span className="animate-spin rounded-full h-4 w-4 border-2 border-blue-200 border-t-blue-500 shrink-0" />
      )}
    </div>
  );
}

/** Renders OCR text with rich formatting: markdown tables, bold, error tags, underlines */
function OcrRichText({ text, isMcq }: { text: string; isMcq?: boolean }) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Markdown table detection: line with | separators
    if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      // Parse table.
      // Real separator rows have dashes in each cell (|---|---|).
      // We must NOT skip empty data rows like `| | |` — those are
      // student-input cells in the live quiz, and the admin preview
      // should show them so authors see what they're shipping.
      const SEP_RE = /^\s*\|[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|\s*$/;
      const rows = tableLines
        .filter(l => !SEP_RE.test(l))
        .map(l => l.trim().replace(/\|\s*$/, "|").split("|").slice(1, -1).map(c => c.trim()));

      if (rows.length > 0) {
        // Detect passage table (3 cols: Line#, Text, LineNo) — hide first col, justify text
        const isPassageTable = rows.length > 2 && rows[0]?.length === 3 &&
          (rows[0][0].toLowerCase().includes("line") || rows[0][0].match(/^\d*$/));

        if (isPassageTable) {
          // Skip header row, render as passage with line numbers
          const dataRows = rows[0][0].toLowerCase().includes("line") ? rows.slice(1) : rows;
          elements.push(
            <table key={`table-${i}`} className="text-sm my-2 w-full border-collapse">
              <tbody>
                {dataRows.map((row, ri) => {
                  const text = row[1] ?? "";
                  const lineNo = row[2] ?? "";
                  const isBlank = !text.trim();
                  const isIndented = text.startsWith("    ") || text.startsWith("\t");
                  return (
                    <tr key={ri} className={isBlank ? "h-4" : ""}>
                      <td className="text-slate-700 py-0.5 pr-4 text-justify leading-relaxed" style={{ textIndent: isIndented ? "2em" : 0 }}>
                        {isBlank ? "" : text.trim()}
                      </td>
                      <td className="text-slate-400 text-xs font-bold w-8 text-right align-top py-0.5 shrink-0">
                        {lineNo}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          );
        } else {
          // Regular table.
          // Apply the same `=` colspan rule used in the live quiz so the
          // preview matches what students will see. A cell containing
          // just `=` merges into the previous cell on that row.
          elements.push(
            <table key={`table-${i}`} className="border-collapse border border-slate-300 text-xs my-2 w-full">
              <tbody>
                {rows.map((row, ri) => {
                  const merged: { content: string; span: number }[] = [];
                  for (const c of row) {
                    if (c === "=" && merged.length > 0) merged[merged.length - 1].span += 1;
                    else merged.push({ content: c, span: 1 });
                  }
                  return (
                    <tr key={ri} className={ri === 0 ? "bg-slate-100 font-bold" : ""}>
                      {merged.map((m, ci) => (
                        <td
                          key={ci}
                          colSpan={m.span > 1 ? m.span : undefined}
                          className="border border-slate-200 px-2 py-1 text-center min-w-[3rem]"
                        >
                          {m.content || " "}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          );
        }
      }
      continue;
    }

    // Regular line — render with inline formatting
    // Skip extra underscore lines after a synthesis answer (already rendered as 2 lines)
    const isSynthLine = line.match(/^\*\*(.+?)\*\*\s*_+\s*$/);
    elements.push(<RichLine key={`line-${i}`} text={line} isMcq={isMcq} />);
    i++;
    // After a synth line, skip ONE standalone underscore line (it's already part of the 2-line render)
    if (isSynthLine && i < lines.length && lines[i].match(/^_+$/)) {
      i++;
    }
  }

  return (
    <div className="text-sm text-slate-700 bg-white border border-slate-100 rounded-xl p-3 max-h-96 overflow-y-auto">
      {elements}
    </div>
  );
}

/** Renders a single line with bold, error tags, underlines */
function RichLine({ text, isMcq }: { text: string; isMcq?: boolean }) {
  if (!text.trim()) return <br />;

  // Answer lines: [LINES: N] → render N full-width underlines
  const linesMatch = text.match(/^\[LINES:\s*(\d+)\]\s*$/);
  if (linesMatch) {
    const count = parseInt(linesMatch[1]);
    return (
      <div className="mt-1">
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="border-b-2 border-slate-300 mt-3" />
        ))}
      </div>
    );
  }

  // Synthesis answer line: bold starting word + underscores → full-width line
  const synthMatch = text.match(/^\*\*(.+?)\*\*\s*_+\s*$/);
  if (synthMatch) {
    return (
      <div className="mt-1">
        <div className="flex items-end">
          <strong className="font-bold text-slate-800 shrink-0 mr-1">{synthMatch[1]}</strong>
          <span className="flex-1 border-b-2 border-slate-400 mb-0.5" />
        </div>
        <div className="border-b-2 border-slate-400 mt-3 mb-1" />
      </div>
    );
  }

  // Full underscore line (second answer line for Synthesis)
  if (text.match(/^_+$/)) {
    return <div className="border-b-2 border-slate-400 mt-3 mb-1" />;
  }

  // Parse inline formatting: **bold**, [error:N]word[/error], [underline]word[/underline], ___(N)
  // Underline now uses isolated-`__` guards so it doesn't partially
  // match longer runs like "___ word __" (which would otherwise
  // underline " word ").
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|(?<!_)__(?!_)[^_\n](?:[^\n]*?[^_\n])?__(?!_)|\[error:\d+\][^[]+\[\/error\]|\[underline\][^[]+\[\/underline\]|___\(\d+\)|\[LINES:\s*\d+\]|\[x\]|\[ \]|\[DIAGRAM:[^\]]+\])/g;
  let lastIdx = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(text.slice(lastIdx, match.index));
    }
    const m = match[0];
    if (m.startsWith("**") && m.endsWith("**")) {
      const inner = m.slice(2, -2);
      // Check if it's a cloze blank like (29)________
      const clozeMatch = inner.match(/^\((\d+)\)_+$/);
      if (clozeMatch) {
        parts.push(
          <span key={match.index} className="inline-flex items-center gap-0.5 font-bold">
            <span className="text-blue-600 bg-blue-50 px-1 rounded text-[11px]">({clozeMatch[1]})</span>
            <span className="text-slate-400">________</span>
          </span>
        );
      } else {
        // Check if it's an editing error word like (39) beleive
        const editMatch = inner.match(/^\((\d+)\)\s+(.+)$/);
        if (editMatch) {
          parts.push(
            <span key={match.index} className="inline-flex items-center gap-1">
              <span className="text-[10px] font-bold text-blue-600 bg-blue-50 px-1 rounded">({editMatch[1]})</span>
              <span className="underline decoration-red-400 decoration-2 font-bold text-red-700">{editMatch[2]}</span>
              <span className="inline-block border-2 border-slate-300 rounded px-1 min-w-[10rem] h-6 bg-white" />
            </span>
          );
        } else {
          // Nested underline inside bold: "**__word__**" → bold + underline.
          // The flat regex doesn't recurse, so peel off matching __ pairs
          // and apply both classes when the inner is wholly wrapped.
          // Inner must NOT contain extra `_` on either side — otherwise
          // we'd be eating part of a blank-line run like "**___ X __**".
          const innerUnder = inner.match(/^__([^_].*?[^_])__$|^__(.)__$/);
          // Treat "**___…**" / "**…___**" (3+ underscores anywhere in
          // the bold) as a blank-line stamp, not as underlined text.
          // Render the literal underscores in bold, no underline.
          const isBlankRun = /___/.test(inner);
          if (innerUnder && !isBlankRun) {
            const word = innerUnder[1] ?? innerUnder[2] ?? "";
            parts.push(<strong key={match.index} className="font-bold text-slate-800 underline decoration-2">{word}</strong>);
          } else {
            parts.push(<strong key={match.index} className="font-bold text-slate-800">{inner}</strong>);
          }
        }
      }
    } else if (m.startsWith("__") && m.endsWith("__") && !m.startsWith("___")) {
      parts.push(<span key={match.index} className="underline decoration-2">{m.slice(2, -2)}</span>);
    } else if (m.startsWith("[error:")) {
      const numMatch = m.match(/\[error:(\d+)\]/);
      const word = m.replace(/\[error:\d+\]/, "").replace("[/error]", "");
      parts.push(
        <span key={match.index} className="inline-flex items-center gap-1">
          <span className="text-[10px] font-bold text-blue-600 bg-blue-50 px-1 rounded">Q{numMatch?.[1]}</span>
          <span className="underline decoration-red-400 decoration-2 font-medium text-red-700">{word}</span>
        </span>
      );
    } else if (m.startsWith("[underline]")) {
      const word = m.replace("[underline]", "").replace("[/underline]", "");
      parts.push(<span key={match.index} className="underline decoration-2">{word}</span>);
    } else if (m.match(/___\(\d+\)/)) {
      const num = m.match(/\((\d+)\)/)?.[1];
      parts.push(
        <span key={match.index} className="inline-flex items-center gap-0.5">
          <span className="border-b-2 border-slate-400 w-16 inline-block" />
          <span className="text-[10px] font-bold text-blue-600 bg-blue-50 px-1 rounded">({num})</span>
        </span>
      );
    } else if (m.match(/\[LINES:\s*\d+\]/)) {
      const count = parseInt(m.match(/\[LINES:\s*(\d+)\]/)?.[1] ?? "1");
      parts.push(
        <span key={match.index} className="block">
          {Array.from({ length: count }, (_, j) => (
            <span key={j} className="block border-b-2 border-slate-300 mt-3" />
          ))}
        </span>
      );
    } else if (m === "[x]") {
      parts.push(
        <span key={match.index} className="inline-flex items-center justify-center w-4 h-4 border-2 border-slate-400 rounded-sm bg-blue-50 text-blue-600 text-[10px] font-bold mr-1">✓</span>
      );
    } else if (m === "[ ]") {
      parts.push(
        <span key={match.index} className="inline-block w-4 h-4 border-2 border-slate-300 rounded-sm bg-white mr-1" />
      );
    } else if (m.startsWith("[DIAGRAM:")) {
      const desc = m.slice(9, -1).trim();
      parts.push(
        <span key={match.index} className="inline-block bg-slate-100 border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-600 italic my-1">
          📊 {desc}
        </span>
      );
    }
    lastIdx = match.index + m.length;
  }
  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx));
  }

  // Detect paragraph indent (leading spaces or tab)
  const indent = text.match(/^(\s{2,}|\t)/);
  return <p className="leading-relaxed" style={indent ? { textIndent: "2em" } : undefined}>{parts}</p>;
}
