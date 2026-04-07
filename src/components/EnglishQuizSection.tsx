"use client";

import { useEffect, useState } from "react";

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
export default function EnglishQuizSection({ sectionLabel, passage, questions, sectionType, answers, onAnswer }: Props) {
  return (
    <div className="mb-12">
      {/* Section header */}
      <div className="mb-6">
        <h2 className="font-headline text-xl lg:text-2xl font-extrabold text-[#001e40] tracking-tight">{sectionLabel.toUpperCase()}</h2>
        {sectionType === "grammar-cloze" && <p className="text-[#737780] mt-1 text-sm">Select the correct word from the word bank for each blank.</p>}
        {sectionType === "editing" && <p className="text-[#737780] mt-1 text-sm">Write the correct spelling for each underlined word.</p>}
        {sectionType === "comprehension-cloze" && <p className="text-[#737780] mt-1 text-sm">Fill in each blank with a suitable word.</p>}
      </div>

      {/* Visual Text: show scanned page images */}
      {sectionType === "visual-text-mcq" && (
        <VisualTextImages passage={passage ?? ""} fallbackImage={questions.find(q => q.imageData && q.imageData.length > 100)?.imageData} />
      )}

      {/* Passage with inline inputs (Grammar Cloze, Editing, Comp Cloze) */}
      {passage && (sectionType === "grammar-cloze" || sectionType === "editing" || sectionType === "comprehension-cloze") && (
        <PassageWithInputs
          passage={passage}
          questions={questions}
          sectionType={sectionType}
          answers={answers}
          onAnswer={onAnswer}
        />
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

            // For synthesis: parse **bold starting word** and _______ answer area
            // e.g., "**Instead of** _______" → bold "Instead of" + input
            const synthParts: { type: "bold" | "text" | "blank"; content: string }[] = [];
            if (sectionType === "synthesis") {
              const synthRegex = /\*\*([^*]+)\*\*|_{3,}/g;
              let lastEnd = 0;
              let sm;
              while ((sm = synthRegex.exec(cleanStem)) !== null) {
                if (sm.index > lastEnd) {
                  const between = cleanStem.slice(lastEnd, sm.index).trim();
                  if (between) synthParts.push({ type: "text", content: between });
                }
                if (sm[1]) {
                  synthParts.push({ type: "bold", content: sm[1] });
                } else {
                  synthParts.push({ type: "blank", content: "" });
                }
                lastEnd = sm.index + sm[0].length;
              }
              if (lastEnd < cleanStem.length) {
                const remaining = cleanStem.slice(lastEnd).trim();
                if (remaining) synthParts.push({ type: "text", content: remaining });
              }
              // If no blanks found, add one at the end
              if (!synthParts.some(p => p.type === "blank")) {
                synthParts.push({ type: "blank", content: "" });
              }
            }

            return (
              <div key={q.id} className="bg-white rounded-2xl p-5 lg:p-6 shadow-sm border border-slate-100">
                <div className="flex items-start gap-3 mb-4">
                  <span className="w-10 h-10 rounded-xl bg-[#001e40] flex items-center justify-center text-white font-bold text-sm shrink-0">
                    {displayNum}
                  </span>
                  <div className="flex-1 min-w-0">
                    {sectionType === "comprehension-oeq" && (
                      <p className="text-base text-[#001e40] leading-relaxed whitespace-pre-wrap">{cleanStem}</p>
                    )}
                    {q.marksAvailable && (
                      <span className="text-[10px] font-bold text-[#003366] bg-[#d3e4fe] px-2 py-0.5 rounded uppercase tracking-wider">
                        {q.marksAvailable} {q.marksAvailable > 1 ? "marks" : "mark"}
                      </span>
                    )}
                  </div>
                </div>

                {/* Synthesis: bold starting word + typed input */}
                {sectionType === "synthesis" && (
                  <div className="mt-3">
                    <div className="flex flex-wrap items-baseline gap-1 mb-2">
                      {synthParts.map((part, pi) => {
                        if (part.type === "bold") return <span key={pi} className="font-bold text-base text-[#001e40]">{part.content}</span>;
                        if (part.type === "text") return <span key={pi} className="text-base text-[#0b1c30]">{part.content}</span>;
                        return null;
                      })}
                    </div>
                    <textarea
                      value={answers[q.id] ?? ""}
                      onChange={e => onAnswer(q.id, e.target.value)}
                      rows={lineCount}
                      className="w-full border-2 border-slate-200 focus:border-[#003366] outline-none rounded-xl px-4 py-3 text-base text-[#001e40] resize-none leading-relaxed"
                      placeholder="Type your answer here..."
                    />
                  </div>
                )}

                {/* Comprehension OEQ: typed answer lines */}
                {sectionType === "comprehension-oeq" && (
                  <textarea
                    value={answers[q.id] ?? ""}
                    onChange={e => onAnswer(q.id, e.target.value)}
                    rows={lineCount}
                    className="w-full border-2 border-slate-200 focus:border-[#003366] outline-none rounded-xl px-4 py-3 text-base text-[#001e40] resize-none leading-relaxed mt-3"
                    placeholder="Type your answer here..."
                  />
                )}
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
              <p className="font-bold text-sm text-[#001e40] mb-1">Question {parseInt(q.questionNum)}</p>
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
}: {
  passage: string;
  questions: QuizQuestion[];
  sectionType: "grammar-cloze" | "editing" | "comprehension-cloze";
  answers: Record<string, string>;
  onAnswer: (questionId: string, answer: string) => void;
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
    <div className="bg-white rounded-2xl p-5 lg:p-8 shadow-sm border border-slate-100">
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
          />
        );
      })}
    </div>
  );
}

function TableLine({ line }: { line: string }) {
  const cells = line.split("|").slice(1, -1).map(c => c.trim());
  return (
    <div className="flex gap-2 my-1">
      {cells.map((cell, ci) => (
        <span key={ci} className="flex-1 text-center text-xs font-medium text-[#001e40] bg-[#eff4ff] rounded px-2 py-1">{cell}</span>
      ))}
    </div>
  );
}

function PassageLine({
  line,
  sectionType,
  qNumToId,
  qNumToDisplayNum,
  answers,
  onAnswer,
}: {
  line: string;
  sectionType: "grammar-cloze" | "editing" | "comprehension-cloze";
  qNumToId: Map<number, string>;
  qNumToDisplayNum: Map<number, number>;
  answers: Record<string, string>;
  onAnswer: (questionId: string, answer: string) => void;
}) {
  // Parse bold markers with question numbers: **(29)________** or **(39) beleive**
  const parts: React.ReactNode[] = [];
  const regex = /\*\*\((\d+)\)([^*]*)\*\*/g;
  let lastIdx = 0;
  let match;

  while ((match = regex.exec(line)) !== null) {
    // Add text before the match
    if (match.index > lastIdx) {
      parts.push(<span key={`t${lastIdx}`}>{line.slice(lastIdx, match.index)}</span>);
    }

    const qNum = parseInt(match[1]);
    const displayNum = qNumToDisplayNum.get(qNum) ?? qNum;
    const content = match[2].trim();
    const qId = qNumToId.get(qNum);

    if (sectionType === "grammar-cloze" || sectionType === "comprehension-cloze") {
      // Cloze: show question number + text input
      parts.push(
        <span key={`q${qNum}`} className="inline-flex items-center gap-1 mx-1">
          <span className="text-[10px] font-bold text-blue-600 bg-blue-50 px-1 rounded">({displayNum})</span>
          <input
            type="text"
            value={qId ? (answers[qId] ?? "") : ""}
            onChange={e => qId && onAnswer(qId, sectionType === "grammar-cloze" ? e.target.value.toUpperCase() : e.target.value)}
            className={`border-b-2 border-slate-300 focus:border-[#003366] outline-none text-center font-bold text-sm bg-transparent ${
              sectionType === "grammar-cloze" ? "w-8" : "w-24"
            }`}
            maxLength={sectionType === "grammar-cloze" ? 1 : 20}
            placeholder={sectionType === "grammar-cloze" ? "_" : "________"}
          />
        </span>
      );
    } else if (sectionType === "editing") {
      // Editing: show question number + error word + correction input
      parts.push(
        <span key={`q${qNum}`} className="inline-flex items-center gap-1 mx-1">
          <span className="text-[10px] font-bold text-blue-600 bg-blue-50 px-1 rounded">({displayNum})</span>
          <span className="underline decoration-red-400 decoration-2 font-bold text-red-700 text-sm">{content}</span>
          <input
            type="text"
            value={qId ? (answers[qId] ?? "") : ""}
            onChange={e => qId && onAnswer(qId, e.target.value)}
            className="border-2 border-slate-200 focus:border-[#003366] outline-none rounded px-2 py-0.5 text-sm w-28 bg-white"
            placeholder="correct word"
          />
        </span>
      );
    }

    lastIdx = match.index + match[0].length;
  }

  // Add remaining text
  if (lastIdx < line.length) {
    parts.push(<span key={`end`}>{line.slice(lastIdx)}</span>);
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
