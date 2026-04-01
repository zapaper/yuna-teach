"use client";

import { Suspense, useState, useRef, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { renderPdfToImages } from "@/lib/pdf";
import AdminNav from "@/components/AdminNav";

type Step = "upload" | "processing";

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
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [processingStatus, setProcessingStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [aiAnalyzing, setAiAnalyzing] = useState(false);

  const AI_PHRASES = [
    "Rendering PDF pages...",
    "Uploading to server...",
    "Starting extraction...",
    "Almost there...",
  ];

  const rotatePhrases = useCallback(() => {
    if (!aiAnalyzing) return;
    const idx = Math.floor(Math.random() * AI_PHRASES.length);
    setProcessingStatus(AI_PHRASES[idx]);
  }, [aiAnalyzing]);

  useEffect(() => {
    if (!aiAnalyzing) return;
    const interval = setInterval(rotatePhrases, 3000);
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
    setPdfFile(file);

    try {
      const images = await renderPdfToImages(file);
      await uploadAndExtract(images, file);
    } catch (err) {
      console.error("PDF processing error:", err);
      setError(err instanceof Error ? err.message : "Failed to process PDF");
      setStep("upload");
    }
  }

  async function uploadAndExtract(images: string[], file: File) {
    setProcessingStatus("Uploading to server...");
    setAiAnalyzing(true);

    try {
      const res = await fetch("/api/exam/extract-background", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images, userId }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to upload");
      }

      // Fire-and-forget PDF upload
      if (file) {
        const formData = new FormData();
        formData.append("pdf", file);
        fetch(`/api/exam/${data.id}/pdf`, {
          method: "POST",
          body: formData,
        }).catch((err) => console.warn("PDF upload failed:", err));
      }

      // Explicitly trigger extraction — the extract-background route may not have
      // fired it reliably for large payloads (network timeout before the call).
      await fetch(`/api/exam/${data.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retryExtraction: true }),
      }).catch((err) => console.warn("Extraction trigger failed:", err));

      // Redirect to home (with timestamp to force refetch)
      router.push(userId ? `/home/${userId}?t=${Date.now()}` : "/");
    } finally {
      setAiAnalyzing(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {userId && <AdminNav userId={userId} />}
      <div className="lg:ml-56 pb-24 lg:pb-0">
      <div className="bg-white border-b border-slate-200 px-4 py-3">
        <h1 className="text-lg font-bold text-slate-800">Upload Exam Paper</h1>
        <p className="text-xs text-slate-400">Upload a PDF with questions and answer key</p>
      </div>
      <div className="p-6">

      {step === "upload" && (
        <div>
          <div
            onClick={() => fileInputRef.current?.click()}
            className="border-2 border-dashed border-slate-300 rounded-2xl p-12 text-center cursor-pointer hover:border-primary-400 hover:bg-primary-50/50 transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="48"
              height="48"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="mx-auto mb-4 text-slate-400"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <p className="text-slate-600 font-medium mb-1">
              Tap to select PDF
            </p>
            <p className="text-slate-400 text-sm">
              Exam paper with answer key
            </p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            onChange={handleFileSelect}
            className="hidden"
          />
          {error && (
            <p className="mt-4 text-red-500 text-sm text-center">
              {error}
            </p>
          )}
        </div>
      )}

      {step === "processing" && (
        <div className="flex flex-col items-center justify-center py-24">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary-200 border-t-primary-500 mb-4" />
          <p className="text-slate-600 font-medium">{processingStatus}</p>
          <p className="text-slate-400 text-sm mt-2">
            Uploading your paper...
          </p>
        </div>
      )}
      </div>
      </div>
    </div>
  );
}
