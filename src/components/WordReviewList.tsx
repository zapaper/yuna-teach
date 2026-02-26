"use client";

import { ExtractedTest } from "@/types";

interface WordReviewListProps {
  tests: ExtractedTest[];
  onToggleWord: (testIndex: number, wordIndex: number) => void;
  onUpdateTitle: (testIndex: number, title: string) => void;
  toggledOff: Set<string>; // "testIndex-wordIndex" keys
}

export default function WordReviewList({
  tests,
  onToggleWord,
  onUpdateTitle,
  toggledOff,
}: WordReviewListProps) {
  return (
    <div className="space-y-6">
      {tests.map((test, testIdx) => (
        <div
          key={testIdx}
          className="rounded-2xl border-2 border-slate-100 bg-white overflow-hidden"
        >
          {/* Test header */}
          <div className="bg-primary-50 p-4 border-b border-primary-100">
            <input
              type="text"
              value={test.title}
              onChange={(e) => onUpdateTitle(testIdx, e.target.value)}
              className="font-semibold text-lg text-primary-700 bg-transparent border-none outline-none w-full font-chinese"
            />
            {test.subtitle && (
              <p className="text-sm text-primary-500 mt-0.5 font-chinese">
                {test.subtitle}
              </p>
            )}
            <span
              className={`inline-block mt-2 text-xs font-medium px-2 py-0.5 rounded-full ${
                test.language === "CHINESE"
                  ? "bg-red-100 text-red-700"
                  : "bg-blue-100 text-blue-700"
              }`}
            >
              {test.language === "CHINESE" ? "中文" : "English"}
            </span>
          </div>

          {/* Word list */}
          <div className="p-3">
            {test.words.map((word, wordIdx) => {
              const key = `${testIdx}-${wordIdx}`;
              const isEnabled = !toggledOff.has(key);

              return (
                <label
                  key={wordIdx}
                  className={`flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-colors ${
                    isEnabled ? "hover:bg-slate-50" : "opacity-50"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={isEnabled}
                    onChange={() => onToggleWord(testIdx, wordIdx)}
                    className="w-5 h-5 rounded accent-primary-500"
                  />
                  <span className="text-slate-400 text-sm w-6">
                    {word.orderIndex}.
                  </span>
                  <span
                    className={`text-lg font-chinese ${
                      isEnabled ? "text-slate-800" : "text-slate-400 line-through"
                    }`}
                  >
                    {word.text}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
