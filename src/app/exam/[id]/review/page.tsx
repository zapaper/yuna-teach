"use client";

import { Suspense, useEffect, useState, use } from "react";
import { useRouter, useSearchParams } from "next/navigation";

interface ReviewQuestion {
  id: string;
  questionNum: string;
  answer: string | null;
  marksAwarded: number | null;
  marksAvailable: number | null;
  markingNotes: string | null;
}

interface ReviewData {
  markingStatus: string | null;
  score: number | null;
  feedbackSummary: string | null;
  questions: ReviewQuestion[];
}

export default function ExamReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <Suspense>
      <ExamReviewContent id={id} />
    </Suspense>
  );
}

function ExamReviewContent({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";

  const [data, setData] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [paperTitle, setPaperTitle] = useState("");
  const [totalMarks, setTotalMarks] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        const [markRes, paperRes] = await Promise.all([
          fetch(`/api/exam/${id}/mark`),
          fetch(`/api/exam/${id}`),
        ]);
        if (markRes.ok) setData(await markRes.json());
        if (paperRes.ok) {
          const paper = await paperRes.json();
          setPaperTitle(paper.title ?? "");
          setTotalMarks(paper.totalMarks ?? null);
        }
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [id]);

  const backPath = `/home/${userId}`;

  if (loading) {
    return (
      <div className="flex justify-center py-24">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-200 border-t-primary-500" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-6 text-center py-24">
        <p className="text-slate-500">Could not load results.</p>
        <button onClick={() => router.push(backPath)} className="mt-4 text-primary-500 underline">
          Go Home
        </button>
      </div>
    );
  }

  if (data.markingStatus !== "released") {
    return (
      <div className="p-6 text-center py-24">
        <p className="text-slate-500">Results are not available yet.</p>
        <button onClick={() => router.push(backPath)} className="mt-4 text-primary-500 underline">
          Go Home
        </button>
      </div>
    );
  }

  const incorrectQuestions = data.questions.filter((q) => {
    if (q.marksAwarded === null || q.marksAvailable === null) return false;
    return q.marksAwarded < q.marksAvailable;
  });

  return (
    <div className="min-h-screen bg-white">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-white border-b border-slate-100 px-4 py-3 flex items-center gap-3">
        <button
          onClick={() => router.push(backPath)}
          className="p-1.5 -ml-1 rounded-lg text-slate-500 hover:text-slate-700 hover:bg-slate-100 shrink-0"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-slate-800 truncate">{paperTitle}</p>
          <p className="text-xs text-slate-400">Exam Results</p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-xl font-bold text-primary-600">
            {data.score ?? 0}
            {totalMarks ? <span className="text-sm font-normal text-slate-400"> / {totalMarks}</span> : null}
          </p>
        </div>
      </div>

      <div className="p-4 pb-24 max-w-2xl mx-auto">
        {/* Feedback summary */}
        {data.feedbackSummary ? (
          <div className="rounded-2xl bg-gradient-to-r from-primary-50 to-blue-50 border border-slate-100 p-4 mb-6">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Summary</p>
            <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-line">
              {data.feedbackSummary}
            </p>
          </div>
        ) : null}

        {/* Questions to review */}
        {incorrectQuestions.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-3xl mb-3">&#127881;</p>
            <p className="text-slate-600 font-medium">Perfect score!</p>
            <p className="text-slate-400 text-sm mt-1">You got every question right.</p>
          </div>
        ) : (
          <div>
            <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
              Questions to Review ({incorrectQuestions.length})
            </h2>
            <div className="space-y-4">
              {incorrectQuestions.map((q) => (
                <div
                  key={q.id}
                  className="rounded-2xl border border-slate-100 bg-white shadow-sm overflow-hidden"
                >
                  {/* Header */}
                  <div className="flex items-center justify-between px-4 py-3 bg-slate-50 border-b border-slate-100">
                    <span className="text-sm font-semibold text-slate-700">
                      Question {q.questionNum}
                    </span>
                    <span className={`text-sm font-bold ${
                      (q.marksAwarded ?? 0) === 0 ? "text-red-500" : "text-amber-600"
                    }`}>
                      {q.marksAwarded ?? 0} / {q.marksAvailable ?? 0}
                    </span>
                  </div>

                  <div className="px-4 py-3 space-y-3">
                    {/* Correct answer */}
                    {q.answer ? (
                      <div>
                        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                          Correct Answer
                        </p>
                        <p className="text-sm text-slate-800 leading-relaxed">
                          {q.answer.split("|").map((part, i, arr) => (
                            <span key={i}>
                              {part.trim()}
                              {i < arr.length - 1 ? <br /> : null}
                            </span>
                          ))}
                        </p>
                      </div>
                    ) : null}

                    {/* Marking notes */}
                    {q.markingNotes ? (
                      <div>
                        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1">
                          Marking Notes
                        </p>
                        <p className="text-sm text-slate-600 leading-relaxed">
                          {q.markingNotes}
                        </p>
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
