"use client";

import { Suspense, useEffect, useState, use, useRef, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ExamPaperDetail, ExamQuestionItem } from "@/types";

export default function FocusedTestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <Suspense>
      <FocusedTestContent id={id} />
    </Suspense>
  );
}

function FocusedTestContent({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";

  const [paper, setPaper] = useState<ExamPaperDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [markingDone, setMarkingDone] = useState(false);
  const savingRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/exam/${id}`);
        if (!res.ok) throw new Error("Not found");
        const data: ExamPaperDetail = await res.json();
        setPaper(data);
        // Pre-fill any saved answers
        const saved: Record<string, string> = {};
        for (const q of data.questions) {
          if ((q as ExamQuestionItem & { studentAnswer?: string }).studentAnswer) {
            saved[q.id] = (q as ExamQuestionItem & { studentAnswer?: string }).studentAnswer!;
          }
        }
        setAnswers(saved);
        if (data.completedAt) {
          setSubmitted(true);
          if (data.markingStatus === "complete" || data.markingStatus === "released") {
            setMarkingDone(true);
          }
        }
        setElapsed(data.timeSpentSeconds || 0);
      } catch {
        setPaper(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  // Timer
  useEffect(() => {
    if (!submitted && paper && !loading) {
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [submitted, paper, loading]);

  // Poll for marking completion after submit
  useEffect(() => {
    if (submitted && !markingDone) {
      pollRef.current = setInterval(async () => {
        const res = await fetch(`/api/exam/${id}/mark`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.markingStatus === "complete" || data.markingStatus === "released") {
          setMarkingDone(true);
          if (pollRef.current) clearInterval(pollRef.current);
        }
      }, 3000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [submitted, markingDone, id]);

  const saveAnswer = useCallback(
    async (questionId: string, answer: string) => {
      if (savingRef.current) return;
      savingRef.current = true;
      try {
        await fetch(`/api/exam/${id}/answer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ questionId, studentAnswer: answer }),
        });
      } finally {
        savingRef.current = false;
      }
    },
    [id]
  );

  async function handleSubmit() {
    if (!paper || submitting) return;
    // Save current answer first
    const currentQ = paper.questions[currentIdx];
    const currentAnswer = answers[currentQ.id] || "";
    if (currentAnswer) {
      await saveAnswer(currentQ.id, currentAnswer);
    }
    // Save time
    await fetch(`/api/exam/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeSpentSeconds: elapsed }),
    });

    setSubmitting(true);
    try {
      await fetch(`/api/exam/${id}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "submit" }),
      });
      setSubmitted(true);
    } finally {
      setSubmitting(false);
    }
  }

  function navigateTo(newIdx: number) {
    if (!paper) return;
    // Auto-save current answer
    const currentQ = paper.questions[currentIdx];
    const currentAnswer = answers[currentQ.id] || "";
    if (currentAnswer) {
      saveAnswer(currentQ.id, currentAnswer);
    }
    setCurrentIdx(newIdx);
  }

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  if (loading) {
    return (
      <div className="flex justify-center py-24">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-200 border-t-primary-500" />
      </div>
    );
  }

  if (!paper) {
    return (
      <div className="p-6 text-center py-24">
        <p className="text-slate-500">Test not found</p>
      </div>
    );
  }

  const questions = paper.questions;
  const currentQ = questions[currentIdx];
  const answeredCount = Object.keys(answers).filter((k) => answers[k].trim()).length;

  // After submission - show marking status
  if (submitted) {
    return (
      <div className="p-6 pb-24 max-w-lg mx-auto text-center">
        <div className="py-12">
          {markingDone ? (
            <>
              <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
                <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-green-600">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </div>
              <h2 className="text-xl font-bold text-slate-800 mb-2">Test Marked!</h2>
              <p className="text-sm text-slate-500 mb-6">Your focused test has been marked by AI.</p>
              <button
                onClick={() => router.push(`/exam/${id}/review?userId=${userId}`)}
                className="px-6 py-3 rounded-2xl bg-primary-500 text-white font-semibold hover:bg-primary-600"
              >
                View Results
              </button>
            </>
          ) : (
            <>
              <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary-200 border-t-primary-500 mx-auto mb-4" />
              <h2 className="text-xl font-bold text-slate-800 mb-2">Marking in progress...</h2>
              <p className="text-sm text-slate-400">AI is checking your answers. This takes about a minute.</p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 pb-24 max-w-lg mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-lg font-bold text-slate-800">{paper.title}</h1>
          <p className="text-xs text-slate-400">{answeredCount} / {questions.length} answered</p>
        </div>
        <span className="text-sm font-mono text-slate-500 tabular-nums">{formatTime(elapsed)}</span>
      </div>

      {/* Question counter */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold text-slate-700">
          Question {currentQ.questionNum}
        </h2>
        <span className="text-sm text-slate-400">
          {currentIdx + 1} / {questions.length}
        </span>
      </div>

      {/* Question image */}
      <div className="rounded-2xl border-2 border-slate-100 bg-white p-2 shadow-sm mb-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={currentQ.imageData}
          alt={`Question ${currentQ.questionNum}`}
          className="w-full rounded-xl"
        />
      </div>

      {/* Answer input */}
      <div className="mb-4">
        <label className="text-xs font-medium text-slate-500 mb-1 block">Your answer:</label>
        <textarea
          value={answers[currentQ.id] || ""}
          onChange={(e) =>
            setAnswers((prev) => ({ ...prev, [currentQ.id]: e.target.value }))
          }
          rows={3}
          placeholder="Type your answer here..."
          className="w-full rounded-xl border-2 border-slate-200 px-4 py-3 text-sm focus:outline-none focus:border-primary-400 resize-none"
        />
      </div>

      {/* Navigation */}
      <div className="flex gap-3 mb-4">
        <button
          onClick={() => navigateTo(currentIdx - 1)}
          disabled={currentIdx === 0}
          className="flex-1 py-3 px-4 rounded-xl border border-slate-200 text-slate-600 font-medium hover:bg-slate-50 disabled:opacity-30"
        >
          Previous
        </button>
        <button
          onClick={() => navigateTo(currentIdx + 1)}
          disabled={currentIdx >= questions.length - 1}
          className="flex-1 py-3 px-4 rounded-xl bg-primary-600 text-white font-medium hover:bg-primary-700 disabled:opacity-30"
        >
          Next
        </button>
      </div>

      {/* Question dots */}
      <div className="flex justify-center gap-1.5 mb-6">
        {questions.map((q, i) => (
          <button
            key={q.id}
            onClick={() => navigateTo(i)}
            className={`w-2.5 h-2.5 rounded-full transition-colors ${
              i === currentIdx
                ? "bg-primary-500"
                : answers[q.id]?.trim()
                ? "bg-green-400"
                : "bg-slate-200"
            }`}
          />
        ))}
      </div>

      {/* Submit button */}
      <button
        onClick={handleSubmit}
        disabled={submitting}
        className="w-full py-3 rounded-2xl bg-green-500 text-white font-semibold hover:bg-green-600 disabled:opacity-50 transition-colors"
      >
        {submitting ? "Submitting..." : "Submit Test"}
      </button>
    </div>
  );
}
