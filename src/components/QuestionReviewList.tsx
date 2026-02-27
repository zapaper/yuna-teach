"use client";

interface ReviewQuestion {
  questionNum: string;
  imageData: string;
  answer: string;
  pageIndex: number;
  orderIndex: number;
}

export default function QuestionReviewList({
  questions,
  onUpdateQuestion,
  onDeleteQuestion,
}: {
  questions: ReviewQuestion[];
  onUpdateQuestion: (
    index: number,
    field: "questionNum" | "answer",
    value: string
  ) => void;
  onDeleteQuestion: (index: number) => void;
}) {
  return (
    <div className="space-y-4">
      {questions.map((q, idx) => (
        <div
          key={idx}
          className="rounded-2xl border-2 border-slate-100 bg-white p-4 shadow-sm"
        >
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <label className="text-xs text-slate-400">Q</label>
              <input
                type="text"
                value={q.questionNum}
                onChange={(e) =>
                  onUpdateQuestion(idx, "questionNum", e.target.value)
                }
                className="w-16 text-sm font-semibold border border-slate-200 rounded-lg px-2 py-1 focus:outline-none focus:border-primary-300"
              />
            </div>
            <button
              onClick={() => onDeleteQuestion(idx)}
              className="p-1.5 rounded-full text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors"
              aria-label="Remove question"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <img
            src={q.imageData}
            alt={`Question ${q.questionNum}`}
            className="w-full rounded-xl border border-slate-200 mb-3"
          />

          <div>
            <label className="text-xs text-slate-400 mb-1 block">Answer</label>
            <input
              type="text"
              value={q.answer}
              onChange={(e) => onUpdateQuestion(idx, "answer", e.target.value)}
              placeholder="No answer extracted"
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-primary-300"
            />
          </div>
        </div>
      ))}

      {questions.length === 0 && (
        <div className="text-center py-8">
          <p className="text-slate-400">No questions extracted</p>
        </div>
      )}
    </div>
  );
}
