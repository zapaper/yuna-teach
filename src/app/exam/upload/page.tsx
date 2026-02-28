"use client";

import { Suspense, useState, useRef, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { renderPdfToImages, cropQuestionFromPage } from "@/lib/pdf";
import { normalizeAnswer } from "@/lib/gemini";
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
  answerImageData: string;
  pageIndex: number;
  orderIndex: number;
  yStartPct: number;
  yEndPct: number;
  boundaryTop: string;
  boundaryBottom: string;
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
  const [redoingIndices, setRedoingIndices] = useState<Set<number>>(new Set());
  const [redoingAnswerIndices, setRedoingAnswerIndices] = useState<Set<number>>(new Set());
  const [answerKeyPages, setAnswerKeyPages] = useState<Array<{ pageIndex: number; paperLabel?: string }>>([]);
  const [aiAnalyzing, setAiAnalyzing] = useState(false);

  const AI_PHRASES = [
    "Reading through the exam paper...",
    "Identifying question boundaries...",
    "Checking header instructions...",
    "Looking for answer sheets...",
    "Analyzing question structure...",
    "Detecting sub-parts and segments...",
    "Almost there, still thinking...",
    "Mapping out all the questions...",
    "Extracting question details...",
    "Hang tight, this takes a moment...",
    "Scanning for diagrams and figures...",
    "Cross-checking question count...",
  ];

  const rotatePhrases = useCallback(() => {
    if (!aiAnalyzing) return;
    const idx = Math.floor(Math.random() * AI_PHRASES.length);
    setProcessingStatus(AI_PHRASES[idx]);
  }, [aiAnalyzing]);

  useEffect(() => {
    if (!aiAnalyzing) return;
    const interval = setInterval(rotatePhrases, 4000);
    return () => clearInterval(interval);
  }, [aiAnalyzing, rotatePhrases]);

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
    // Single batch call to analyze all pages at once
    setProcessingStatus("Reading through the exam paper...");
    setAiAnalyzing(true);

    let result;
    try {
      const batchRes = await fetch("/api/exam/analyze-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images }),
      });

      result = await batchRes.json();

      if (!batchRes.ok) {
        throw new Error(result.error || "Failed to analyze exam paper");
      }
    } finally {
      setAiAnalyzing(false);
    }

    // Set header info
    if (result.header) {
      setHeaderInfo(result.header);
    }

    // Track answer key pages with paper labels for redo
    const answerPages = result.pages
      .filter((p: { isAnswerSheet: boolean }) => p.isAnswerSheet)
      .map((p: { pageIndex: number; paperLabel?: string }) => ({
        pageIndex: p.pageIndex,
        paperLabel: p.paperLabel,
      }));
    setAnswerKeyPages(answerPages);

    // Crop questions from each page
    setProcessingStatus("Cropping questions...");
    const allQuestions: ExtractedQuestion[] = [];

    for (const page of result.pages) {
      if (page.isAnswerSheet) continue;

      for (const q of page.questions) {
        setProcessingStatus(`Cropping question ${q.questionNum}...`);

        const croppedImage = await cropQuestionFromPage(
          images[page.pageIndex],
          q.yStartPct,
          q.yEndPct
        );

        // Handle both text and image answers
        const rawEntry = result.answers?.[q.questionNum];
        let answer = "";
        let answerImageData = "";

        if (rawEntry) {
          const entry = normalizeAnswer(rawEntry);
          if (entry.type === "text") {
            answer = entry.value;
          } else if (entry.type === "image") {
            answer = entry.value || "";
            setProcessingStatus(`Cropping answer for Q${q.questionNum}...`);
            answerImageData = await cropQuestionFromPage(
              images[entry.answerPageIndex],
              entry.yStartPct,
              entry.yEndPct
            );
          }
        }

        allQuestions.push({
          questionNum: q.questionNum,
          imageData: croppedImage,
          answer,
          answerImageData,
          pageIndex: page.pageIndex,
          orderIndex: allQuestions.length,
          yStartPct: q.yStartPct,
          yEndPct: q.yEndPct,
          boundaryTop: q.boundaryTop || q.questionNum,
          boundaryBottom: q.boundaryBottom || "not found",
        });
      }
    }

    setQuestions(allQuestions);
    setStep("review");
  }

  function handleUpdateQuestion(
    index: number,
    field: "questionNum" | "answer" | "answerImageData",
    value: string
  ) {
    setQuestions((prev) =>
      prev.map((q, i) => (i === index ? { ...q, [field]: value } : q))
    );
  }

  function handleDeleteQuestion(index: number) {
    setQuestions((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleRedoQuestion(index: number) {
    const q = questions[index];
    if (!pageImages[q.pageIndex]) return;

    setRedoingIndices((prev) => new Set(prev).add(index));
    setError(null);

    try {
      const printedNum = q.questionNum.replace(/^(P\d+-|B\d+-)/, "");
      const samePageQuestions = questions
        .filter((other, i) => i !== index && other.pageIndex === q.pageIndex)
        .map((other) => other.questionNum.replace(/^(P\d+-|B\d+-)/, ""));

      const res = await fetch("/api/exam/redo-question", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: pageImages[q.pageIndex],
          questionNum: printedNum,
          surroundingQuestions: samePageQuestions,
        }),
      });

      if (!res.ok) throw new Error("Failed to re-extract question");

      const result = await res.json();
      const croppedImage = await cropQuestionFromPage(
        pageImages[q.pageIndex],
        result.yStartPct,
        result.yEndPct
      );

      setQuestions((prev) =>
        prev.map((existing, i) =>
          i === index ? { ...existing, imageData: croppedImage, yStartPct: result.yStartPct, yEndPct: result.yEndPct } : existing
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Redo failed");
    } finally {
      setRedoingIndices((prev) => {
        const next = new Set(prev);
        next.delete(index);
        return next;
      });
    }
  }

  async function handleRedoAnswer(index: number) {
    const q = questions[index];
    if (answerKeyPages.length === 0) return;

    setRedoingAnswerIndices((prev) => new Set(prev).add(index));
    setError(null);

    try {
      const printedNum = q.questionNum.replace(/^(P\d+-|B\d+-)/, "");

      // Determine which paper this question belongs to
      const prefixMatch = q.questionNum.match(/^(P\d+-|B\d+-)/);
      const paperPrefix = prefixMatch ? prefixMatch[1] : "";
      // Map prefix to paper label for filtering answer key pages
      let paperLabel: string | undefined;
      if (paperPrefix === "") {
        paperLabel = answerKeyPages[0]?.paperLabel; // default to first paper
      } else {
        // e.g. "P2-" → look for "Paper 2" pages; fall back to searching all
        const paperNum = paperPrefix.replace(/[^0-9]/g, "");
        paperLabel = `Paper ${paperNum}`;
      }

      // Filter answer key pages to the correct paper (fall back to all if no match)
      const relevantPages = paperLabel
        ? answerKeyPages.filter((p) => p.paperLabel === paperLabel)
        : answerKeyPages;
      const pagesToSearch = relevantPages.length > 0 ? relevantPages : answerKeyPages;

      // Try each relevant answer key page until we find the answer
      for (const page of pagesToSearch) {
        const res = await fetch("/api/exam/redo-answer", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image: pageImages[page.pageIndex],
            questionNum: printedNum,
            paperContext: paperLabel || "",
          }),
        });

        if (!res.ok) continue;

        const result = await res.json();

        if (result.type === "text" && result.value) {
          setQuestions((prev) =>
            prev.map((existing, i) =>
              i === index ? { ...existing, answer: result.value, answerImageData: "" } : existing
            )
          );
          return;
        } else if (result.type === "image" && result.yStartPct != null) {
          const answerImage = await cropQuestionFromPage(
            pageImages[page.pageIndex],
            result.yStartPct,
            result.yEndPct
          );
          setQuestions((prev) =>
            prev.map((existing, i) =>
              i === index ? { ...existing, answer: result.value || "", answerImageData: answerImage } : existing
            )
          );
          return;
        }
      }

      setError(`Could not find answer for Q${q.questionNum} on any answer key page`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Redo answer failed");
    } finally {
      setRedoingAnswerIndices((prev) => {
        const next = new Set(prev);
        next.delete(index);
        return next;
      });
    }
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
            onRedoQuestion={handleRedoQuestion}
            onRedoAnswer={answerKeyPages.length > 0 ? handleRedoAnswer : undefined}
            redoingIndices={redoingIndices}
            redoingAnswerIndices={redoingAnswerIndices}
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
