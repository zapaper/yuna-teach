"use client";

import { Suspense, useEffect, useState, use } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ExamPaperDetail } from "@/types";
import QuestionCard from "@/components/QuestionCard";
import PdfViewer from "@/components/PdfViewer";

export default function ExamPracticePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <Suspense>
      <ExamPracticeContent id={id} />
    </Suspense>
  );
}

function ExamPracticeContent({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId");

  const [paper, setPaper] = useState<ExamPaperDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showPdf, setShowPdf] = useState(false);

  useEffect(() => {
    async function fetchPaper() {
      try {
        const res = await fetch(`/api/exam/${id}`);
        if (!res.ok) throw new Error("Not found");
        const data = await res.json();
        setPaper(data);
      } catch (err) {
        console.error("Failed to fetch exam:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchPaper();
  }, [id]);

  const backPath = userId ? `/home/${userId}` : "/";

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
        <p className="text-slate-500">Exam paper not found</p>
        <button
          onClick={() => router.push(backPath)}
          className="mt-4 text-primary-500 underline"
        >
          Go Home
        </button>
      </div>
    );
  }

  const questions = paper.questions;

  return (
    <div className="p-6 pb-24">
      <button
        onClick={() => router.push(backPath)}
        className="flex items-center gap-1 text-slate-500 mb-4 hover:text-slate-700"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m15 18-6-6 6-6" />
        </svg>
        Home
      </button>

      <div className="mb-4">
        <h1 className="text-xl font-bold text-slate-800">{paper.title}</h1>
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          {paper.subject && (
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
              {paper.subject}
            </span>
          )}
          {paper.level && (
            <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-green-100 text-green-700">
              {paper.level}
            </span>
          )}
        </div>
      </div>

      {paper.pdfPath && (
        <div className="mb-4">
          <button
            onClick={() => setShowPdf((v) => !v)}
            className="flex items-center gap-2 text-sm font-medium text-primary-600 hover:text-primary-700"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            {showPdf ? "Hide Paper" : "View Paper"}
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
              className={`transition-transform ${showPdf ? "rotate-180" : ""}`}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {showPdf && (
            <div className="mt-3">
              <PdfViewer pdfUrl={`/api/exam/${id}/pdf`} />
            </div>
          )}
        </div>
      )}

      {questions.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-slate-500">No questions in this exam paper</p>
        </div>
      ) : (
        <QuestionCard
          question={questions[currentIndex]}
          current={currentIndex + 1}
          total={questions.length}
          onPrev={() => setCurrentIndex((i) => Math.max(0, i - 1))}
          onNext={() =>
            setCurrentIndex((i) => Math.min(questions.length - 1, i + 1))
          }
        />
      )}
    </div>
  );
}
