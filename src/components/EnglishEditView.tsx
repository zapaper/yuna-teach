"use client";

import { useState } from "react";
import { ExamPaperDetail, ExamQuestionItem } from "@/types";

interface Props {
  paper: ExamPaperDetail;
  pageImages: string[];
  onSave: (questionId: string, data: Record<string, unknown>) => Promise<void>;
  onSaveOcr?: (sectionName: string, ocrText: string) => Promise<void>;
  onRegenerateOcr?: (sectionName: string) => Promise<void>;
  saving: string | null;
}

// Group questions by syllabusTopic into sections
function groupBySection(questions: ExamQuestionItem[]) {
  const sections: Array<{ name: string; questions: ExamQuestionItem[] }> = [];
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

  for (const name of order) {
    sections.push({ name, questions: sectionMap.get(name)! });
  }
  return sections;
}

export default function EnglishEditView({ paper, pageImages, onSave, onSaveOcr, onRegenerateOcr, saving }: Props) {
  const metadata = paper.metadata;
  const ocrTexts = metadata?.sectionOcrTexts ?? {};
  const sections = groupBySection(paper.questions);

  const [expandedSection, setExpandedSection] = useState<string | null>(sections[0]?.name ?? null);
  const [editingOcr, setEditingOcr] = useState<string | null>(null);
  const [ocrDrafts, setOcrDrafts] = useState<Record<string, string>>({});
  const [editingPassage, setEditingPassage] = useState<string | null>(null);
  const [passageDrafts, setPassageDrafts] = useState<Record<string, string>>({});

  return (
    <div className="space-y-6">
      {sections.map(sec => {
        const isExpanded = expandedSection === sec.name;
        // Try exact match first, then fuzzy match on section name
        const ocrData = ocrTexts[sec.name] ?? Object.entries(ocrTexts).find(([k]) =>
          k.toLowerCase().replace(/\s+/g, "").includes(sec.name.toLowerCase().replace(/\s+/g, "").slice(0, 10))
        )?.[1] ?? null;
        const sectionPageIndices = ocrData?.pageIndices ?? [];

        return (
          <div key={sec.name} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
            {/* Section header */}
            <button
              onClick={() => setExpandedSection(isExpanded ? null : sec.name)}
              className="w-full flex items-center justify-between p-4 hover:bg-slate-50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <SectionBadge name={sec.name} />
                <div className="text-left">
                  <h3 className="font-bold text-sm text-slate-800">{sec.name}</h3>
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

                {/* Passage OCR text (line-numbered table) — editable */}
                {ocrData?.passageOcrText && (
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

                {/* OCR text */}
                {ocrData && (
                  <div className="p-4 border-b border-slate-100">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">OCR Text</p>
                      <button
                        onClick={() => {
                          if (editingOcr === sec.name) {
                            setEditingOcr(null);
                          } else {
                            setOcrDrafts(prev => ({ ...prev, [sec.name]: ocrData.ocrText }));
                            setEditingOcr(sec.name);
                          }
                        }}
                        className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                      >
                        {editingOcr === sec.name ? "Cancel" : "Edit"}
                      </button>
                    </div>
                    {editingOcr === sec.name ? (
                      <div>
                        <textarea
                          value={ocrDrafts[sec.name] ?? ocrData.ocrText}
                          onChange={e => setOcrDrafts(prev => ({ ...prev, [sec.name]: e.target.value }))}
                          rows={12}
                          className="w-full text-xs font-mono bg-white border border-slate-200 rounded-xl p-3 focus:outline-none focus:border-blue-400 resize-y"
                        />
                        <div className="flex gap-2 mt-2">
                          {onSaveOcr && (
                            <button
                              onClick={async () => {
                                await onSaveOcr(sec.name, ocrDrafts[sec.name] ?? ocrData.ocrText);
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
                    ) : (
                      <OcrRichText text={ocrData.ocrText} isMcq={sec.name.toLowerCase().includes("mcq")} />
                    )}
                  </div>
                )}

                {/* Questions */}
                <div className="p-4">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-3">
                    Questions & Answers
                  </p>
                  <div className="space-y-3">
                    {sec.questions.map(q => (
                      <QuestionRow
                        key={q.id}
                        question={q}
                        onSave={onSave}
                        saving={saving}
                      />
                    ))}
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
  saving,
}: {
  question: ExamQuestionItem;
  onSave: (questionId: string, data: Record<string, unknown>) => Promise<void>;
  saving: string | null;
}) {
  const [editAnswer, setEditAnswer] = useState(false);
  const [answerDraft, setAnswerDraft] = useState(q.answer ?? "");
  const [marksDraft, setMarksDraft] = useState(q.marksAvailable != null ? String(q.marksAvailable) : "");
  const [editingStem, setEditingStem] = useState(false);
  const [stemDraft, setStemDraft] = useState(q.transcribedStem ?? "");
  const [redoingTable, setRedoingTable] = useState(false);
  const [showTopicMenu, setShowTopicMenu] = useState(false);

  return (
    <div className="flex items-start gap-3 p-3 rounded-xl bg-slate-50 border border-slate-100">
      {/* Question number */}
      <div className="flex flex-col items-center gap-1 shrink-0">
        <span className="w-8 h-8 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-xs font-bold text-slate-700">
          {q.questionNum}
        </span>
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
                    const oldTopic = q.syllabusTopic ?? "";
                    await onSave(q.id, { syllabusTopic: topic });
                    // Copy sectionOcrTexts entry from old topic to new if needed
                    if (oldTopic && oldTopic !== topic) {
                      const meta = paper.metadata ?? {};
                      const ocrTexts = (meta as Record<string, unknown>).sectionOcrTexts as Record<string, Record<string, unknown>> | undefined;
                      if (ocrTexts) {
                        const oldEntry = ocrTexts[oldTopic] ?? Object.values(ocrTexts).find((_, i) => Object.keys(ocrTexts)[i].toLowerCase().includes(oldTopic.toLowerCase().split(" ")[0]));
                        if (oldEntry && !ocrTexts[topic]) {
                          ocrTexts[topic] = { ...oldEntry };
                          await fetch(`/api/exam/${paper.id}`, {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ metadata: { ...meta, sectionOcrTexts: ocrTexts } }),
                          });
                        }
                      }
                    }
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
          // For Synthesis: split question text from answer area (**Word** ____)
          let questionText = stem;
          let answerArea = "";
          if (stem && q.syllabusTopic?.toLowerCase().includes("synthesis")) {
            const synthSplit = stem.match(/^([\s\S]*?)(\*\*.+?\*\*\s*_+[\s\S]*)$/);
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
              {options.length > 0 && (
                <div className="flex flex-col gap-0.5 mt-2 mb-2 ml-4">
                  {options.map((opt, i) => (
                    <span key={i} className="text-xs text-slate-600">
                      <span className="font-bold text-slate-400">({i + 1})</span> {opt}
                    </span>
                  ))}
                </div>
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

        {/* Fallback: image if no text content */}
        {!q.transcribedStem && q.imageData && (
          <img
            src={q.imageData}
            alt={`Q${q.questionNum}`}
            className="max-h-16 rounded border border-slate-200 mb-2"
          />
        )}

        {/* Answer */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold text-slate-400 uppercase shrink-0">Ans:</span>
          {editAnswer ? (
            <input
              value={answerDraft}
              onChange={e => setAnswerDraft(e.target.value)}
              onBlur={() => {
                if (answerDraft !== (q.answer ?? "")) {
                  onSave(q.id, { answer: answerDraft || null });
                }
                setEditAnswer(false);
              }}
              onKeyDown={e => {
                if (e.key === "Enter") {
                  (e.target as HTMLInputElement).blur();
                }
              }}
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
      // Parse table
      const rows = tableLines
        .filter(l => !l.match(/^\s*\|[\s-|]+\|\s*$/)) // skip separator rows
        .map(l => l.split("|").slice(1, -1).map(c => c.trim()));

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
          // Regular table
          elements.push(
            <table key={`table-${i}`} className="border-collapse border border-slate-300 text-xs my-2 w-full">
              <tbody>
                {rows.map((row, ri) => (
                  <tr key={ri} className={ri === 0 ? "bg-slate-100 font-bold" : ""}>
                    {row.map((cell, ci) => (
                      <td key={ci} className="border border-slate-200 px-2 py-1 text-center">{cell}</td>
                    ))}
                  </tr>
                ))}
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
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|__[^_]+__|\[error:\d+\][^[]+\[\/error\]|\[underline\][^[]+\[\/underline\]|___\(\d+\)|\[LINES:\s*\d+\]|\[x\]|\[ \]|\[DIAGRAM:[^\]]+\])/g;
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
          parts.push(<strong key={match.index} className="font-bold text-slate-800">{inner}</strong>);
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
