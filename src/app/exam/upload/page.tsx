"use client";

import { Suspense, useState, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { renderPdfToImages, cropQuestionFromPage } from "@/lib/pdf";
import QuestionReviewList from "@/components/QuestionReviewList";

type Step = "upload" | "processing" | "review";

interface HeaderInfo {
  school: string;
  level: string;
  subject: string;
  year: string;
  semester: string;
  title: string;
}

interface ExtractedQuestion {
  questionNum: string;
  imageData: string;
  answer: string;
  pageIndex: number;
  orderIndex: number;
}

export default function ExamUploadPage() {
  return (
    <Suspense>
      <ExamUploadContent />
    </Suspense>
  );
}

function ExamUploadContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>("upload");
  const [pageImages, setPageImages] = useState<string[]>([]);
  const [headerInfo, setHeaderInfo] = useState<HeaderInfo>({
    school: "",
    level: "",
    subject: "",
    year: "",
    semester: "",
    title: "",
  });
  const [questions, setQuestions] = useState<ExtractedQuestion[]>([]);
  const [processingStatus, setProcessingStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type !== "application/pdf") {
      setError("Please select a PDF file");
      return;
    }

    setError(null);
    setStep("processing");
    setProcessingStatus("Rendering PDF pages...");

    try {
      const images = await renderPdfToImages(file);
      setPageImages(images);
      await processPages(images);
    } catch (err) {
      console.error("PDF processing error:", err);
      setError(
        err instanceof Error ? err.message : "Failed to process PDF"
      );
      setStep("upload");
    }
  }

  async function processPages(images: string[]) {
    const allQuestions: ExtractedQuestion[] = [];
    const existingQuestionNums: string[] = [];
    const answerSheetPages: string[] = [];
    let header: HeaderInfo | null = null;

    for (let i = 0; i < images.length; i++) {
      setProcessingStatus(
        `Analyzing page ${i + 1} of ${images.length}...`
      );

      // Analyze header from first page
      if (i === 0) {
        try {
          const headerRes = await fetch("/api/exam/analyze-header", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ image: images[i] }),
          });
          if (headerRes.ok) {
            header = await headerRes.json();
          }
        } catch {
          // Header extraction is best-effort
        }
      }

      // Analyze page for questions
      try {
        const pageRes = await fetch("/api/exam/analyze-page", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image: images[i],
            pageIndex: i,
            existingQuestions: existingQuestionNums,
          }),
        });

        if (!pageRes.ok) continue;

        const analysis = await pageRes.json();

        if (analysis.isAnswerSheet) {
          answerSheetPages.push(images[i]);
          continue;
        }

        // Crop questions from this page
        for (const q of analysis.questions) {
          setProcessingStatus(
            `Cropping question ${q.questionNum} from page ${i + 1}...`
          );
          const croppedImage = await cropQuestionFromPage(
            images[i],
            q.yStartPct,
            q.yEndPct
          );

          allQuestions.push({
            questionNum: q.questionNum,
            imageData: croppedImage,
            answer: "",
            pageIndex: i,
            orderIndex: allQuestions.length,
          });
          existingQuestionNums.push(q.questionNum);
        }
      } catch (err) {
        console.error(`Error processing page ${i + 1}:`, err);
      }
    }

    // Extract answers from answer sheet pages
    if (answerSheetPages.length > 0) {
      setProcessingStatus("Extracting answers from answer sheet...");
      try {
        const answersRes = await fetch("/api/exam/extract-answers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ images: answerSheetPages }),
        });

        if (answersRes.ok) {
          const { answers } = await answersRes.json();
          // Match answers to questions
          for (const q of allQuestions) {
            if (answers[q.questionNum]) {
              q.answer = answers[q.questionNum];
            }
          }
        }
      } catch {
        // Answer extraction is best-effort
      }
    }

    if (header) {
      setHeaderInfo(header);
    }
    setQuestions(allQuestions);
    setStep("review");
  }

  function handleUpdateQuestion(
    index: number,
    field: "questionNum" | "answer",
    value: string
  ) {
    setQuestions((prev) =>
      prev.map((q, i) => (i === index ? { ...q, [field]: value } : q))
    );
  }

  function handleDeleteQuestion(index: number) {
    setQuestions((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);

    try {
      const res = await fetch("/api/exam/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: headerInfo.title || "Untitled Exam",
          school: headerInfo.school,
          level: headerInfo.level,
          subject: headerInfo.subject,
          year: headerInfo.year,
          semester: headerInfo.semester,
          pageCount: pageImages.length,
          userId,
          questions: questions.map((q, i) => ({
            ...q,
            orderIndex: i,
          })),
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to save");
      }

      router.push(userId ? `/home/${userId}` : "/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  const backPath = userId ? `/home/${userId}` : "/";

  return (
    <div className="p-6">
      <button
        onClick={() =>
          step === "upload" ? router.push(backPath) : setStep("upload")
        }
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
        Back
      </button>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 mb-4 text-red-700 text-sm">
          {error}
          <button
            onClick={() => setError(null)}
            className="ml-2 underline text-red-500"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Upload step */}
      {step === "upload" && (
        <div>
          <h1 className="text-xl font-bold text-slate-800 mb-6">
            Upload Exam Paper
          </h1>

          <div className="space-y-4">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-full bg-purple-500 text-white rounded-2xl py-4 px-6 text-lg font-semibold shadow-md active:scale-[0.98] transition-transform"
            >
              Select PDF File
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              onChange={handleFileSelect}
              className="hidden"
            />

            <div
              className="border-2 border-dashed border-slate-200 rounded-2xl p-8 text-center cursor-pointer hover:border-purple-300 hover:bg-purple-50/50 transition-colors"
              onClick={() => fileInputRef.current?.click()}
            >
              <div className="text-3xl mb-2">📄</div>
              <p className="text-slate-500 text-sm">
                Tap to select a PDF exam paper
              </p>
              <p className="text-slate-400 text-xs mt-1">
                Supports multi-page PDF documents
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Processing step */}
      {step === "processing" && (
        <div className="flex flex-col items-center py-16">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-purple-200 border-t-purple-500 mb-6" />
          <p className="text-lg font-medium text-slate-700">Processing...</p>
          <p className="text-sm text-slate-500 mt-2">{processingStatus}</p>
        </div>
      )}

      {/* Review step */}
      {step === "review" && (
        <div>
          <h1 className="text-xl font-bold text-slate-800 mb-4">
            Review Exam Paper
          </h1>

          {/* Header info */}
          <div className="bg-slate-50 rounded-2xl p-4 mb-6 space-y-3">
            <div>
              <label className="text-xs text-slate-400 mb-1 block">Title</label>
              <input
                type="text"
                value={headerInfo.title}
                onChange={(e) =>
                  setHeaderInfo((h) => ({ ...h, title: e.target.value }))
                }
                placeholder="Exam paper title"
                className="w-full text-sm font-semibold border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-primary-300"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-slate-400 mb-1 block">
                  School
                </label>
                <input
                  type="text"
                  value={headerInfo.school}
                  onChange={(e) =>
                    setHeaderInfo((h) => ({ ...h, school: e.target.value }))
                  }
                  placeholder="School name"
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-primary-300"
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">
                  Level
                </label>
                <input
                  type="text"
                  value={headerInfo.level}
                  onChange={(e) =>
                    setHeaderInfo((h) => ({ ...h, level: e.target.value }))
                  }
                  placeholder="e.g. P4"
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-primary-300"
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">
                  Subject
                </label>
                <input
                  type="text"
                  value={headerInfo.subject}
                  onChange={(e) =>
                    setHeaderInfo((h) => ({ ...h, subject: e.target.value }))
                  }
                  placeholder="e.g. Math"
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-primary-300"
                />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1 block">
                  Year
                </label>
                <input
                  type="text"
                  value={headerInfo.year}
                  onChange={(e) =>
                    setHeaderInfo((h) => ({ ...h, year: e.target.value }))
                  }
                  placeholder="e.g. 2024"
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-primary-300"
                />
              </div>
            </div>
          </div>

          {/* Questions */}
          <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">
            Questions ({questions.length})
          </h2>

          <QuestionReviewList
            questions={questions}
            onUpdateQuestion={handleUpdateQuestion}
            onDeleteQuestion={handleDeleteQuestion}
          />

          <div className="mt-6 pb-6">
            <button
              onClick={handleSave}
              disabled={saving || questions.length === 0}
              className="w-full bg-accent-green text-white rounded-2xl py-4 px-6 text-lg font-semibold shadow-md active:scale-[0.98] transition-transform disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? "Saving..." : "Save Exam Paper"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
