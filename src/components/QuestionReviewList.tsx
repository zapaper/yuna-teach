"use client";

interface ReviewQuestion {
  questionNum: string;
  imageData: string;
  answer: string;
  answerImageData?: string;
  pageIndex: number;
  orderIndex: number;
  boundaryTop?: string;
  boundaryBottom?: string;
}

export default function QuestionReviewList({
  questions,
  onUpdateQuestion,
  onDeleteQuestion,
  onRedoQuestion,
  redoingIndex,
}: {
  questions: ReviewQuestion[];
  onUpdateQuestion: (
    index: number,
    field: "questionNum" | "answer" | "answerImageData",
    value: string
  ) => void;
  onDeleteQuestion: (index: number) => void;
  onRedoQuestion?: (index: number) => void;
  redoingIndex?: number | null;
}) {
  return (
    <div className="space-y-4">
      {questions.map((q, idx) => (
        <div
          key={idx}
          className={`rounded-2xl border-2 bg-white p-4 shadow-sm ${
            redoingIndex === idx
              ? "border-purple-300 bg-purple-50/30"
              : "border-slate-100"
          }`}
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
            <div className="flex items-center gap-1">
              {onRedoQuestion && (
                <button
                  onClick={() => onRedoQuestion(idx)}
                  disabled={redoingIndex !== null && redoingIndex !== undefined}
                  className="p-1.5 rounded-full text-slate-400 hover:text-purple-600 hover:bg-purple-50 transition-colors disabled:opacity-30"
                  aria-label="Redo extraction"
                  title="Re-extract this question"
                >
                  {redoingIndex === idx ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-purple-200 border-t-purple-500" />
                  ) : (
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
                      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                      <path d="M3 3v5h5" />
                      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                      <path d="M16 16h5v5" />
                    </svg>
                  )}
                </button>
              )}
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
          </div>

          <img
            src={q.imageData}
            alt={`Question ${q.questionNum}`}
            className="w-full rounded-xl border border-slate-200 mb-2"
          />

          {(q.boundaryTop || q.boundaryBottom) && (
            <p className="text-xs text-slate-400 mb-2 font-mono">
              Top: Q{q.boundaryTop || "?"} | Bottom: {q.boundaryBottom === "not found" ? (
                <span className="text-amber-500">not found</span>
              ) : (
                <>Q{q.boundaryBottom}</>
              )}
            </p>
          )}

          <div>
            <label className="text-xs text-slate-400 mb-1 block">Answer</label>
            {q.answerImageData && (
              <div className="mb-2">
                <img
                  src={q.answerImageData}
                  alt={`Answer for Q${q.questionNum}`}
                  className="w-full rounded-lg border border-green-200"
                />
                <button
                  onClick={() => onUpdateQuestion(idx, "answerImageData", "")}
                  className="text-xs text-red-400 hover:text-red-600 mt-1"
                >
                  Remove answer image
                </button>
              </div>
            )}
            <input
              type="text"
              value={q.answer}
              onChange={(e) => onUpdateQuestion(idx, "answer", e.target.value)}
              placeholder={q.answerImageData ? "Text summary (optional)" : "No answer extracted"}
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
