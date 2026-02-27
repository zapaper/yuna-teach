"use client";

import { useState } from "react";
import { ExamQuestionItem } from "@/types";

export default function QuestionCard({
  question,
  current,
  total,
  onPrev,
  onNext,
}: {
  question: ExamQuestionItem;
  current: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const [showAnswer, setShowAnswer] = useState(false);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-slate-800">
          Question {question.questionNum}
        </h2>
        <span className="text-sm text-slate-400">
          {current} / {total}
        </span>
      </div>

      <div className="rounded-2xl border-2 border-slate-100 bg-white p-2 shadow-sm mb-4">
        <img
          src={question.imageData}
          alt={`Question ${question.questionNum}`}
          className="w-full rounded-xl"
        />
      </div>

      {!showAnswer ? (
        <button
          onClick={() => setShowAnswer(true)}
          className="w-full bg-primary-500 text-white rounded-2xl py-3 px-6 font-semibold shadow-md active:scale-[0.98] transition-transform mb-4"
        >
          Show Answer
        </button>
      ) : (
        <div className="bg-green-50 border border-green-200 rounded-2xl p-4 mb-4">
          <p className="text-sm font-medium text-green-700 mb-1">Answer:</p>
          <p className="text-green-800 font-semibold">
            {question.answer || "No answer available"}
          </p>
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={() => {
            setShowAnswer(false);
            onPrev();
          }}
          disabled={current <= 1}
          className="flex-1 py-3 px-4 rounded-xl border border-slate-200 text-slate-600 font-medium hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Previous
        </button>
        <button
          onClick={() => {
            setShowAnswer(false);
            onNext();
          }}
          disabled={current >= total}
          className="flex-1 py-3 px-4 rounded-xl bg-primary-600 text-white font-medium hover:bg-primary-700 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Next
        </button>
      </div>
    </div>
  );
}
