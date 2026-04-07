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
  sectionType: "grammar-cloze" | "editing" | "comprehension-cloze" | "visual-text-mcq";
  answers: Record<string, string>;
  onAnswer: (questionId: string, answer: string) => void;
}

/**
 * Renders an English quiz section with typed answers:
 * - Grammar Cloze: passage with letter inputs (A-Q)
 * - Editing: passage with correction inputs
 * - Comprehension Cloze: passage with word inputs
 * - Visual Text MCQ: scanned image + MCQ options
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
      {passage && sectionType !== "visual-text-mcq" && (
        <PassageWithInputs
          passage={passage}
          questions={questions}
          sectionType={sectionType}
          answers={answers}
          onAnswer={onAnswer}
        />
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
  // Map question numbers to question IDs for input binding
  const qNumToId = new Map(questions.map(q => [parseInt(q.questionNum), q.id]));

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
  answers,
  onAnswer,
}: {
  line: string;
  sectionType: "grammar-cloze" | "editing" | "comprehension-cloze";
  qNumToId: Map<number, string>;
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
    const content = match[2].trim();
    const qId = qNumToId.get(qNum);

    if (sectionType === "grammar-cloze" || sectionType === "comprehension-cloze") {
      // Cloze: show question number + text input
      parts.push(
        <span key={`q${qNum}`} className="inline-flex items-center gap-1 mx-1">
          <span className="text-[10px] font-bold text-blue-600 bg-blue-50 px-1 rounded">({qNum})</span>
          <input
            type="text"
            value={qId ? (answers[qId] ?? "") : ""}
            onChange={e => qId && onAnswer(qId, e.target.value.toUpperCase())}
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
          <span className="text-[10px] font-bold text-blue-600 bg-blue-50 px-1 rounded">({qNum})</span>
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
    <p className="leading-relaxed text-sm text-[#0b1c30] my-1" style={indent ? { textIndent: "2em" } : undefined}>
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

    // Parse [VISUAL_TEXT_SOURCE:paperId] — load all pages from source paper
    const sourceMatch = passage.match(/^\[VISUAL_TEXT_SOURCE:([^\]]+)\]$/);
    if (sourceMatch) {
      const paperId = sourceMatch[1];
      fetch(`/api/exam/${paperId}/pages`)
        .then(r => r.json())
        .then(async ({ pageCount }: { pageCount: number }) => {
          if (!pageCount) return;
          // Load all pages — visual text pages are typically near the end
          const urls = await Promise.all(
            Array.from({ length: pageCount }, (_, i) => i).map(async (pageIdx) => {
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
