"use client";

import { useEffect, useRef, useState } from "react";
import FormattedText from "./FormattedText";
import ChineseHandwritingCanvas from "./ChineseHandwritingCanvas";

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
  tool?: "type" | "pen" | "eraser" | "eraser-large";
  onToolChange?: (tool: "type") => void;
  emptyFieldIds?: Set<string>;
  flaggedIds?: Set<string>;
  onToggleFlag?: (questionId: string) => void;
  // When true and sectionType is visual-text-mcq or comprehension-oeq,
  // render the passage and questions side-by-side on lg+ (tablet/
  // desktop) so the student doesn't need to scroll between them.
  // Each pane scrolls independently. Below lg falls back to the
  // single-column stacked layout.
  splitScreen?: boolean;
}

/**
 * Renders a Chinese (华文) quiz section with typed answers. Forked from
 * EnglishQuizSection so the two pathways can evolve independently. The
 * section-type union is reused — Chinese sections map onto the same
 * renderer shapes as English ones:
 *   - 完成对话           → grammar-cloze (word bank + numbered blanks)
 *   - 短文填空           → visual-text-mcq (passage + numbered options)
 *   - 阅读理解 MCQ       → visual-text-mcq (passage + comprehension MCQ)
 *   - Visual Text + OEQ → visual-text-mcq + comprehension-oeq tail
 *   - 阅读理解 OEQ       → comprehension-oeq (passage + typed answer)
 * Editing and Synthesis renderers are present but unused for Chinese
 * (no equivalent sections in 华文); kept for shape compatibility.
 */
export default function ChineseQuizSection({ sectionLabel, passage, questions, sectionType, answers, onAnswer, tool = "type", onToolChange, emptyFieldIds, flaggedIds, onToggleFlag, splitScreen }: Props) {
  // Split-screen renders the passage column and the questions column
  // side-by-side in a 50/50 grid that fills the viewport on lg+
  // (tablet/desktop). Each column scrolls independently. Only applied
  // to passage-bound comp sections — other section types ignore the
  // flag. Below lg, falls back to the single-column stacked layout.
  const useSplitScreen = !!splitScreen && (sectionType === "visual-text-mcq" || sectionType === "comprehension-oeq");
  // Full-bleed: break out of the parent's max-w-4xl on lg+ so the
  // split panes use the entire viewport width. The
  // `mx-[calc(-50vw+50%)] w-screen` trick centers the element across
  // the viewport regardless of how narrow the parent container is.
  // Re-add comfortable horizontal padding so the content doesn't sit
  // against the edge.
  const outerCls = useSplitScreen
    ? "mb-12 lg:grid lg:grid-cols-2 lg:gap-6 lg:grid-rows-[auto_1fr] lg:h-[calc(100vh-96px)] lg:w-screen lg:max-w-none lg:mx-[calc(-50vw+50%)] lg:my-[-32px] lg:px-8 xl:px-16 lg:py-4"
    : "mb-12";
  // Tighten the section header in split-screen — the header bar
  // shouldn't eat into the precious viewport-height the passage and
  // questions panes rely on. Smaller bottom margin + smaller heading
  // font on lg+.
  const headerCls = useSplitScreen ? "lg:col-span-2 lg:mb-0" : "";
  const headerInnerCls = useSplitScreen ? "mb-6 lg:mb-2" : "mb-6";
  const headerTitleCls = useSplitScreen
    ? "font-headline text-xl lg:text-base font-extrabold text-[#001e40] tracking-tight"
    : "font-headline text-xl lg:text-2xl font-extrabold text-[#001e40] tracking-tight";
  const splitPassageCls = useSplitScreen ? "lg:row-start-2 lg:col-start-1 lg:overflow-y-auto lg:pr-2 lg:min-h-0" : "";
  const splitQuestionsCls = useSplitScreen ? "lg:row-start-2 lg:col-start-2 lg:overflow-y-auto lg:pl-2 lg:min-h-0" : "";
  return (
    <div className={outerCls}>
      <div className={headerCls}>
      {/* Section header */}
      <div className={headerInnerCls}>
        <div className="flex items-center gap-3">
          <h2 className={headerTitleCls}>{sectionLabel.toUpperCase()}</h2>
          {onToggleFlag && (sectionType === "grammar-cloze" || sectionType === "editing" || sectionType === "comprehension-cloze") && questions.length > 0 && (() => {
            const firstQ = questions[0];
            const isFlagged = !!flaggedIds?.has(firstQ.id);
            return (
              <button
                onClick={() => onToggleFlag(firstQ.id)}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold transition-colors ${isFlagged ? "text-[#ba1a1a] bg-red-50" : "text-[#737780] hover:text-[#ba1a1a] hover:bg-red-50"}`}
                title={isFlagged ? "Unflag section" : "Flag section for review"}
              >
                <span className="material-symbols-outlined text-sm" style={isFlagged ? { fontVariationSettings: "'FILL' 1", color: "#ba1a1a" } : undefined}>flag</span>
                Flag
              </button>
            );
          })()}
        </div>
        {/* Section sub-headings are English copy from the English
            forks. Chinese sections suppress them — the original 华文
            paper prints no English instructions and the student
            shouldn't see one. */}
      </div>
      </div>

      {/* Passage column for visual-text-mcq. Two flavours:
          - True Visual Text (poster / 漫画): passage is a sentinel
            "[VISUAL_PAGES:…]" or an image data URL; render as page
            images with the existing VisualTextImages component.
          - Chinese 阅读理解 MCQ: passage is plain Chinese text. Render
            it as paragraphs with a tab-indent on each new line so the
            student reads it as a normal passage. */}
      {sectionType === "visual-text-mcq" && !sectionLabel.includes("短文填空") && (() => {
        const isImagePassage = !!passage && (passage.startsWith("[VISUAL_") || passage.startsWith("data:image"));
        const hasTextPassage = !!passage && !isImagePassage;
        // The OCR step emits the passage as a 3-col line-numbered
        // markdown table (| Line | Text | No. |). Plain Chinese prose
        // reads better without the table chrome — strip the wrapper,
        // collapse line-wraps inside each paragraph, and treat blank
        // rows OR rows that start with a tab/4-space indent as
        // paragraph boundaries.
        function toParagraphs(raw: string): string[] {
          // Detect table shape
          const lines = raw.split("\n");
          const isTableRow = (l: string) => l.trim().startsWith("|") && l.trim().endsWith("|");
          const tableLines = lines.filter(isTableRow);
          const looksLikeTable = tableLines.length >= 3 && /^\s*\|\s*-+\s*\|/.test(tableLines[1] ?? "");
          if (looksLikeTable) {
            const dataLines = tableLines
              .filter(l => !/^\s*\|[\s|:-]+\|\s*$/.test(l))
              .slice(1); // drop header row
            const paras: string[] = [];
            let cur = "";
            const pushCur = () => { if (cur.trim()) paras.push(cur.replace(/^[\s\t]+/, "").trim()); cur = ""; };
            for (const row of dataLines) {
              const cols = row.trim().replace(/\|\s*$/, "|").split("|").slice(1, -1).map(c => c);
              const rawCell = cols[1] ?? "";
              // Markdown cells are padded with a single space inside the
              // pipes (` text `). Strip ONE leading space so a tab or
              // 4-space paragraph indent that the OCR placed right after
              // the pipe shows up at position 0.
              const cell = rawCell.startsWith(" ") ? rawCell.slice(1) : rawCell;
              const text = cell.replace(/^[\s\t]+|\s+$/g, "");
              const isIndentedRow = /^\t| {2,}/.test(cell);
              if (!text) { pushCur(); continue; }
              if (isIndentedRow && cur) { pushCur(); }
              cur += text;
            }
            pushCur();
            return paras;
          }
          // Non-table — split on blank lines OR on tab-indented line starts.
          return raw.split(/\n\s*\n+/).map(p => p.replace(/^[\s\t]+/, "").trim()).filter(Boolean);
        }
        const paragraphs = hasTextPassage ? toParagraphs(passage!) : [];
        return (
          <div className={`relative ${splitPassageCls}`}>
            {tool === "pen" && <PassageScratchOverlay />}
            {hasTextPassage ? (
              <div className="bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100">
                {paragraphs.map((para, pi) => (
                  <p key={pi} className="text-base text-[#0b1c30] leading-loose mb-3 last:mb-0" style={{ textIndent: "2em", whiteSpace: "pre-wrap" }}>
                    {para}
                  </p>
                ))}
              </div>
            ) : (
              <VisualTextImages passage={passage ?? ""} fallbackImage={questions.find(q => q.imageData && q.imageData.length > 100)?.imageData} />
            )}
          </div>
        );
      })()}

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
        <div className={`relative ${splitPassageCls}`}>
          {tool === "pen" && <PassageScratchOverlay />}
          <ReadingPassage text={passage} />
        </div>
      )}

      {/* Synthesis / Comprehension OEQ: typed answer sections */}
      {(sectionType === "synthesis" || sectionType === "comprehension-oeq") && (
        <div className={`space-y-8 ${sectionType === "comprehension-oeq" ? splitQuestionsCls : ""}`}>

          {questions.map((q) => {
            const stem = q.transcribedStem ?? "";
            const displayNum = parseInt(q.questionNum);

            // Parse lines count from stem: [Lines: N] or [N lines]
            const linesMatch = stem.match(/\[(?:Lines?:\s*)?(\d+)\s*(?:lines?)?\]/i);
            const lineCount = linesMatch ? parseInt(linesMatch[1]) : 2;
            // For comp-OEQ we keep the [LINES: N] / ___ markers in the stem so
            // RichStemText can render them as actual textareas (one per subpart).
            // For synthesis we strip them — synthesis has its own marker logic.
            const stemForRender = sectionType === "comprehension-oeq" ? stem.trim() : stem.replace(/\[(?:Lines?:\s*)?\d+\s*(?:lines?)?\]/gi, "").trim();
            const cleanStem = stem.replace(/\[(?:Lines?:\s*)?\d+\s*(?:lines?)?\]/gi, "").trim();
            // The outer fallback textarea fires when there are no inline answer
            // markers (no table, no [LINES: N], no standalone ___, no tick
            // boxes). With any marker present, RichStemText renders per-position
            // inputs and the outer textarea would be a duplicate. Tick-box-only
            // comp-OEQ used to slip through and got an extra empty textarea
            // appended below the boxes — adding the [ ]/[x]/[✓] check fixes
            // that.
            const hasInlineLineMarkers = !!linesMatch
              || /^_{3,}\s*$/m.test(stem)
              || /\[[ x✓✗]\]/i.test(stem);

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
                      <RichStemText text={stemForRender} answers={answers} questionId={q.id} onAnswer={onAnswer} />
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
                      <textarea
                        key={key}
                        rows={2}
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
                        className="w-full sm:flex-1 sm:min-w-[200px] border-2 border-slate-200 focus:border-[#003366] outline-none rounded-lg px-3 py-2 text-base text-[#001e40] resize-y leading-relaxed"
                        placeholder={inputCount > 1 ? (inputIdx === 0 ? "Before the keyword…" : "After the keyword (don't re-type it)…") : "Type your answer…"}
                      />
                    );
                  };

                  if (isStartingWord) {
                    // Starting word: keyword on its own line, then full-width textarea below on mobile
                    return (
                      <div className="mt-3 ml-[52px] flex flex-col sm:flex-row sm:items-start gap-2">
                        <span className="font-bold text-base text-[#001e40] shrink-0 sm:pt-2">{synthAnswerParts[0].content}</span>
                        {makeInput(0, "in0")}
                      </div>
                    );
                  }

                  // Mid-sentence keyword: stack vertically on mobile, inline on sm+
                  let inputIdx = 0;
                  return (
                    <div className="mt-3 ml-[52px] flex flex-col sm:flex-row sm:flex-wrap sm:items-start gap-2">
                      {synthAnswerParts.map((part) => {
                        if (part.type === "keyword") {
                          return <span key={part.key} className="font-bold text-base text-[#001e40] shrink-0 sm:pt-2">{part.content}</span>;
                        }
                        const idx = inputIdx++;
                        return makeInput(idx, part.key);
                      })}
                    </div>
                  );
                })()}

                {/* Comprehension OEQ: fallback whole-question textarea — only
                    when the stem has no inline answer markers. Tables, ticks
                    and [LINES: N] markers all render their own per-position
                    inputs in RichStemText, so showing the outer textarea on
                    top would create a duplicate input. */}
                {sectionType === "comprehension-oeq" && !cleanStem.includes("|") && !hasInlineLineMarkers && (() => {
                  // Chinese 阅读理解 OEQ: render a 田字格-style
                  // handwriting canvas instead of a textarea so the
                  // student writes Chinese characters by hand on a
                  // tablet rather than typing on a hard-to-use IME.
                  // Ink is stored as a base64 PNG data URL on the
                  // answer field. Persistence + marker handover wire
                  // up the same path English OEQ canvases use.
                  const stored = answers[q.id] ?? "";
                  const initialInk = stored.startsWith("data:image") ? stored : null;
                  // Sizing: ~12 columns × multiple rows. 80px cells
                  // give the student a comfortable area for primary-
                  // school characters. Tall enough for an answer
                  // sentence (typically 30-60 characters).
                  const linesPerAnswer = Math.max(3, Math.min(6, lineCount));
                  const cellSize = 80;
                  const canvasHeight = cellSize * linesPerAnswer;
                  return (
                    <div className="mt-3 ml-[52px]">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1">在格子内书写</p>
                      <ChineseHandwritingCanvas
                        height={canvasHeight}
                        cellSize={cellSize}
                        tool={tool}
                        savedInkUrl={initialInk}
                        onChange={(inkDataUrl) => onAnswer(q.id, inkDataUrl)}
                      />
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      )}

      {/* 短文填空 — passage with inline 4-option pickers per blank.
          No separate question cards; the student picks options right
          inside the passage prose. */}
      {sectionType === "visual-text-mcq" && sectionLabel.includes("短文填空") && passage && (() => {
        // Split the passage on the "---OPTIONS---" divider the Chinese
        // OCR rule emits. Everything before is the passage with
        // **________** blank markers; everything after is the per-
        // question option list ("16. (1) ... (2) ... (3) ... (4) ...").
        // Options are also stored on each question's transcribedOptions,
        // so prefer that — fall back to parsing the divider block when
        // a question has empty options (older extractions).
        const sortedQs = [...questions].sort((a, b) =>
          a.questionNum.localeCompare(b.questionNum, undefined, { numeric: true })
        );
        const dividerIdx = passage.indexOf("---OPTIONS---");
        const passageOnly = dividerIdx >= 0 ? passage.slice(0, dividerIdx) : passage;
        // Walk every **...**  occurrence; nth occurrence = nth question.
        const blankRe = /\*\*[^*]*\*\*/g;
        const segments: Array<{ kind: "text" | "blank"; text: string; qIdx: number }> = [];
        let lastEnd = 0;
        let bi = 0;
        for (const m of passageOnly.matchAll(blankRe)) {
          if (m.index! > lastEnd) {
            segments.push({ kind: "text", text: passageOnly.slice(lastEnd, m.index!), qIdx: -1 });
          }
          segments.push({ kind: "blank", text: m[0], qIdx: bi });
          bi++;
          lastEnd = m.index! + m[0].length;
        }
        if (lastEnd < passageOnly.length) {
          segments.push({ kind: "text", text: passageOnly.slice(lastEnd), qIdx: -1 });
        }
        return (
          <div className="bg-white rounded-2xl p-5 lg:p-8 shadow-sm border border-slate-100">
            <p className="text-sm text-slate-500 italic mb-4">阅读短文，从每题的四个选项中选出最合适的答案。</p>
            <div className="leading-loose text-base text-[#0b1c30]">
              {segments.map((seg, i) => {
                if (seg.kind === "text") {
                  return <span key={i} className="whitespace-pre-wrap">{seg.text}</span>;
                }
                const q = sortedQs[seg.qIdx];
                if (!q) return <span key={i} className="text-slate-400 border-b border-slate-400 px-3">______</span>;
                const opts = (q.transcribedOptions as string[] | null) ?? ["", "", "", ""];
                const selected = answers[q.id] ?? null;
                return (
                  <span key={i} className="inline-flex flex-wrap items-center gap-1 align-middle mx-1 my-1 bg-[#eff4ff] border border-[#d3e4fe] rounded-xl px-2 py-1 max-w-full">
                    <span className="text-[10px] font-extrabold text-[#003366] bg-white px-1.5 rounded">Q{parseInt(q.questionNum)}</span>
                    {[0, 1, 2, 3].map(oi => {
                      const optNum = String(oi + 1);
                      const isSelected = selected === optNum;
                      const isEmpty = !opts[oi];
                      return (
                        <button
                          key={oi}
                          type="button"
                          disabled={isEmpty}
                          onClick={() => onAnswer(q.id, optNum)}
                          className={`text-xs font-semibold px-2 py-0.5 rounded-md border transition-colors ${
                            isSelected
                              ? "bg-[#003366] text-white border-[#003366]"
                              : isEmpty
                                ? "bg-slate-100 text-slate-300 border-slate-200 cursor-not-allowed"
                                : "bg-white text-[#001e40] border-[#c3c6d1] hover:border-[#003366]"
                          }`}
                          title={isEmpty ? "(option missing)" : opts[oi]}
                        >
                          ({oi + 1}) {opts[oi] || "—"}
                        </button>
                      );
                    })}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* Visual Text MCQ / 阅读理解 mixed: standard question + options
          for MCQ, 田字格 handwriting canvas for OEQ. 阅读理解A on PSLE
          华文 carries Q30-32 (MCQ) + Q33 (long OEQ) sharing one
          passage — the renderer picks the shape per-question instead
          of routing the whole section through one sectionType. */}
      {sectionType === "visual-text-mcq" && !sectionLabel.includes("短文填空") && (
        <div className={`space-y-6 ${splitQuestionsCls}`}>
          {questions.map(q => {
            const hasOptions = Array.isArray(q.transcribedOptions) && q.transcribedOptions.length > 0;
            const isOeq = !hasOptions;
            const stored = answers[q.id] ?? "";
            const initialInk = stored.startsWith("data:image") ? stored : null;
            return (
              <div key={q.id} className="bg-white rounded-2xl p-5 shadow-sm">
                <div className="flex items-center gap-2 mb-1">
                  <p className="font-bold text-sm text-[#001e40]">Question {parseInt(q.questionNum)}</p>
                  {q.marksAvailable != null && (
                    <span className="text-[10px] font-bold text-[#003366] bg-[#d3e4fe] px-1.5 py-0.5 rounded uppercase tracking-wider">
                      {q.marksAvailable} {q.marksAvailable > 1 ? "marks" : "mark"}
                    </span>
                  )}
                  {onToggleFlag && (
                    <button onClick={() => onToggleFlag(q.id)} className="text-[#737780] hover:text-[#ba1a1a] transition-colors">
                      <span className="material-symbols-outlined text-sm" style={flaggedIds?.has(q.id) ? { fontVariationSettings: "'FILL' 1", color: "#ba1a1a" } : undefined}>flag</span>
                    </button>
                  )}
                </div>
                {q.transcribedStem && (
                  <FormattedText text={q.transcribedStem} className="text-sm text-[#0b1c30] mb-3 whitespace-pre-wrap" />
                )}
                {hasOptions && (
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
                          {/* Options can carry **__word__** for the
                              tested phrase (Q13-15 in 语文应用 MCQ
                              "pick the correct sentence" sub-bank).
                              Run through FormattedText so the bold +
                              underline render instead of leaking the
                              raw markdown to the page. */}
                          <FormattedText text={opt} className="text-sm text-[#001e40]" />
                        </button>
                      );
                    })}
                  </div>
                )}
                {isOeq && (
                  <div className="mt-2">
                    <ChineseHandwritingCanvas
                      height={320}
                      cellSize={80}
                      tool={tool}
                      savedInkUrl={initialInk}
                      onChange={(inkDataUrl) => onAnswer(q.id, inkDataUrl)}
                    />
                  </div>
                )}
              </div>
            );
          })}
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

  // Collect labels the student has already typed into any cloze blank
  // in this section. The word-bank table uses this to auto-strikethrough
  // used labels — for English Grammar Cloze the labels are letters A-Q,
  // for Chinese 完成对话 they are digits 1-8.
  const usedLetters = new Set<string>();
  if (sectionType === "grammar-cloze") {
    for (const q of sortedQs) {
      const a = (answers[q.id] ?? "").trim().toUpperCase();
      // English: single letter A-Q
      if (/^[A-Q]$/.test(a)) usedLetters.add(a);
      // Chinese 完成对话: single digit 1-8 (or 9 for an extended bank).
      // Stored verbatim so the table cell lookup can match by the
      // literal label string.
      if (/^[1-9]$/.test(a)) usedLetters.add(a);
    }
  }

  return (
    <div className="bg-white rounded-2xl p-5 lg:p-8 shadow-sm border border-slate-100 relative">
      {tool === "pen" && <PassageScratchOverlay />}
      {lines.map((line, li) => {
        // Skip table separator rows (must check before table rows)
        if (line.match(/^\s*\|[\s-:|]+\|\s*$/)) return null;
        // Table rows
        if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
          return <TableLine key={li} line={line} usedLetters={usedLetters} />;
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

function TableLine({ line, usedLetters }: { line: string; usedLetters?: Set<string> }) {
  const cells = line.trim().replace(/\|\s*$/, "|").split("|").slice(1, -1).map(c => c.trim());
  // Detect if this is a label row. Two flavours of word bank:
  //  - English Grammar Cloze: single letters A-Q
  //  - Chinese 完成对话:        single digits 1-8 (or 9)
  // When the student types a label into any blank, auto-strike the
  // matching cell in the bank so they don't have to manually track
  // which options they've used.
  const isLetterRow = cells.every(c => /^[A-Q]$/.test(c));
  const isDigitRow = cells.every(c => /^[1-9]$/.test(c));
  const isLabelRow = isLetterRow || isDigitRow;
  return (
    <div className="flex gap-2 my-1">
      {cells.map((cell, ci) => {
        const isUsed = isLabelRow && usedLetters?.has(cell) === true;
        const base = `flex-1 text-center text-xs text-[#001e40] bg-[#eff4ff] rounded px-2 py-1 ${isLabelRow ? "font-extrabold text-[#003366] underline" : "font-medium"} transition-opacity`;
        const styleProps = isUsed ? { textDecoration: "line-through", opacity: 0.4 } : undefined;
        return (
          <span key={ci} className={base} style={styleProps}>{cell}</span>
        );
      })}
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
  // Per-block column weights, derived from the separator row's dash count.
  //   | --- | --------- | --- |   ⇒  weights [3, 9, 3]  ⇒  middle col is 3x as wide.
  // Default `flex-1` on every cell when no separator (or all-equal dashes)
  // matches the existing behaviour. Block = contiguous run of table lines.
  const lineWeights: (number[] | null)[] = new Array(lines.length).fill(null);
  {
    let blockStart = -1;
    let blockWeights: number[] | null = null;
    const flush = (endExclusive: number) => {
      if (blockStart === -1 || !blockWeights) { blockStart = -1; blockWeights = null; return; }
      for (let i = blockStart; i < endExclusive; i++) lineWeights[i] = blockWeights;
      blockStart = -1; blockWeights = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      const isSep = !!t.match(/^\|[\s-:|]+\|$/);
      const isRow = t.startsWith("|") && t.endsWith("|");
      if (isSep) {
        const cells = t.replace(/\|\s*$/, "|").split("|").slice(1, -1);
        const w = cells.map(c => Math.max(1, (c.match(/-/g) || []).length));
        if (blockStart === -1) blockStart = i;
        // Only set weights if at least one column differs from the rest.
        if (w.some(x => x !== w[0])) blockWeights = w;
      } else if (isRow) {
        if (blockStart === -1) blockStart = i;
      } else {
        flush(i);
      }
    }
    flush(lines.length);
  }
  let tableRowIdx = 0;
  let tickIdx = 0;
  let lineIdx = 0;
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
          const weights = lineWeights[li];
          return (
            <div key={li} className="flex gap-1 my-1 items-stretch">
              {cells.map((cell, ci) => {
                const isBlank = !cell || cell.match(/^_{2,}$/);
                const isFirstCol = ci === 0;
                const cellKey = `r${ri}c${ci}`;
                // Column weight from the separator row, falls back to the
                // legacy "first col 80px, rest equal" behaviour when no
                // separator widths were specified.
                const weight = weights ? weights[ci] ?? 1 : null;
                const widthCls = weight !== null
                  ? "" // flex weight applied via inline style below
                  : isFirstCol ? "w-20 shrink-0" : "flex-1";
                const widthStyle = weight !== null ? { flex: `${weight} 1 0` } : undefined;
                if (isBlank) {
                  // textarea so long answers wrap onto multiple lines
                  // instead of being clipped by a single-line input. The
                  // cell grows vertically as the student types (scrollHeight
                  // driven) and the whole row grows with it.
                  return (
                    <textarea
                      key={ci}
                      rows={1}
                      spellCheck={false}
                      autoComplete="one-time-code"
                      autoCorrect="off"
                      autoCapitalize="none"
                      value={tableCells[cellKey] ?? ""}
                      onChange={e => {
                        updateTableCell(cellKey, e.target.value);
                        const el = e.currentTarget;
                        el.style.height = "auto";
                        el.style.height = `${el.scrollHeight}px`;
                      }}
                      ref={(el) => {
                        if (el) {
                          el.style.height = "auto";
                          el.style.height = `${el.scrollHeight}px`;
                        }
                      }}
                      style={widthStyle}
                      // min-w-0 lets flex actually shrink the textarea to
                      // its weighted share. Without it, the textarea's
                      // min-content (placeholder + padding) forces a wider
                      // minimum and neighbouring cells get squashed — which
                      // is why dash-based widths looked right for one-input
                      // tables but broke when multiple columns had inputs.
                      className={`text-left text-sm font-medium text-[#001e40] bg-white rounded px-2 py-1.5 border-2 border-[#d3e4fe] focus:border-[#003366] outline-none resize-none leading-snug overflow-hidden min-w-0 ${widthCls}`}
                      placeholder="..."
                    />
                  );
                }
                return (
                  <span key={ci} style={widthStyle} className={`text-center text-xs font-medium text-[#001e40] bg-[#eff4ff] rounded px-2 py-1.5 border border-[#d3e4fe] min-w-0 ${widthCls}`}>
                    {cell}
                  </span>
                );
              })}
            </div>
          );
        }
        // Tick boxes: [ ] / [x] / [✓] — handle THREE cases:
        // (a) line is "[ ] option" → single checkbox + label after
        // (b) line is "text [ ]"   → single checkbox + label before
        // (c) line is "intro? [ ] A [ ] B [ ] C [ ] D" → inline list of
        //     checkbox+label pairs after the intro prose. The OCR used
        //     to emit each tick on its own line, but multi-tick stems
        //     like Q73/Q79 come through as one continuous line — we
        //     have to split inline so all boxes render.
        const tickGlobalRe = /\[[ x✓✗]\]/gi;
        const tickHits = [...trimmed.matchAll(tickGlobalRe)];
        if (tickHits.length >= 2) {
          // Inline split: prose before the first [ ], then alternating
          // checkbox + label until end-of-line.
          const intro = trimmed.slice(0, tickHits[0].index).trim();
          const items: Array<{ label: string }> = [];
          for (let h = 0; h < tickHits.length; h++) {
            const start = tickHits[h].index! + tickHits[h][0].length;
            const end = h + 1 < tickHits.length ? tickHits[h + 1].index! : trimmed.length;
            items.push({ label: trimmed.slice(start, end).trim() });
          }
          return (
            <div key={li} className="my-2">
              {intro && (
                <p className="text-base text-[#001e40] leading-relaxed mb-2">
                  {renderInlineBold(intro)}
                </p>
              )}
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                {items.map((it, ii) => {
                  const tickKey = `tick${tickIdx++}`;
                  const isChecked = tableCells[tickKey] === "true";
                  return (
                    <label key={ii} className="flex items-center gap-2 cursor-pointer text-base text-[#001e40]">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={e => updateTableCell(tickKey, e.target.checked ? "true" : "")}
                        className="w-4 h-4 accent-[#003366]"
                      />
                      <span>{renderInlineBold(it.label)}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          );
        }
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
        // Line with a [LINES: N] / [N lines] / [N] marker at the end — render
        // the text portion, then a textarea with `rows={N}`. Handles both the
        // "marker on its own line" case (textPart empty) and the common
        // "Question? [LINES: 3]" case (textPart = "Question?"). Stored under
        // JSON key line0/line1/... so each subpart's answer is separable.
        const linesEndMatch = trimmed.match(/^(.*?)\s*\[(?:LINES?:\s*)?(\d+)\s*(?:lines?)?\]\s*$/i);
        if (linesEndMatch) {
          const textPart = linesEndMatch[1].trim();
          const count = parseInt(linesEndMatch[2]);
          const lineKey = `line${lineIdx++}`;
          return (
            <div key={li} className="my-2">
              {textPart && (
                <p className="text-base text-[#001e40] leading-relaxed mb-2">
                  {renderInlineBold(textPart)}
                </p>
              )}
              <textarea
                rows={count}
                spellCheck={false}
                autoComplete="one-time-code"
                autoCorrect="off"
                autoCapitalize="none"
                value={tableCells[lineKey] ?? ""}
                onChange={e => updateTableCell(lineKey, e.target.value)}
                className="w-full border-2 border-slate-200 focus:border-[#003366] outline-none rounded-xl px-4 py-3 text-base text-[#001e40] resize-none leading-relaxed"
                placeholder="Type your answer here..."
              />
            </div>
          );
        }
        // Line ending with ___ (3+ underscores) — same idea as above but a
        // single-row textarea. Handles both "Answer: ___" and standalone "___".
        const underscoreEndMatch = trimmed.match(/^(.*?)\s*_{3,}\s*$/);
        if (underscoreEndMatch) {
          const textPart = underscoreEndMatch[1].trim();
          const lineKey = `line${lineIdx++}`;
          return (
            <div key={li} className="my-2">
              {textPart && (
                <p className="text-base text-[#001e40] leading-relaxed mb-2">
                  {renderInlineBold(textPart)}
                </p>
              )}
              <textarea
                rows={1}
                spellCheck={false}
                autoComplete="one-time-code"
                autoCorrect="off"
                autoCapitalize="none"
                value={tableCells[lineKey] ?? ""}
                onChange={e => updateTableCell(lineKey, e.target.value)}
                className="w-full border-2 border-slate-200 focus:border-[#003366] outline-none rounded-lg px-3 py-2 text-base text-[#001e40] resize-none leading-relaxed"
                placeholder="Type your answer here..."
              />
            </div>
          );
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
        <span key={`q${qNum}`} className="relative z-20 inline-flex items-center gap-1 mx-1 align-middle whitespace-nowrap">
          <span className="text-[9px] sm:text-[10px] font-bold text-blue-600 bg-blue-50 px-1 rounded">({displayNum})</span>
          <span className="underline decoration-red-400 decoration-2 font-bold text-red-700 text-[11px] sm:text-sm break-all">{content}</span>
          <input
            type="text"
            value={qId ? (answers[qId] ?? "") : ""}
            onChange={e => qId && onAnswer(qId, e.target.value)}
            onFocus={onFocusInput}
            spellCheck={false}
            autoComplete="one-time-code"
            autoCorrect="off"
            autoCapitalize="none"
            className={`border-2 ${qId && emptyFieldIds?.has(qId) ? "border-red-500 bg-red-50" : "border-slate-200"} focus:border-[#003366] outline-none rounded px-1.5 py-0.5 text-[11px] sm:text-sm w-20 sm:w-28 bg-white`}
            placeholder="correct"
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
export function VisualTextImages({ passage, fallbackImage }: { passage: string; fallbackImage?: string }) {
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
  // Chinese 阅读理解 passages — no line numbering, body font. The
  // printed 华文 paper carries no margin line numbers and OEQ answers
  // never cite line numbers, so the English-style small-font + No.
  // margin layout is wrong here. Render as plain paragraphs using
  // the same toParagraphs logic as the 阅读理解 MCQ branch above.
  const hasChinese = /[一-鿿]/.test(text);
  if (isTable && hasChinese) {
    const tableLines = lines.filter(l => l.trim().startsWith("|") && l.trim().endsWith("|"));
    const dataLines = tableLines.filter(l => !/^\s*\|[\s|:-]+\|\s*$/.test(l)).slice(1);
    const paras: string[] = [];
    let cur = "";
    const pushCur = () => { if (cur.trim()) paras.push(cur.replace(/^[\s\t]+/, "").trim()); cur = ""; };
    for (const row of dataLines) {
      const cols = row.trim().replace(/\|\s*$/, "|").split("|").slice(1, -1).map(c => c);
      const rawCell = cols[1] ?? "";
      const cell = rawCell.startsWith(" ") ? rawCell.slice(1) : rawCell;
      const text = cell.replace(/^[\s\t]+|\s+$/g, "");
      const isIndentedRow = /^\t| {2,}/.test(cell);
      if (!text) { pushCur(); continue; }
      if (isIndentedRow && cur) { pushCur(); }
      cur += text;
    }
    pushCur();
    return (
      <div className="mb-8 bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100 w-full">
        {paras.map((para, pi) => (
          <p key={pi} className="text-base text-[#0b1c30] leading-loose mb-3 last:mb-0" style={{ textIndent: "2em", whiteSpace: "pre-wrap" }}>
            {para}
          </p>
        ))}
      </div>
    );
  }
  if (isTable) {
    // Parse table rows, skip header separator. Preserve raw cell text in
    // a parallel array — needed to detect leading indentation (start of
    // a new paragraph) which trim() would otherwise erase.
    const rows: string[][] = [];
    const rawRows: string[][] = [];
    let pastHeader = false;
    for (const line of lines) {
      if (line.match(/^\s*\|[\s-:|]+\|\s*$/)) { pastHeader = true; continue; }
      if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
        pastHeader = true;
        const raw = line.trim().replace(/\|\s*$/, "|").split("|").slice(1, -1);
        rawRows.push(raw);
        rows.push(raw.map(c => c.trim()));
      } else if (pastHeader && !line.trim()) {
        // Empty line between table rows = paragraph break
        rows.push(["", "", ""]);
        rawRows.push(["", "", ""]);
      }
    }
    // First row is header — skip it
    const dataRows = rows.length > 1 ? rows.slice(1) : rows;
    const dataRawRows = rawRows.length > 1 ? rawRows.slice(1) : rawRows;
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
      <div className="mb-8 bg-white rounded-2xl p-4 lg:p-6 shadow-sm border border-slate-100 max-h-[600px] overflow-y-auto overflow-x-hidden w-full lg:max-h-none lg:overflow-visible">
        <div>
          {dataRows.map((cells, ri) => {
            const textContent = cells[1]?.trim() ?? "";
            const rawText = dataRawRows[ri]?.[1] ?? "";
            const isEmpty = !textContent && !cells[0]?.trim();
            // Detect indentation from the RAW cell — trim() would have
            // erased leading whitespace already. Lines starting with 2+
            // spaces or a tab are paragraph starts and get a hanging indent
            // BUT no extra top margin (lines stay flush with the rest of
            // the passage, only the first-line position changes).
            const isIndented = /^(\s{2,}|\t+)/.test(rawText);
            const marginNum = marginNums[ri];
            if (isEmpty) return <div key={ri} className="h-6" />;
            return (
              <div key={ri} className="flex gap-2 min-h-[1.3rem]">
                <p className={`flex-1 text-[#0b1c30] leading-relaxed text-justify ${isIndented ? "pl-8" : ""}`} style={{ overflowWrap: "break-word", wordBreak: "break-word", hyphens: "auto", fontSize: "clamp(11px, 0.95vw, 13.5px)" }}>
                  {textContent.replace(/^\s+/, "")}
                </p>
                {marginNum ? <span className="w-5 text-right text-[#003366] font-bold font-mono shrink-0 pt-0.5" style={{ fontSize: "clamp(10px, 0.78vw, 12px)" }}>{marginNum}</span> : <span className="w-5 shrink-0" />}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // Plain text fallback
  return (
    <div className="mb-8 bg-white rounded-2xl p-4 lg:p-6 shadow-sm border border-slate-100 max-h-[600px] overflow-y-auto overflow-x-hidden w-full lg:max-h-none lg:overflow-visible">
      <p className="text-[#0b1c30] leading-relaxed whitespace-pre-wrap text-justify" style={{ overflowWrap: "break-word", wordBreak: "break-word", hyphens: "auto", fontSize: "clamp(12px, 1vw, 14px)" }}>{text}</p>
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
