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
  marksAvailable?: number | null;
}

export default function QuestionReviewList({
  questions,
  onUpdateQuestion,
  onDeleteQuestion,
  onRedoQuestion,
  onRedoAnswer,
  onUpdateMarks,
  redoingIndices,
  redoingAnswerIndices,
}: {
  questions: ReviewQuestion[];
  onUpdateQuestion: (
    index: number,
    field: "questionNum" | "answer" | "answerImageData",
    value: string
  ) => void;
  onDeleteQuestion: (index: number) => void;
  onRedoQuestion?: (index: number) => void;
  onRedoAnswer?: (index: number) => void;
  onUpdateMarks?: (index: number, value: number | null) => void;
  redoingIndices?: Set<number>;
  redoingAnswerIndices?: Set<number>;
}) {
  return (
    <div className="space-y-4">
      {questions.map((q, idx) => {
        const isRedoing = redoingIndices?.has(idx) ?? false;
        const isRedoingAnswer = redoingAnswerIndices?.has(idx) ?? false;
        const stableKey = `${q.questionNum}-${q.pageIndex}-${q.orderIndex}`;
        const hasBoundaryInfo = Boolean(q.boundaryTop || q.boundaryBottom);
        const hasAnswerImage = Boolean(q.answerImageData);

        return (
          <div
            key={stableKey}
            className={`rounded-2xl border-2 bg-white p-4 shadow-sm ${
              isRedoing
                ? "border-purple-300 bg-purple-50/30"
                : isRedoingAnswer
                  ? "border-green-300 bg-green-50/30"
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
                {onUpdateMarks != null && (
                  <span className="flex items-center gap-1">
                    <label className="text-xs text-slate-400 ml-1">Marks</label>
                    <input
                      type="number"
                      value={q.marksAvailable ?? ""}
                      onChange={(e) => onUpdateMarks(idx, e.target.value ? parseFloat(e.target.value) : null)}
                      placeholder="?"
                      min="0"
                      step="0.5"
                      className="w-14 text-sm border border-slate-200 rounded-lg px-2 py-1 text-center focus:outline-none focus:border-primary-300"
                    />
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                {onRedoQuestion != null && (
                  <button
                    onClick={() => onRedoQuestion(idx)}
                    disabled={isRedoing}
                    className="p-1.5 rounded-full text-slate-400 hover:text-purple-600 hover:bg-purple-50 transition-colors disabled:opacity-30"
                    aria-label="Redo extraction"
                    title="Re-extract this question"
                  >
                    <span className="inline-flex items-center justify-center w-4 h-4">
                      {isRedoing ? (
                        <span className="animate-spin rounded-full h-4 w-4 border-2 border-purple-200 border-t-purple-500 inline-block" />
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
                    </span>
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

            {hasBoundaryInfo ? (
              <p className="text-xs text-slate-400 mb-2 font-mono">
                Top: Q{q.boundaryTop || "?"} | Bottom: {q.boundaryBottom === "not found" ? (
                  <span className="text-amber-500">not found</span>
                ) : (
                  <span>Q{q.boundaryBottom}</span>
                )}
              </p>
            ) : null}

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-slate-400">Answer</label>
                {onRedoAnswer != null && (
                  <button
                    onClick={() => onRedoAnswer(idx)}
                    disabled={isRedoingAnswer}
                    className="text-xs text-green-500 hover:text-green-700 disabled:opacity-30 flex items-center gap-1"
                    title="Re-detect answer from answer key"
                  >
                    <span className="inline-flex items-center gap-1">
                      {isRedoingAnswer ? (
                        <span className="animate-spin rounded-full h-3 w-3 border-2 border-green-200 border-t-green-500 inline-block" />
                      ) : (
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          width="12"
                          height="12"
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
                      <span>Redo answer</span>
                    </span>
                  </button>
                )}
              </div>
              <div className={hasAnswerImage ? "mb-2" : undefined}>
                {hasAnswerImage ? (
                  <div>
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
                ) : (
                  <label className="inline-block text-xs px-3 py-1.5 rounded-lg border border-dashed border-slate-300 text-slate-500 hover:text-primary-600 hover:border-primary-300 transition-colors cursor-pointer mb-1">
                    <span>+ Add answer image</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = () => {
                          if (typeof reader.result === "string") {
                            onUpdateQuestion(idx, "answerImageData", reader.result);
                          }
                        };
                        reader.readAsDataURL(file);
                        e.target.value = "";
                      }}
                    />
                  </label>
                )}
              </div>
              <input
                type="text"
                value={q.answer}
                onChange={(e) => onUpdateQuestion(idx, "answer", e.target.value)}
                placeholder={hasAnswerImage ? "Text summary (optional)" : "No answer extracted"}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-primary-300"
              />
            </div>
          </div>
        );
      })}

      {questions.length === 0 && (
        <div className="text-center py-8">
          <p className="text-slate-400">No questions extracted</p>
        </div>
      )}
    </div>
  );
}
