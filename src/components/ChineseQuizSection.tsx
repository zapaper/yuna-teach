"use client";

import { useEffect, useRef, useState } from "react";
import FormattedText from "./FormattedText";
import ChineseHandwritingCanvas from "./ChineseHandwritingCanvas";

// Browser TTS for Chinese MCQ stems. Substitutes the correct option
// into the **__phrase__** / ______ blank so the sentence reads as a
// complete utterance. Same shape as the review-page helper. Quiz-side
// the student can preview the answer-sound for any MCQ question.
function speakChineseMcq(stem: string, options: string[]): void {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  let line = stem.replace(/^[Qq]?\s*\d+\s*[.:]\s*/, "").trim();
  // Strip the **__phrase__** markers so the TTS doesn't read them.
  line = line.replace(/\*\*__(.*?)__\*\*/g, "$1");
  line = line.replace(/__(.*?)__/g, "$1");
  line = line.replace(/\*\*(.*?)\*\*/g, "$1");
  // Cloze blanks — substitute the first option as placeholder so the
  // sentence is grammatical; the student isn't being told the answer.
  line = line.replace(/_{3,}/g, options[0] ?? "");
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(line);
  utter.lang = "zh-CN";
  utter.rate = 0.85;
  window.speechSynthesis.speak(utter);
}

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
  // 阅读理解 passages that contain charts / posters / infographics are
  // captured as a cropped image from the PDF. When set, it replaces
  // the OCR-text `passage` for rendering in passage-bound sections
  // (visual-text-mcq / comprehension-oeq). When null/empty, render
  // the OCR passage text as before.
  passageImageData?: string | null;
  // Original passage-blank position for each question in `questions`,
  // parallel array. Set when the picker took a subset of the source
  // section (e.g. 3 of 6 short-cloze questions, others were used as
  // slide examples). When present, the renderer maps blank K to the
  // question whose blankIndex === K instead of mapping sequentially.
  blankIndices?: number[];
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
  // Parent-controlled flag. When false (default), the 🔊 speaker
  // button on Chinese MCQ stems is hidden. Parents enable it under
  // student settings → "Chinese reading assistance".
  readingAssist?: boolean;
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
export default function ChineseQuizSection({ sectionLabel, passage, passageImageData, blankIndices, questions, sectionType, answers, onAnswer, tool = "type", onToolChange, emptyFieldIds, flaggedIds, onToggleFlag, splitScreen, readingAssist }: Props) {
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
    // Tighter gap (gap-2 → 8px) + slim outer horizontal padding so
    // the passage / Q&A panes get more usable width. Without this
    // the boundary between the two panes wasted ~50px of whitespace.
    ? "mb-12 lg:grid lg:grid-cols-2 lg:gap-2 lg:grid-rows-[auto_1fr] lg:h-[calc(100vh-96px)] lg:w-screen lg:max-w-none lg:mx-[calc(-50vw+50%)] lg:my-[-32px] lg:px-4 xl:px-6 lg:py-4"
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

      {/* Cropped passage image override (visual-text-mcq).
          When the admin uploaded a PDF crop for this 阅读理解 section
          (e.g. a passage with a poster / chart / infographic that OCR
          can't capture), prefer the image over the OCR-text passage.
          Hidden for 短文填空 — that section embeds blanks inline in
          the OCR'd passage and would render incorrectly as an image. */}
      {sectionType === "visual-text-mcq" && !sectionLabel.includes("短文填空") && !!passageImageData && (
        <div className={`relative ${splitPassageCls}`}>
          <PassageScratchOverlay enabled={tool === "pen"} />
          <div className="bg-white rounded-2xl p-3 lg:p-4 shadow-sm border border-slate-100">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={passageImageData} alt={`${sectionLabel} passage`} className="w-full rounded-lg" />
          </div>
        </div>
      )}

      {/* Passage column for visual-text-mcq. Two flavours:
          - True Visual Text (poster / 漫画): passage is a sentinel
            "[VISUAL_PAGES:…]" or an image data URL; render as page
            images with the existing VisualTextImages component.
          - Chinese 阅读理解 MCQ: passage is plain Chinese text. Render
            it as paragraphs with a tab-indent on each new line so the
            student reads it as a normal passage.
          Skipped entirely when passageImageData is set above. */}
      {sectionType === "visual-text-mcq" && !sectionLabel.includes("短文填空") && !passageImageData && !!passage && (() => {
        // Guarded on `!!passage` — 语文应用 MCQ has no passage and
        // was previously falling into the VisualTextImages branch,
        // which then rendered Q1's cropped page image as a
        // "fallback" passage above the first question. That was the
        // mystery image crop the user kept seeing above 语文应用 Q1.
        const isImagePassage = passage.startsWith("[VISUAL_") || passage.startsWith("data:image");
        const hasTextPassage = !isImagePassage;
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
              const text = cell.replace(/^[\s\t　]+|\s+$/g, "");
              // Tab / 2+ ASCII spaces / full-width space (U+3000) all
              // count as a new-paragraph indent.
              const isIndentedRow = /^[\t　]|^ {2,}/.test(cell);
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
            <PassageScratchOverlay enabled={tool === "pen"} />
            {hasTextPassage ? (
              <div className="bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100">
                {paragraphs.map((para, pi) => (
                  <p key={pi} className="text-base text-[#0b1c30] leading-loose mb-3 last:mb-0" style={{ textIndent: "2em", whiteSpace: "pre-wrap" }}>
                    <FormattedText text={para} />
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

      {/* Comprehension OEQ: reading passage. Cropped image takes
          precedence over OCR text when the admin set one. */}
      {sectionType === "comprehension-oeq" && passageImageData && (
        <div className={`relative ${splitPassageCls}`}>
          <PassageScratchOverlay enabled={tool === "pen"} />
          <div className="bg-white rounded-2xl p-3 lg:p-4 shadow-sm border border-slate-100">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={passageImageData} alt={`${sectionLabel} passage`} className="w-full rounded-lg" />
          </div>
        </div>
      )}
      {sectionType === "comprehension-oeq" && !passageImageData && passage && (
        <div className={`relative ${splitPassageCls}`}>
          <PassageScratchOverlay enabled={tool === "pen"} />
          <ReadingPassage text={passage} />
        </div>
      )}

      {/* Synthesis / Comprehension OEQ: typed answer sections */}
      {(sectionType === "synthesis" || sectionType === "comprehension-oeq") && (
        <div className={`space-y-8 ${sectionType === "comprehension-oeq" ? splitQuestionsCls : ""}`}>

          {questions.map((q) => {
            const stem = q.transcribedStem ?? "";
            const displayNum = parseInt(q.questionNum);

            // Parse lines count from stem: [Lines: N] or [N lines].
            // Only used to detect that the stem CONTAINS a [LINES:] marker
            // (hasInlineLineMarkers); canvas height now scales with marks.
            const linesMatch = stem.match(/\[(?:Lines?:\s*)?(\d+)\s*(?:lines?)?\]/i);
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
                  // Sizing: rows scale with the question's mark
                  // allocation so a 4-mark answer gets more 田字格
                  // space than a 1-mark one.
                  //   1 mark / unmarked → 3 rows
                  //   2 marks           → 4 rows
                  //   3 marks           → 6 rows
                  //   4+ marks          → 8 rows
                  const m = q.marksAvailable ?? 0;
                  // Base height ladder + 1 row per OEQ mark on top so
                  // a 4-mark question gets 4 extra writing rows than a
                  // 1-mark one. Same intent as the English textarea
                  // change — more space scales with marks.
                  const linesPerAnswer = (m >= 4 ? 8 : m === 3 ? 6 : m === 2 ? 4 : 3) + m;
                  const cellSize = 88;
                  const canvasHeight = cellSize * linesPerAnswer;
                  return (
                    <div className="mt-3">
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
                // Place each picked question at its original blank
                // position when blankIndices is set (parallel to the
                // ORIGINAL `questions` prop order, not the sorted
                // copy — picked questions are renumbered Q1-Q3 in
                // the mastery quiz so numeric-sort doesn't preserve
                // the source ordering). Without blankIndices, fall
                // back to sequential mapping.
                let q: QuizQuestion | undefined;
                if (blankIndices && blankIndices.length > 0) {
                  const qPos = blankIndices.indexOf(seg.qIdx);
                  if (qPos >= 0) q = questions[qPos];
                } else {
                  q = sortedQs[seg.qIdx];
                }
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
        // Wrap the questions list in a relative container with a
        // PassageScratchOverlay so the student can annotate the
        // question stems / options too — just like the passage panel
        // above. The overlay's pointer-events: none kicks in when
        // tool !== "pen", so MCQ option buttons stay clickable in
        // type mode. Same treatment Comp OEQ gets on the passage side.
        <div className={`relative space-y-6 ${splitQuestionsCls}`}>
          <PassageScratchOverlay enabled={tool === "pen"} />
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
                  {/* Speaker — Chinese MCQ only. Reads the stem
                      with markup stripped; cloze blanks get a
                      placeholder so the sentence is grammatical
                      without leaking the answer.
                      Gated on the parent-controlled `readingAssist`
                      flag (default OFF, set under student settings
                      → "Chinese reading assistance"). */}
                  {hasOptions && readingAssist && (
                    <button
                      type="button"
                      onClick={() => speakChineseMcq(q.transcribedStem ?? "", (q.transcribedOptions as string[]) ?? [])}
                      title="朗读句子"
                      className="text-[#737780] hover:text-[#003366] transition-colors"
                    >
                      <span className="material-symbols-outlined text-sm">volume_up</span>
                    </button>
                  )}
                </div>
                {q.transcribedStem && (() => {
                  // Long-OEQ stems in 阅读理解 A are multi-paragraph
                  // instructions (e.g. Q33's 邀请 prompt). Render each
                  // paragraph as its own <p> so the visual layout
                  // matches the printed paper. Short stems collapse
                  // to a single paragraph naturally.
                  const paras = q.transcribedStem.split(/\n\s*\n+/).map(p => p.trim()).filter(Boolean);
                  return (
                    <div className="mb-3 select-text" style={{ WebkitUserSelect: "text", userSelect: "text", WebkitTouchCallout: "default" }}>
                      {paras.map((para, pi) => (
                        <p key={pi} className="text-sm text-[#0b1c30] leading-relaxed mb-2 last:mb-0 whitespace-pre-wrap">
                          <FormattedText text={para} />
                        </p>
                      ))}
                    </div>
                  );
                })()}
                {hasOptions && (
                  <div className="space-y-2">
                    {(q.transcribedOptions as string[]).map((opt, oi) => {
                      const optNum = String(oi + 1);
                      const selected = answers[q.id] === optNum;
                      return (
                        <button
                          key={oi}
                          onClick={(e) => {
                            // Don't pick this option if the user was
                            // selecting text within it (dictionary lookup).
                            // window.getSelection().toString() catches the
                            // case where mouse-up after a drag-select still
                            // fires click on the same element.
                            const sel = typeof window !== "undefined" ? window.getSelection() : null;
                            const selText = sel?.toString() ?? "";
                            if (selText && e.currentTarget.contains(sel?.anchorNode ?? null)) return;
                            onAnswer(q.id, optNum);
                          }}
                          className={`w-full text-left p-3 rounded-xl border-2 transition-all flex items-center gap-3 select-text ${
                            selected ? "border-[#006c49] bg-[#6cf8bb]/10" : "border-slate-200 hover:border-[#003366]/30"
                          }`}
                          style={{ WebkitUserSelect: "text", userSelect: "text", WebkitTouchCallout: "default" }}
                        >
                          <span className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm shrink-0 select-none ${
                            selected ? "bg-[#006c49] text-white" : "bg-[#eff4ff] text-[#001e40]"
                          }`} style={{ WebkitUserSelect: "none", userSelect: "none" }}>{oi + 1}</span>
                          {/* Options can carry **__word__** for the
                              tested phrase (Q13-15 in 语文应用 MCQ
                              "pick the correct sentence" sub-bank).
                              Run through FormattedText so the bold +
                              underline render instead of leaking the
                              raw markdown to the page. select-text on
                              the parent <button> opens dictionary lookup
                              on long-press / drag-highlight. */}
                          <FormattedText text={opt} className="text-sm text-[#001e40]" />
                        </button>
                      );
                    })}
                  </div>
                )}
                {isOeq && (() => {
                  // Canvas height scales with mark allocation:
                  //   4+ marks (long OEQ like Q33): 12 rows (960px)
                  //   3 marks: 4 + 3 = 7 rows (560px)
                  //   2 marks: 4 + 2 = 6 rows (480px)
                  //   ≤1 mark / unmarked: 4 rows baseline (320px)
                  const m = q.marksAvailable ?? 0;
                  const rows = m >= 4 ? 12 : m === 3 ? 7 : m === 2 ? 6 : 4;
                  return (
                    <div className="mt-2">
                      <ChineseHandwritingCanvas
                        height={rows * 88}
                        cellSize={88}
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
    </div>
  );
}

/** Renders a passage with inline text inputs for each question */
function PassageWithInputs({
  passage: rawPassage,
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
  // Normalize OCR-split markers + strip the spurious "Q" prefix the
  // model occasionally emits inside the marker — e.g. "**(Q26)________**"
  // instead of "**(26)________**". Without this the regexes below
  // (which expect digit-only) don't match, the asterisks render as
  // literal text and the blank never becomes an input field.
  //
  // Also collapses multi-line **(N)...** markers back into the canonical
  // single-line form **(N)________** before splitting on \n, in case
  // the OCR preserved the printed-page layout (blank on one line, "(26)"
  // on the next, closing ** on a third).
  const passage = rawPassage.replace(
    /\*\*\(Q?(\d+)\)[\s\S]*?\*\*/g,
    (_m, n) => `**(${n})________**`
  );

  // Always use position-based mapping: passage blank i → questions[i].
  // Handles two marker styles:
  //   English style: **(29)________**    (e.g. Grammar Cloze, Editing)
  //   Chinese 完成对话: plain ______       (no question number annotation)
  // We scan both, in document order, and assign each blank to the
  // i-th question in sorted order. For underscore-only blanks the
  // "question number" key in qNumToId is synthetic — we use a
  // negative sentinel `-(blankIdx+1)` so it doesn't collide with
  // real English Q numbers in the same passage.
  const passageQNums: number[] = [];
  const seenEng = new Set<number>();
  // Must match PassageLine's blank regex one-for-one — one match per
  // visible blank in the passage. PassageLine groups
  // `**(NN)____**` as a SINGLE blank (the regex captures qNum +
  // inner content together). An older split version of this regex
  // counted the inner `____` as a second blank, which inflated the
  // mapping list to 2× the real blank count: the first 4 of 8
  // entries got bound to Q1–Q4 and the next 4 fell off the end —
  // so 完成对话 quizzes ended up showing badges like "(6) (8) (28)
  // (29)" instead of "(6) (7) (8) (9)" and the last 2 inputs had no
  // qId to write to.
  const COMBINED_RX = /\*\*\((\d+)\)[^*]*\*\*|_{6,}/g;
  let blankIdx = 0;
  let pm;
  while ((pm = COMBINED_RX.exec(passage)) !== null) {
    if (pm[1] !== undefined) {
      // English / Chinese **(NN)____** style — one blank per match.
      const n = parseInt(pm[1]);
      if (!seenEng.has(n)) { passageQNums.push(n); seenEng.add(n); }
    } else {
      // Chinese plain ______ style — synthetic position-based key.
      passageQNums.push(-(blankIdx + 1));
    }
    blankIdx++;
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

  // Pre-pass: detect 2-row word banks (PSLE 2021+, 2024, 2025, P6
  // Prelim 2025 style). The label row carries pure digits 1-8 and the
  // immediately following row carries one phrase per column. When the
  // student picks a digit, both the digit cell AND the same-column
  // phrase cell should strike through so they don't have to mentally
  // pair them. linkedLabels[li] holds the digit-row labels in column
  // order for the phrase row at line index li.
  const linkedLabels: (string[] | undefined)[] = new Array(lines.length).fill(undefined);
  const isTableRow = (l: string) => l.trim().startsWith("|") && l.trim().endsWith("|");
  const isSepRow = (l: string) => /^\s*\|[\s-:|]+\|\s*$/.test(l);
  for (let i = 0; i < lines.length - 1; i++) {
    if (!isTableRow(lines[i]) || isSepRow(lines[i])) continue;
    const cells = lines[i].trim().replace(/\|\s*$/, "|").split("|").slice(1, -1).map(c => c.trim());
    const isDigitLabel = cells.length > 0 && cells.every(c => /^[1-9]$/.test(c));
    const isLetterLabel = cells.length > 0 && cells.every(c => /^[A-Q]$/.test(c));
    if (!isDigitLabel && !isLetterLabel) continue;
    // Walk forward past sep / blank rows to the next content table row.
    let j = i + 1;
    while (j < lines.length && (isSepRow(lines[j]) || !lines[j].trim())) j++;
    if (j >= lines.length) continue;
    if (!isTableRow(lines[j])) continue;
    const nextCells = lines[j].trim().replace(/\|\s*$/, "|").split("|").slice(1, -1).map(c => c.trim());
    if (nextCells.length !== cells.length) continue;
    const nextIsLabel = nextCells.every(c => /^[A-Q1-9]$/.test(c));
    if (nextIsLabel) continue;
    linkedLabels[j] = cells;
  }

  // Pre-pass: skip rows that are print-paper score-table artifacts
  // from 完成对话 sections. These are:
  //   · "(接下页)"  — "continue to next page" footer.
  //   · A table block whose header row carries 得分 / 分数 / Q26 /
  //     Q27 / Q28 / Q29 cells (the per-question score sheet at the
  //     foot of every PSLE 完成对话 / 阅读理解 section). The body
  //     rows are blank — useless on screen.
  // Marked rows return null from the render pass below.
  const skipLine: boolean[] = new Array(lines.length).fill(false);
  {
    const looksLikeScoreHeader = (cells: string[]) => {
      if (cells.length < 2) return false;
      const hasScoreLabel = cells.some(c => c === "得分" || c === "分数" || c === "Score");
      const qCells = cells.filter(c => /^Q\s*\d+$/i.test(c));
      return hasScoreLabel && qCells.length >= 2;
    };
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (raw === "(接下页)" || raw === "（接下页）") {
        skipLine[i] = true;
        continue;
      }
      if (!isTableRow(lines[i]) || isSepRow(lines[i])) continue;
      const cells = raw.replace(/\|\s*$/, "|").split("|").slice(1, -1).map(c => c.trim());
      if (!looksLikeScoreHeader(cells)) continue;
      // Walk down: mark this row + every sep / blank-body table row
      // immediately below it as skip.
      skipLine[i] = true;
      let j = i + 1;
      while (j < lines.length) {
        if (isSepRow(lines[j])) { skipLine[j] = true; j++; continue; }
        if (!isTableRow(lines[j])) break;
        const bodyCells = lines[j].trim().replace(/\|\s*$/, "|").split("|").slice(1, -1).map(c => c.trim());
        // Body row of a score table is all empty (blanks waiting for
        // the student to write their marks in). Stop at the first
        // non-empty body row — that's a real content row.
        if (bodyCells.some(c => c)) break;
        skipLine[j] = true;
        j++;
      }
      i = j - 1;
    }
  }

  // Pre-pass: detect dialogue table blocks (PSLE 2017 / 2018 完成对话
  // style — dialogue lines wrapped inside a 2-column markdown table
  // with the answer-label "Q26 ( )" in the right cell). Any row in
  // such a block must render as a dialogue paragraph with inline
  // inputs, NOT as the centered word-bank cells used for the word
  // bank above. We mark each row of a block as a "dialogue row" when
  // ANY row in that block carries a **(N)____** marker — that's the
  // unique fingerprint of the dialogue table; the standalone word
  // bank above it never has markers.
  const isDialogueRow: boolean[] = new Array(lines.length).fill(false);
  {
    let blockStart = -1;
    let blockHasMarker = false;
    const flush = (endExclusive: number) => {
      if (blockStart !== -1 && blockHasMarker) {
        for (let j = blockStart; j < endExclusive; j++) isDialogueRow[j] = true;
      }
      blockStart = -1;
      blockHasMarker = false;
    };
    for (let i = 0; i < lines.length; i++) {
      const inTable = isTableRow(lines[i]) || isSepRow(lines[i]);
      if (inTable) {
        if (blockStart === -1) blockStart = i;
        if (isTableRow(lines[i]) && !isSepRow(lines[i]) && /\*\*\(\d+\)/.test(lines[i])) {
          blockHasMarker = true;
        }
      } else {
        flush(i);
      }
    }
    flush(lines.length);
  }

  return (
    <div className="bg-white rounded-2xl p-5 lg:p-8 shadow-sm border border-slate-100 relative">
      <PassageScratchOverlay enabled={tool === "pen"} />
      {(() => {
        // Cross-line counter for plain ______ markers — each one
        // consumes the next synthetic key built above (negative sentinels).
        let underscoreCounter = 0;
        return lines.map((line, li) => {
          // Skip print-paper artifacts (score table, "continue to next page").
          if (skipLine[li]) return null;
          // Skip table separator rows (must check before table rows)
          if (line.match(/^\s*\|[\s-:|]+\|\s*$/)) return null;
          // Table rows
          if (line.trim().startsWith("|") && line.trim().endsWith("|")) {
            return <TableLine
              key={li}
              line={line}
              usedLetters={usedLetters}
              linkedLabels={linkedLabels[li]}
              forceDialogueRow={isDialogueRow[li]}
              qNumToId={qNumToId}
              qNumToDisplayNum={qNumToDisplayNum}
              sectionType={sectionType}
              answers={answers}
              onAnswer={onAnswer}
              emptyFieldIds={emptyFieldIds}
              onFocusInput={onFocusInput}
            />;
          }
          // Empty line = paragraph break
          if (!line.trim()) return <br key={li} />;

          // Count how many ______ this line has; pass start offset.
          const lineUnderscoreCount = (line.match(/_{6,}/g) ?? []).length;
          // We also need to account for ENGLISH **(NN)** markers
          // already in the synthetic key sequence — those use the
          // explicit qNum, not the underscore counter. The counter
          // only advances for plain underscores.
          const startUnderscoreIdx = underscoreCounter;
          underscoreCounter += lineUnderscoreCount;

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
              underscoreOffset={startUnderscoreIdx}
            />
          );
        });
      })()}
    </div>
  );
}

function TableLine({
  line,
  usedLetters,
  linkedLabels,
  forceDialogueRow,
  qNumToId,
  qNumToDisplayNum,
  sectionType,
  answers,
  onAnswer,
  emptyFieldIds,
  onFocusInput,
}: {
  line: string;
  usedLetters?: Set<string>;
  // 2-row word bank: when this row is the phrase row (i.e. the row
  // immediately after a digit-label row), linkedLabels[ci] gives the
  // label of the same-column digit cell. Used to strike through the
  // phrase when the student picks that digit.
  linkedLabels?: string[];
  // PassageWithInputs pre-pass tag: this row sits inside a dialogue
  // table block (any sibling row in the block carries a **(N)____**
  // marker). Renders cells as dialogue paragraphs instead of the
  // centered word-bank style — covers the dialogue rows in the
  // block that DON'T themselves carry a blank.
  forceDialogueRow?: boolean;
  // Optional dialogue-cell rendering context. When present and a cell
  // contains a **(N)________** marker, the marker is rendered as an
  // input (matching PassageLine's behaviour) rather than as literal
  // text. Older PSLE formats (2017 / 2018) wrap the dialogue lines
  // inside a 2-column table cell — without this the markers would
  // render as plain bold "(26)________" strings and the student would
  // have nowhere to type.
  qNumToId?: Map<number, string>;
  qNumToDisplayNum?: Map<number, number>;
  sectionType?: "grammar-cloze" | "editing" | "comprehension-cloze";
  answers?: Record<string, string>;
  onAnswer?: (questionId: string, answer: string) => void;
  emptyFieldIds?: Set<string>;
  onFocusInput?: () => void;
}) {
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
  // Labeled-phrase rows: each cell carries BOTH the label and the
  // phrase, e.g. "1. 这种想法真是难得" (PSLE 2014 vertical bank) or
  // "1 我们年纪还小" (PSLE 2018 4-column bank). Strike-through has to
  // key off the extracted leading digit/letter; without this the
  // student picks an answer and nothing crosses out because the
  // cell text doesn't match the bare digit in usedLetters.
  function extractCellLabel(cell: string): string | null {
    const m = cell.trim().match(/^([1-9]|[A-Q])(?:[.．、）)]\s*|\s+)\S/);
    return m ? m[1] : null;
  }
  const cellLabels: (string | null)[] = cells.map(extractCellLabel);
  const isLabeledPhraseRow = !isLabelRow && cellLabels.every(l => l !== null);
  // Any cell carries an inline question marker, OR the pre-pass flagged
  // this row's table block as a dialogue block → render dialogue-style.
  const hasMarker = cells.some(c => /\*\*\(\d+\)/.test(c));
  const renderAsDialogue = (hasMarker || !!forceDialogueRow) && !isLabelRow;
  if (renderAsDialogue && qNumToId && answers && onAnswer && sectionType) {
    // Render the dialogue cells only — drop the printed "Q26 ( )" /
    // "Q26 (  )" answer-column hint (and empty filler cells) that
    // the OCR carries over from the print layout. Each surviving
    // cell is rendered as its own dialogue paragraph with inline
    // inputs via PassageLine.
    const isAnswerColumn = (s: string) => /^Q\s*\d+\s*\(\s*\)$/i.test(s.trim()) || s.trim() === "";
    const visibleCells = cells.filter(c => !isAnswerColumn(c));
    if (visibleCells.length === 0) return null;
    return (
      <div className="my-1.5">
        {visibleCells.map((cell, ci) => (
          <PassageLine
            key={ci}
            line={cell}
            sectionType={sectionType}
            qNumToId={qNumToId}
            qNumToDisplayNum={qNumToDisplayNum ?? new Map()}
            answers={answers}
            onAnswer={onAnswer}
            onFocusInput={onFocusInput}
            emptyFieldIds={emptyFieldIds}
          />
        ))}
      </div>
    );
  }
  return (
    <div className="flex gap-2 my-1">
      {cells.map((cell, ci) => {
        const isLabelCellUsed = isLabelRow && usedLetters?.has(cell) === true;
        const isLinkedCellUsed = !!(linkedLabels && linkedLabels[ci] && usedLetters?.has(linkedLabels[ci]) === true);
        const isLabeledPhraseUsed = isLabeledPhraseRow && cellLabels[ci] != null && usedLetters?.has(cellLabels[ci]!) === true;
        const isUsed = isLabelCellUsed || isLinkedCellUsed || isLabeledPhraseUsed;
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
  underscoreOffset = 0,
}: {
  line: string;
  sectionType: "grammar-cloze" | "editing" | "comprehension-cloze";
  qNumToId: Map<number, string>;
  qNumToDisplayNum: Map<number, number>;
  answers: Record<string, string>;
  onAnswer: (questionId: string, answer: string) => void;
  onFocusInput?: () => void;
  emptyFieldIds?: Set<string>;
  // For lines containing plain ______ markers (Chinese 完成对话), this
  // is the cumulative count of underscore-blanks BEFORE this line.
  // Each underscore in this line maps to qNumToId.get(-(globalIdx+1)).
  underscoreOffset?: number;
}) {
  // Parse bold markers with question numbers (English): **(29)________** or **(39) beleive**
  // AND plain ______ markers (Chinese 完成对话 dialogue blanks).
  const parts: React.ReactNode[] = [];
  const regex = /\*\*\((\d+)\)([^*]*)\*\*|(_{6,})/g;
  let lastIdx = 0;
  let match;
  let lineUnderscoreIdx = 0;

  while ((match = regex.exec(line)) !== null) {
    // Add text before the match
    if (match.index > lastIdx) {
      parts.push(<span key={`t${lastIdx}`}>{...renderInlineBold(line.slice(lastIdx, match.index))}</span>);
    }

    const isUnderscoreOnly = match[3] !== undefined;
    let qNum: number;
    let displayNum: number;
    let content: string;
    let qId: string | undefined;

    if (isUnderscoreOnly) {
      // Plain ______ marker (Chinese 完成对话) — keyed by the synthetic
      // negative sentinel set up in PassageWithInputs.
      const globalIdx = underscoreOffset + lineUnderscoreIdx;
      lineUnderscoreIdx++;
      qNum = -(globalIdx + 1);
      qId = qNumToId.get(qNum);
      displayNum = qNumToDisplayNum.get(qNum) ?? (globalIdx + 1);
      content = "";
    } else {
      qNum = parseInt(match[1]);
      displayNum = qNumToDisplayNum.get(qNum) ?? qNum;
      content = match[2].trim();
      qId = qNumToId.get(qNum);
    }

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
            <FormattedText text={para} />
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

  // Plain text fallback — preferred for Chinese passages now that
  // the OCR step emits plain paragraphs instead of a line-numbered
  // table. Split on blank lines (paragraph boundaries) and indent
  // each paragraph with text-indent 2em. Bold / underline markers
  // travel through FormattedText so they actually render.
  const isChinesePlain = hasChinese && !isTable;
  if (isChinesePlain) {
    const paras = text
      .split(/\n\s*\n+/)
      .map(p => p.replace(/^[\s\t　]+|\s+$/g, ""))
      .filter(Boolean);
    return (
      <div className="mb-8 bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100 w-full">
        {paras.map((para, pi) => (
          <p key={pi} className="text-base text-[#0b1c30] leading-loose mb-3 last:mb-0" style={{ textIndent: "2em", whiteSpace: "pre-wrap" }}>
            <FormattedText text={para} />
          </p>
        ))}
      </div>
    );
  }
  return (
    <div className="mb-8 bg-white rounded-2xl p-4 lg:p-6 shadow-sm border border-slate-100 max-h-[600px] overflow-y-auto overflow-x-hidden w-full lg:max-h-none lg:overflow-visible">
      <p className="text-[#0b1c30] leading-relaxed whitespace-pre-wrap text-justify" style={{ overflowWrap: "break-word", wordBreak: "break-word", hyphens: "auto", fontSize: "clamp(12px, 1vw, 14px)" }}>{text}</p>
    </div>
  );
}

/** Transparent drawing overlay for passage annotation (underlining, circling) */
// Chinese passage annotation overlay. Mounted always so the canvas
// bitmap survives a tool-switch — the input-focus auto-switches `tool`
// to "type", which under the old conditional-mount setup unmounted the
// canvas and wiped every annotation the student had drawn. `enabled`
// only toggles pointer-events / handlers, never the element itself.
// Resize preserves existing strokes via an offscreen-canvas snapshot.
// Intentionally a Chinese-local copy of the same shape as the English
// overlay — kept forked per the Chinese-pathway isolation rule.
function PassageScratchOverlay({ enabled }: { enabled: boolean }) {
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
      const newW = w * 2;
      const newH = h * 2;
      if (canvas.width === newW && canvas.height === newH
          && canvas.style.width === `${w}px` && canvas.style.height === `${h}px`) return;
      const hadContent = canvas.width > 0 && canvas.height > 0;
      let snapshot: HTMLCanvasElement | null = null;
      if (hadContent) {
        snapshot = document.createElement("canvas");
        snapshot.width = canvas.width;
        snapshot.height = canvas.height;
        const sctx = snapshot.getContext("2d");
        if (sctx) sctx.drawImage(canvas, 0, 0);
      }
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      canvas.width = newW;
      canvas.height = newH;
      if (snapshot) {
        const ctx = canvas.getContext("2d");
        ctx?.drawImage(snapshot, 0, 0, newW, newH);
      }
    });
    obs.observe(parent);
    return () => obs.disconnect();
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0"
      // z-index flips with `enabled`: when pen is on we sit above the
      // inline-input wrappers (relative z-20 on each `(N)` cloze input
      // in PassageLine), so the student can draw across the input
      // areas. When pen is off we drop below the inputs so taps reach
      // the text fields normally.
      style={{ touchAction: "none", pointerEvents: enabled ? "auto" : "none", zIndex: enabled ? 30 : 10 }}
      onPointerDown={enabled ? onDown : undefined}
      onPointerMove={enabled ? onMove : undefined}
      onPointerUp={enabled ? onUp : undefined}
      onPointerCancel={enabled ? onUp : undefined}
    />
  );
}
