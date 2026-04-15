"use client";

import { useEffect, useRef, useState } from "react";

interface QuizQuestion {
  id: string;
  questionNum: string;
  answer: string | null;
  imageData: string;
  transcribedStem: string | null;
  transcribedOptions: string[] | null;
  studentAnswer: string | null;
  marksAvailable: number | null;
  syllabusTopic: string | null;
}

interface Props {
  sectionLabel: string;
  passage: string | null;
  questions: QuizQuestion[];
  sectionType: "grammar-cloze" | "editing" | "comprehension-cloze" | "visual-text-mcq" | "synthesis" | "comprehension-oeq";
  answers: Record<string, string>;
  onAnswer: (questionId: string, answer: string) => void;
  tool?: "select" | "type" | "pen" | "eraser" | "eraser-large";
  onToolChange?: (tool: "type") => void;
  emptyFieldIds?: Set<string>;
  flaggedIds?: Set<string>;
  onToggleFlag?: (questionId: string) => void;
}

/**
 * Renders an English quiz section with typed answers:
 * - Grammar Cloze: passage with letter inputs (A-Q)
 * - Editing: passage with correction inputs
 * - Comprehension Cloze: passage with word inputs
 * - Visual Text MCQ: scanned image + MCQ options
 * - Synthesis: question stem with bold starting word + typed answer
 * - Comprehension OEQ: question stem with typed answer lines
 */
export default function EnglishQuizSection({ sectionLabel, passage, questions, sectionType, answers, onAnswer, tool = "type", onToolChange, emptyFieldIds, flaggedIds, onToggleFlag }: Props) {
  return (
    <div className="mb-12">
      {/* Section header */}
      <div className="mb-6">
        <div className="flex items-center gap-3">
          <h2 className="font-headline text-xl lg:text-2xl font-extrabold text-[#001e40] tracking-tight">{sectionLabel.toUpperCase()}</h2>
          {onToggleFlag && (sectionType === "grammar-cloze" || sectionType === "editing" || sectionType === "comprehension-cloze") && (() => {
            const allFlagged = questions.every(q => flaggedIds?.has(q.id));
            const anyFlagged = questions.some(q => flaggedIds?.has(q.id));
            return (
              <button
                onClick={() => {
                  // If all flagged → unflag all; otherwise → flag all
                  for (const q of questions) {
                    const isFlagged = flaggedIds?.has(q.id);
                    if (allFlagged && isFlagged) onToggleFlag(q.id); // unflag
                    if (!allFlagged && !isFlagged) onToggleFlag(q.id); // flag
                  }
                }}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold transition-colors ${anyFlagged ? "text-[#ba1a1a] bg-red-50" : "text-[#737780] hover:text-[#ba1a1a] hover:bg-red-50"}`}
                title={allFlagged ? "Unflag section" : "Flag section for review"}
              >
                <span className="material-symbols-outlined text-sm" style={anyFlagged ? { fontVariationSettings: "'FILL' 1", color: "#ba1a1a" } : undefined}>flag</span>
                Flag
              </button>
            );
          })()}
        </div>
        {sectionType === "grammar-cloze" && <p className="text-[#737780] mt-1 text-sm">From the list of words given, choose the most suitable word, and write its letter (A to Q) in the blank.</p>}
        {sectionType === "editing" && <p className="text-[#737780] mt-1 text-sm">Each of the underlined words contains either a spelling or grammatical error. Type the correct word in each of the boxes.</p>}
        {sectionType === "comprehension-cloze" && <p className="text-[#737780] mt-1 text-sm">Fill in each blank with a suitable word.</p>}
        {sectionType === "synthesis" && <p className="text-[#737780] mt-1 text-sm">Rewrite the given sentence(s) using the word(s) provided. Your answer must be in one sentence. The meaning of your sentence must be the same as the meaning of the given sentence(s).</p>}
      </div>

      {/* Visual Text: show scanned page images with drawing overlay */}
      {sectionType === "visual-text-mcq" && (
        <div className="relative">
          {tool === "pen" && <PassageScratchOverlay />}
          <VisualTextImages passage={passage ?? ""} fallbackImage={questions.find(q => q.imageData && q.imageData.length > 100)?.imageData} />
        </div>
      )}

      {/* Passage with inline inputs (Grammar Cloze, Editing, Comp Cloze) */}
      {passage && (sectionType === "grammar-cloze" || sectionType === "editing" || sectionType === "comprehension-cloze") && (
        <PassageWithInputs
          passage={passage}
          questions={questions}
          sectionType={sectionType}
          answers={answers}
          onAnswer={onAnswer}
          tool={tool}
          onFocusInput={() => onToolChange?.("type")}
          emptyFieldIds={emptyFieldIds}
        />
      )}

      {/* Comprehension OEQ: reading passage with drawing overlay */}
      {sectionType === "comprehension-oeq" && passage && (
        <div className="relative">
          {tool === "pen" && <PassageScratchOverlay />}
          <ReadingPassage text={passage} />
        </div>
      )}

      {/* Synthesis / Comprehension OEQ: typed answer sections */}
      {(sectionType === "synthesis" || sectionType === "comprehension-oeq") && (
        <div className="space-y-8">
          {questions.map((q) => {
            const stem = q.transcribedStem ?? "";
            const displayNum = parseInt(q.questionNum);

            // Parse lines count from stem: [Lines: N] or [N lines]
            const linesMatch = stem.match(/\[(?:Lines?:\s*)?(\d+)\s*(?:lines?)?\]/i);
            const lineCount = linesMatch ? parseInt(linesMatch[1]) : 2;
            const cleanStem = stem.replace(/\[(?:Lines?:\s*)?\d+\s*(?:lines?)?\]/gi, "").trim();

            // For synthesis: split into question text and answer segments
            // Answer line can be: "**Instead of** ___" or "___ **although** ___"
            let synthQuestion = "";
            const synthAnswerParts: { type: "input" | "keyword"; content: string; key: string }[] = [];
            if (sectionType === "synthesis") {
              const lines = cleanStem.split("\n");
              // Find the answer line(s): contain **bold** and/or ___
              const answerLineIdx = lines.findIndex(l => /\*\*[^*]+\*\*/.test(l) && /_{3,}/.test(l) || /^_{3,}/.test(l.trim()));
              if (answerLineIdx >= 0) {
                synthQuestion = lines.slice(0, answerLineIdx).join("\n").trim();
                // Parse answer line into segments: blanks become inputs, **bold** become keywords
                const answerLine = lines.slice(answerLineIdx).join("\n");
                const segRegex = /\*\*([^*]+)\*\*|_{3,}/g;
                let lastEnd = 0;
                let seg;
                let inputIdx = 0;
                while ((seg = segRegex.exec(answerLine)) !== null) {
                  // Skip plain text between segments
                  if (seg[1]) {
                    synthAnswerParts.push({ type: "keyword", content: seg[1].trim(), key: `kw${seg.index}` });
                  } else {
                    synthAnswerParts.push({ type: "input", content: "", key: `in${inputIdx++}` });
                  }
                  lastEnd = seg.index + seg[0].length;
                }
                // If no parts found, add a single input
                if (synthAnswerParts.length === 0) {
                  synthAnswerParts.push({ type: "input", content: "", key: "in0" });
                }
                // Starting word pattern: keyword first → only need 1 input after it
                if (synthAnswerParts[0]?.type === "keyword") {
                  const kwPart = synthAnswerParts[0];
                  synthAnswerParts.length = 0;
                  synthAnswerParts.push(kwPart, { type: "input", content: "", key: "in0" });
                }
              } else {
                synthQuestion = cleanStem.replace(/\*\*[^*]+\*\*/, "").replace(/_{3,}/g, "").trim();
                const boldMatch = cleanStem.match(/\*\*([^*]+)\*\*/);
                if (boldMatch) synthAnswerParts.push({ type: "keyword", content: boldMatch[1].trim(), key: "kw0" });
                synthAnswerParts.push({ type: "input", content: "", key: "in0" });
              }
            }

            return (
              <div key={q.id} className="bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100">
                <div className="flex items-start gap-3 mb-3">
                  <div className="flex flex-col items-center gap-1 shrink-0">
                    <span className="w-10 h-10 rounded-xl bg-[#001e40] flex items-center justify-center text-white font-bold text-sm">
                      {displayNum}
                    </span>
                    {onToggleFlag && (
                      <button
                        onClick={() => onToggleFlag(q.id)}
                        className="text-[10px] flex items-center gap-0.5 text-[#737780] hover:text-[#ba1a1a] transition-colors"
                      >
                        <span className="material-symbols-outlined text-sm" style={flaggedIds?.has(q.id) ? { fontVariationSettings: "'FILL' 1", color: "#ba1a1a" } : undefined}>flag</span>
                      </button>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    {sectionType === "synthesis" && synthQuestion && (
                      <RichStemText text={synthQuestion} answers={answers} questionId={q.id} onAnswer={onAnswer} />
                    )}
                    {sectionType === "synthesis" && !synthQuestion && q.imageData && q.imageData.length > 100 && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={q.imageData.startsWith("data:") ? q.imageData : `data:image/jpeg;base64,${q.imageData}`}
                        alt={`Question ${q.questionNum}`} className="max-w-full rounded-lg border border-slate-100 mb-2" />
                    )}
                    {sectionType === "comprehension-oeq" && (
                      <RichStemText text={cleanStem} answers={answers} questionId={q.id} onAnswer={onAnswer} />
                    )}
                    {q.marksAvailable && (
                      <span className="mt-2 inline-block text-[10px] font-bold text-[#003366] bg-[#d3e4fe] px-2 py-0.5 rounded uppercase tracking-wider">
                        {q.marksAvailable} {q.marksAvailable > 1 ? "marks" : "mark"}
                      </span>
                    )}
                  </div>
                </div>

                {/* Synthesis: keyword + input boxes */}
                {sectionType === "synthesis" && (() => {
                  const inputCount = synthAnswerParts.filter(p => p.type === "input").length;
                  const isStartingWord = inputCount === 1 && synthAnswerParts[0]?.type === "keyword";

                  const makeInput = (inputIdx: number, key: string) => {
                    const storedParts = (answers[q.id] ?? "").split("|||");
                    const value = inputCount > 1 ? (storedParts[inputIdx] ?? "") : (answers[q.id] ?? "");
                    return (
                      <input
                        key={key}
                        type="text"
                        spellCheck={false}
                        autoComplete="one-time-code"
                        autoCorrect="off"
                        autoCapitalize="none"
                        value={value}
                        onFocus={() => onToolChange?.("type")}
                        onChange={e => {
                          if (inputCount > 1) {
                            const parts = (answers[q.id] ?? "").split("|||");
                            while (parts.length < inputCount) parts.push("");
                            parts[inputIdx] = e.target.value;
                            onAnswer(q.id, parts.join("|||"));
                          } else {
                            onAnswer(q.id, e.target.value);
                          }
                        }}
                        className="flex-1 min-w-[120px] border-2 border-slate-200 focus:border-[#003366] outline-none rounded-lg px-3 py-2 text-base text-[#001e40]"
                        placeholder="Type your answer..."
                      />
                    );
                  };

                  if (isStartingWord) {
                    // Starting word: keyword + input on same line
                    return (
                      <div className="mt-3 ml-[52px] flex items-center gap-2">
                        <span className="font-bold text-base text-[#001e40] shrink-0">{synthAnswerParts[0].content}</span>
                        {makeInput(0, "in0")}
                      </div>
                    );
                  }

                  // Mid-sentence keyword: all inline — [input] keyword [input]
                  let inputIdx = 0;
                  return (
                    <div className="mt-3 ml-[52px] flex flex-wrap items-center gap-2">
                      {synthAnswerParts.map((part) => {
                        if (part.type === "keyword") {
                          return <span key={part.key} className="font-bold text-base text-[#001e40] shrink-0">{part.content}</span>;
                        }
                        const idx = inputIdx++;
                        return makeInput(idx, part.key);
                      })}
                    </div>
                  );
                })()}

                {/* Comprehension OEQ: typed answer lines (skip if question has a table for answers) */}
                {sectionType === "comprehension-oeq" && !cleanStem.includes("|") && (() => {
                  const stored = answers[q.id] ?? "";
                  const isJson = stored.startsWith("{");
                  let textVal = stored;
                  if (isJson) {
                    try { textVal = (JSON.parse(stored) as Record<string, string>)._text ?? ""; } catch { textVal = ""; }
                  }
                  return (
                    <div className="mt-3 ml-[52px]">
                      <textarea
                        spellCheck={false}
                        autoComplete="one-time-code"
                        autoCorrect="off"
                        autoCapitalize="none"
                        value={textVal}
                        onChange={e => {
                          if (isJson) {
                            let obj: Record<string, string> = {};
                            try { obj = JSON.parse(stored); } catch { /* ignore */ }
                            obj._text = e.target.value;
                            onAnswer(q.id, JSON.stringify(obj));
                          } else {
                            onAnswer(q.id, e.target.value);
                          }
                        }}
                        rows={lineCount}
                        className="w-full border-2 border-slate-200 focus:border-[#003366] outline-none rounded-xl px-4 py-3 text-base text-[#001e40] resize-none leading-relaxed"
                        placeholder="Type your answer here..."
                      />
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      )}

      {/* Visual Text MCQ: standard question + options */}
      {sectionType === "visual-text-mcq" && (
        <div className="space-y-6">
          <p className="text-sm text-[#737780] italic">Choose the most appropriate answer for each question.</p>
          {questions.map((q, idx) => (
            <div key={q.id} className="bg-white rounded-2xl p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-1">
                <p className="font-bold text-sm text-[#001e40]">Question {parseInt(q.questionNum)}</p>
                {onToggleFlag && (
                  <button onClick={() => onToggleFlag(q.id)} className="text-[#737780] hover:text-[#ba1a1a] transition-colors">
                    <span className="material-symbols-outlined text-sm" style={flaggedIds?.has(q.id) ? { fontVariationSettings: "'FILL' 1", color: "#ba1a1a" } : undefined}>flag</span>
                  </button>
                )}
              </div>
              {q.transcribedStem && (
                <p className="text-sm text-[#0b1c30] mb-3 whitespace-pre-wrap">{q.transcribedStem}</p>
              )}
              {q.transcribedOptions && (
                <div className="space-y-2">
                  {(q.transcribedOptions as string[]).map((opt, oi) => {
                    const optNum = String(oi + 1);
                    const selected = answers[q.id] === optNum;
                    return (
                      <button
                        key={oi}
                        onClick={() => onAnswer(q.id, optNum)}
                        className={`w-full text-left p-3 rounded-xl border-2 transition-all flex items-center gap-3 ${
                          selected ? "border-[#006c49] bg-[#6cf8bb]/10" : "border-slate-200 hover:border-[#003366]/30"
                        }`}
                      >
                        <span className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm shrink-0 ${
                          selected ? "bg-[#006c49] text-white" : "bg-[#eff4ff] text-[#001e40]"
                        }`}>{oi + 1}</span>
                        <span className="text-sm text-[#001e40]">{opt}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Renders a passage with inline text inputs for each question */
function PassageWithInputs({
  passage,
  questions,
  sectionType,
  answers,
  onAnswer,
  tool,
  onFocusInput,
  emptyFieldIds,
}: {
  passage: string;
  questions: QuizQuestion[];
  sectionType: "grammar-cloze" | "editing" | "comprehension-cloze";
  answers: Record<string, string>;
  onAnswer: (questionId: string, answer: string) => void;
  tool?: string;
  onFocusInput?: () => void;
  emptyFieldIds?: Set<string>;
}) {
  // Always use position-based mapping: passage blank i → questions[i]
  // This handles both renumbered and original numbering, and ignores stray markers
  const passageQNums: number[] = [];
  const seen = new Set<number>();
  const passageRegex = /\*\*\((\d+)\)/g;
  let pm;
  while ((pm = passageRegex.exec(passage)) !== null) {
    const n = parseInt(pm[1]);
    if (!seen.has(n)) { passageQNums.push(n); seen.add(n); }
  }
  const sortedQs = [...questions].sort((a, b) =>
    a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true })
  );
  const qNumToId = new Map<number, string>();
  const qNumToDisplayNum = new Map<number, number>();
  passageQNums.forEach((pn, i) => {
    if (i < sortedQs.length) {
      qNumToId.set(pn, sortedQs[i].id);
      qNumToDisplayNum.set(pn, parseInt(sortedQs[i].questionNum));
    }
  });

  // Parse passage and replace question markers with inputs
  const lines = passage.split("\n");

  return (
    <div className="bg-white rounded-2xl p-5 lg:p-8 shadow-sm border border-slate-100 relative">
      {tool === "pen" && <PassageScratchOverlay />}
      {lines.map((line, li) => {
        // Skip table separator rows (must check before table rows)
        if (line.match(/^\s*\|[\s-:|]+\|\s*$/)) return null;
        // Table rows
        if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
          return <TableLine key={li} line={line} />;
        }
        // Empty line = paragraph break
        if (!line.trim()) return <br key={li} />;

        return (
          <PassageLine
            key={li}
            line={line}
            sectionType={sectionType}
            qNumToId={qNumToId}
            qNumToDisplayNum={qNumToDisplayNum}
            answers={answers}
            onAnswer={onAnswer}
            onFocusInput={onFocusInput}
            emptyFieldIds={emptyFieldIds}
          />
        );
      })}
    </div>
  );
}

function TableLine({ line }: { line: string }) {
  const cells = line.trim().replace(/\|\s*$/, "|").split("|").slice(1, -1).map(c => c.trim());
  // Detect if this is a letter row (A-Q single uppercase letters)
  const isLetterRow = cells.every(c => /^[A-Q]$/.test(c));
  return (
    <div className="flex gap-2 my-1">
      {cells.map((cell, ci) => (
        <span key={ci} className={`flex-1 text-center text-xs text-[#001e40] bg-[#eff4ff] rounded px-2 py-1 ${isLetterRow ? "font-extrabold text-[#003366] underline" : "font-medium"}`}>{cell}</span>
      ))}
    </div>
  );
}

/** Renders rich text: bold, tables, tick boxes, answer lines */
function RichStemText({ text, answers, questionId, onAnswer }: {
  text: string;
  answers: Record<string, string>;
  questionId: string;
  onAnswer: (qId: string, answer: string) => void;
}) {
  // Parse table cell answers from stored JSON
  const storedAnswer = answers[questionId] ?? "";
  let tableCells: Record<string, string> = {};
  try { if (storedAnswer.startsWith("{")) tableCells = JSON.parse(storedAnswer); } catch { /* ignore */ }

  function updateTableCell(key: string, value: string) {
    const updated = { ...tableCells, [key]: value };
    // Also include non-table answer if present
    onAnswer(questionId, JSON.stringify(updated));
  }

  const lines = text.split("\n");
  let tableRowIdx = 0;
  let tickIdx = 0;
  return (
    <div className="space-y-1">
      {lines.map((line, li) => {
        const trimmed = line.trim();
        if (!trimmed) return <br key={li} />;
        // Table separator — skip
        if (trimmed.match(/^\|[\s-:|]+\|$/)) return null;
        // Table row
        if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
          const cells = trimmed.trim().replace(/\|\s*$/, "|").split("|").slice(1, -1).map(c => c.trim());
          const ri = tableRowIdx++;
          return (
            <div key={li} className="flex gap-1 my-1">
              {cells.map((cell, ci) => {
                const isBlank = !cell || cell.match(/^_{2,}$/);
                const isFirstCol = ci === 0;
                const cellKey = `r${ri}c${ci}`;
                if (isBlank) {
                  return (
                    <input
                      key={ci}
                      type="text"
                      spellCheck={false}
                      autoComplete="one-time-code"
                      autoCorrect="off"
                      autoCapitalize="none"
                      value={tableCells[cellKey] ?? ""}
                      onChange={e => updateTableCell(cellKey, e.target.value)}
                      className={`text-center text-sm font-medium text-[#001e40] bg-white rounded px-2 py-1.5 border-2 border-[#d3e4fe] focus:border-[#003366] outline-none ${isFirstCol ? "w-20 shrink-0" : "flex-1"}`}
                      placeholder="..."
                    />
                  );
                }
                return (
                  <span key={ci} className={`text-center text-xs font-medium text-[#001e40] bg-[#eff4ff] rounded px-2 py-1.5 border border-[#d3e4fe] ${isFirstCol ? "w-20 shrink-0" : "flex-1"}`}>
                    {cell}
                  </span>
                );
              })}
            </div>
          );
        }
        // Tick box: [ ] or [✓] or [x] — at start OR end of line
        const tickStartMatch = trimmed.match(/^\[[ x✓✗]\]\s*(.*)/i);
        const tickEndMatch = !tickStartMatch ? trimmed.match(/^(.*?)\s*\[[ x✓✗]\]\s*$/i) : null;
        if (tickStartMatch || tickEndMatch) {
          const tickKey = `tick${tickIdx++}`;
          const content = tickStartMatch ? tickStartMatch[1] : tickEndMatch![1];
          const isChecked = tableCells[tickKey] === "true";
          return (
            <label key={li} className="flex items-start gap-2 cursor-pointer text-base text-[#001e40] my-1">
              <input
                type="checkbox"
                checked={isChecked}
                onChange={e => updateTableCell(tickKey, e.target.checked ? "true" : "")}
                className="mt-1 w-4 h-4 accent-[#003366]"
              />
              <span>{renderInlineBold(content)}</span>
            </label>
          );
        }
        // Answer lines: [LINES: N]
        const linesMatch = trimmed.match(/^\[LINES:\s*(\d+)\]\s*$/i);
        if (linesMatch) {
          const count = parseInt(linesMatch[1]);
          return (
            <div key={li} className="my-1">
              {Array.from({ length: count }, (_, i) => (
                <div key={i} className="border-b-2 border-slate-300 my-3 h-5" />
              ))}
            </div>
          );
        }
        // Answer line: ___ (3+ underscores)
        if (trimmed.match(/^_{3,}$/)) {
          return <div key={li} className="border-b-2 border-slate-300 my-2 h-6" />;
        }
        // Regular text with inline bold
        return (
          <p key={li} className="text-base text-[#001e40] leading-relaxed">
            {renderInlineBold(trimmed)}
          </p>
        );
      })}
    </div>
  );
}

/** Render inline **bold** text */
function renderInlineBold(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  // Match **bold** or __underline__
  const regex = /\*\*([^*]+)\*\*|__([^_]+)__/g;
  let lastIdx = 0;
  let m;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > lastIdx) parts.push(<span key={`t${lastIdx}`}>{text.slice(lastIdx, m.index)}</span>);
    if (m[1]) {
      parts.push(<strong key={`b${m.index}`} className="font-bold">{m[1]}</strong>);
    } else {
      parts.push(<span key={`u${m.index}`} className="underline decoration-2">{m[2]}</span>);
    }
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) parts.push(<span key="end">{text.slice(lastIdx)}</span>);
  return parts.length > 0 ? parts : [<span key="plain">{text}</span>];
}

function PassageLine({
  line,
  sectionType,
  qNumToId,
  qNumToDisplayNum,
  answers,
  onAnswer,
  onFocusInput,
  emptyFieldIds,
}: {
  line: string;
  sectionType: "grammar-cloze" | "editing" | "comprehension-cloze";
  qNumToId: Map<number, string>;
  qNumToDisplayNum: Map<number, number>;
  answers: Record<string, string>;
  onAnswer: (questionId: string, answer: string) => void;
  onFocusInput?: () => void;
  emptyFieldIds?: Set<string>;
}) {
  // Parse bold markers with question numbers: **(29)________** or **(39) beleive**
  const parts: React.ReactNode[] = [];
  const regex = /\*\*\((\d+)\)([^*]*)\*\*/g;
  let lastIdx = 0;
  let match;

  while ((match = regex.exec(line)) !== null) {
    // Add text before the match
    if (match.index > lastIdx) {
      parts.push(<span key={`t${lastIdx}`}>{...renderInlineBold(line.slice(lastIdx, match.index))}</span>);
    }

    const qNum = parseInt(match[1]);
    const displayNum = qNumToDisplayNum.get(qNum) ?? qNum;
    const content = match[2].trim();
    const qId = qNumToId.get(qNum);

    if (sectionType === "grammar-cloze" || sectionType === "comprehension-cloze") {
      // Cloze: show question number + text input
      parts.push(
        <span key={`q${qNum}`} className="relative z-20 inline-flex items-center gap-1 mx-1">
          <span className="text-[10px] font-bold text-blue-600 bg-blue-50 px-1 rounded">({displayNum})</span>
          <input
            type="text"
            spellCheck={false}
            autoComplete="one-time-code"
            autoCorrect="off"
            autoCapitalize={sectionType === "grammar-cloze" ? "characters" : "none"}
            value={qId ? (answers[qId] ?? "") : ""}
            onChange={e => qId && onAnswer(qId, sectionType === "grammar-cloze" ? e.target.value.toUpperCase() : e.target.value)}
            onFocus={onFocusInput}
            className={`border-b-2 ${qId && emptyFieldIds?.has(qId) ? "border-red-500 bg-red-50" : "border-slate-300"} focus:border-[#003366] outline-none text-center font-bold text-sm bg-transparent ${
              sectionType === "grammar-cloze" ? "w-16" : "w-24"
            }`}
            maxLength={sectionType === "grammar-cloze" ? 8 : 20}
            placeholder={sectionType === "grammar-cloze" ? "_" : "________"}
          />
        </span>
      );
    } else if (sectionType === "editing") {
      // Editing: show question number + error word + correction input
      parts.push(
        <span key={`q${qNum}`} className="relative z-20 inline-flex items-center gap-1 mx-1">
          <span className="text-[10px] font-bold text-blue-600 bg-blue-50 px-1 rounded">({displayNum})</span>
          <span className="underline decoration-red-400 decoration-2 font-bold text-red-700 text-sm">{content}</span>
          <input
            type="text"
            value={qId ? (answers[qId] ?? "") : ""}
            onChange={e => qId && onAnswer(qId, e.target.value)}
            onFocus={onFocusInput}
            spellCheck={false}
            autoComplete="one-time-code"
            autoCorrect="off"
            autoCapitalize="none"
            className={`border-2 ${qId && emptyFieldIds?.has(qId) ? "border-red-500 bg-red-50" : "border-slate-200"} focus:border-[#003366] outline-none rounded px-2 py-0.5 text-sm w-28 bg-white`}
            placeholder="correct word"
          />
        </span>
      );
    }

    lastIdx = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIdx < line.length) {
    parts.push(<span key={`end`}>{...renderInlineBold(line.slice(lastIdx))}</span>);
  }

  // Detect paragraph indent
  const indent = line.match(/^(\s{2,}|\t)/);

  return (
    <p className="leading-relaxed text-base text-[#0b1c30] my-1" style={indent ? { textIndent: "2em" } : undefined}>
      {parts.length > 0 ? parts : line}
    </p>
  );
}

/** Loads and displays Visual Text scanned page images */
function VisualTextImages({ passage, fallbackImage }: { passage: string; fallbackImage?: string }) {
  const [pageImages, setPageImages] = useState<string[]>([]);

  useEffect(() => {
    // Parse [VISUAL_PAGES:paperId:0,1,2] format
    const pagesMatch = passage.match(/^\[VISUAL_PAGES:([^:]+):([^\]]+)\]$/);
    if (pagesMatch) {
      const paperId = pagesMatch[1];
      const pageIndices = pagesMatch[2].split(",").map(Number);
      Promise.all(
        pageIndices.map(async (pageIdx) => {
          try {
            const res = await fetch(`/api/exam/${paperId}/pages?page=${pageIdx}`);
            if (res.ok) {
              const blob = await res.blob();
              return URL.createObjectURL(blob);
            }
          } catch { /* ignore */ }
          return null;
        })
      ).then(urls => setPageImages(urls.filter(Boolean) as string[]));
      return;
    }

    // Parse [VISUAL_TEXT_SOURCE:paperId] — load pages from source paper
    // Visual text pages are typically the 2-3 pages before the last few question pages
    const sourceMatch = passage.match(/^\[VISUAL_TEXT_SOURCE:([^\]]+)\]$/);
    if (sourceMatch) {
      const paperId = sourceMatch[1];
      fetch(`/api/exam/${paperId}/pages`)
        .then(r => r.json())
        .then(async ({ pageCount }: { pageCount: number }) => {
          if (!pageCount || pageCount < 2) return;
          // Load all pages and let user see them — better than nothing
          const startPage = Math.max(0, pageCount - 4); // last 4 pages likely contain VT
          const urls = await Promise.all(
            Array.from({ length: pageCount - startPage }, (_, i) => startPage + i).map(async (pageIdx) => {
              try {
                const res = await fetch(`/api/exam/${paperId}/pages?page=${pageIdx}`);
                if (res.ok) {
                  const blob = await res.blob();
                  return URL.createObjectURL(blob);
                }
              } catch { /* ignore */ }
              return null;
            })
          );
          setPageImages(urls.filter(Boolean) as string[]);
        })
        .catch(() => {});
    }
  }, [passage]);

  // Inline image
  if (passage.startsWith("data:image")) {
    return (
      <div className="mb-6 rounded-2xl overflow-hidden border border-[#d3e4fe]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={passage} alt="Visual text" className="w-full h-auto" />
      </div>
    );
  }

  // Loaded page images
  if (pageImages.length > 0) {
    return (
      <div className="mb-6 space-y-2">
        {pageImages.map((url, i) => (
          <div key={i} className="rounded-2xl overflow-hidden border border-[#d3e4fe]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt={`Visual text page ${i + 1}`} className="w-full h-auto" />
          </div>
        ))}
      </div>
    );
  }

  // Fallback: use question imageData
  if (fallbackImage) {
    return (
      <div className="mb-6 rounded-2xl overflow-hidden border border-[#d3e4fe]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={fallbackImage} alt="Visual text" className="w-full h-auto" />
      </div>
    );
  }

  return null;
}

/** Renders reading passage with line numbers (for Comp OEQ) */
function ReadingPassage({ text }: { text: string }) {
  const lines = text.split("\n");
  // Check if it's a markdown table format (| Line | Text | No. |)
  const isTable = lines.some(l => l.trim().startsWith("|") && l.trim().endsWith("|") && !l.match(/^\s*\|[\s-:|]+\|\s*$/));

  if (isTable) {
    // Parse table rows, skip header separator
    const rows: string[][] = [];
    let pastHeader = false;
    for (const line of lines) {
      if (line.match(/^\s*\|[\s-:|]+\|\s*$/)) { pastHeader = true; continue; }
      if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
        pastHeader = true;
        rows.push(line.trim().replace(/\|\s*$/, "|").split("|").slice(1, -1).map(c => c.trim()));
      } else if (pastHeader && !line.trim()) {
        // Empty line between table rows = paragraph break
        rows.push(["", "", ""]);
      }
    }
    // First row is header — skip it
    const dataRows = rows.length > 1 ? rows.slice(1) : rows;
    // Use original 3rd column for line numbers if available, else compute
    const hasThirdCol = dataRows.some(cells => cells.length >= 3 && cells[2]?.trim());
    let nonBlankCount = 0;
    const marginNums = dataRows.map(cells => {
      if (hasThirdCol) return cells[2]?.trim() ?? "";
      const textContent = cells[1]?.trim() ?? "";
      const lineNum = cells[0]?.trim() ?? "";
      if (textContent && lineNum) {
        nonBlankCount++;
        return nonBlankCount % 5 === 0 ? String(nonBlankCount) : "";
      }
      return "";
    });
    return (
      <div className="mb-8 bg-white rounded-2xl p-4 lg:p-6 shadow-sm border border-slate-100 max-h-[600px] overflow-y-auto overflow-x-hidden w-full">
        <div>
          {dataRows.map((cells, ri) => {
            const textContent = cells[1]?.trim() ?? "";
            const isEmpty = !textContent && !cells[0]?.trim();
            const isIndented = textContent.startsWith("    ") || textContent.startsWith("\t");
            const marginNum = marginNums[ri];
            if (isEmpty) return <div key={ri} className="h-6" />;
            return (
              <div key={ri} className="flex gap-2 min-h-[1.3rem]">
                <p className={`flex-1 text-[11px] lg:text-[13px] text-[#0b1c30] leading-relaxed text-justify ${isIndented ? "pl-8 mt-1" : ""}`} style={{ overflowWrap: "break-word", wordBreak: "break-word" }}>
                  {textContent.replace(/^\s+/, "")}
                </p>
                {marginNum ? <span className="w-5 text-right text-[10px] lg:text-xs text-[#003366] font-bold font-mono shrink-0 pt-0.5">{marginNum}</span> : <span className="w-5 shrink-0" />}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Plain text fallback
  return (
    <div className="mb-8 bg-white rounded-2xl p-4 lg:p-6 shadow-sm border border-slate-100 max-h-[600px] overflow-y-auto overflow-x-hidden w-full">
      <p className="text-[12px] lg:text-[14px] text-[#0b1c30] leading-relaxed whitespace-pre-wrap text-justify" style={{ overflowWrap: "break-word", wordBreak: "break-word" }}>{text}</p>
    </div>
  );
}

/** Transparent drawing overlay for passage annotation (underlining, circling) */
function PassageScratchOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawing = useRef(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);

  function getPos(e: React.PointerEvent) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * (canvas.width / rect.width), y: (e.clientY - rect.top) * (canvas.height / rect.height) };
  }

  function onDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    isDrawing.current = true;
    lastPos.current = getPos(e);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onMove(e: React.PointerEvent) {
    if (!isDrawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !lastPos.current) return;
    const pos = getPos(e);
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = "rgba(0, 102, 204, 0.4)";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(lastPos.current.x, lastPos.current.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    lastPos.current = pos;
  }

  function onUp() { isDrawing.current = false; lastPos.current = null; }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const obs = new ResizeObserver(() => {
      const w = parent.offsetWidth;
      const h = parent.offsetHeight;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.width = w * 2;
      canvas.height = h * 2;
    });
    obs.observe(parent);
    return () => obs.disconnect();
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 z-10 pointer-events-auto"
      style={{ touchAction: "none" }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    />
  );
}
