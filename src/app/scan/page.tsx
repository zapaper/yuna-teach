"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import WordReviewList from "@/components/WordReviewList";
import { ExtractedTest } from "@/types";

type Step = "capture" | "processing" | "review";

export default function ScanPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>("capture");
  const [imageData, setImageData] = useState<string | null>(null);
  const [tests, setTests] = useState<ExtractedTest[]>([]);
  const [toggledOff, setToggledOff] = useState<Set<string>>(new Set());
  const [processingStep, setProcessingStep] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function compressImage(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          const maxDim = 2048;
          let { width, height } = img;

          if (width > maxDim || height > maxDim) {
            if (width > height) {
              height = (height / width) * maxDim;
              width = maxDim;
            } else {
              width = (width / height) * maxDim;
              height = maxDim;
            }
          }

          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", 0.85));
        };
        img.onerror = reject;
        img.src = e.target?.result as string;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setError(null);

    try {
      const compressed = await compressImage(file);
      setImageData(compressed);
      await processImage(compressed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to process image");
      setStep("capture");
    }
  }

  async function processImage(dataUrl: string) {
    setStep("processing");

    try {
      // Step 1: OCR
      setProcessingStep("Reading text from image...");
      const ocrRes = await fetch("/api/ocr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: dataUrl }),
      });

      if (!ocrRes.ok) {
        const err = await ocrRes.json();
        throw new Error(err.error || "OCR failed");
      }

      const { text } = await ocrRes.json();

      // Step 2: Extract words
      setProcessingStep("Extracting spelling words...");
      const extractRes = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ocrText: text }),
      });

      if (!extractRes.ok) {
        const err = await extractRes.json();
        throw new Error(err.error || "Extraction failed");
      }

      const result = await extractRes.json();
      setTests(result.tests);
      setStep("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Processing failed");
      setStep("capture");
    }
  }

  function handleToggleWord(testIndex: number, wordIndex: number) {
    const key = `${testIndex}-${wordIndex}`;
    setToggledOff((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function handleUpdateTitle(testIndex: number, title: string) {
    setTests((prev) =>
      prev.map((t, i) => (i === testIndex ? { ...t, title } : t))
    );
  }

  async function handleSaveAll() {
    setSaving(true);
    try {
      for (let testIdx = 0; testIdx < tests.length; testIdx++) {
        const test = tests[testIdx];
        const words = test.words
          .filter((_, wordIdx) => !toggledOff.has(`${testIdx}-${wordIdx}`))
          .map((w) => ({
            text: w.text,
            orderIndex: w.orderIndex,
            enabled: true,
          }));

        if (words.length === 0) continue;

        await fetch("/api/tests", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: test.title,
            subtitle: test.subtitle,
            language: test.language,
            imageData: imageData,
            words,
          }),
        });
      }

      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="p-6">
      {/* Back button */}
      <button
        onClick={() => (step === "capture" ? router.push("/") : setStep("capture"))}
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

      {/* Step 1: Capture */}
      {step === "capture" && (
        <div>
          <h1 className="text-xl font-bold text-slate-800 mb-6">
            Scan Spelling Test
          </h1>

          {/* File/Camera input */}
          <div className="space-y-4">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-full bg-primary-500 text-white rounded-2xl py-4 px-6 text-lg font-semibold shadow-md active:scale-[0.98] transition-transform"
            >
              Take Photo or Choose Image
            </button>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleFileSelect}
              className="hidden"
            />

            {/* Alternative: drag and drop area */}
            <div
              className="border-2 border-dashed border-slate-200 rounded-2xl p-8 text-center cursor-pointer hover:border-primary-300 hover:bg-primary-50/50 transition-colors"
              onClick={() => fileInputRef.current?.click()}
            >
              <div className="text-3xl mb-2">📷</div>
              <p className="text-slate-500 text-sm">
                Tap to take a photo or select from gallery
              </p>
              <p className="text-slate-400 text-xs mt-1">
                Supports JPG, PNG, WEBP
              </p>
            </div>
          </div>

          {/* Preview of captured image */}
          {imageData && (
            <div className="mt-4">
              <img
                src={imageData}
                alt="Captured"
                className="w-full rounded-xl border border-slate-200"
              />
            </div>
          )}
        </div>
      )}

      {/* Step 2: Processing */}
      {step === "processing" && (
        <div className="flex flex-col items-center py-16">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary-200 border-t-primary-500 mb-6" />
          <p className="text-lg font-medium text-slate-700">Processing...</p>
          <p className="text-sm text-slate-500 mt-2">{processingStep}</p>

          {imageData && (
            <img
              src={imageData}
              alt="Processing"
              className="w-48 rounded-xl mt-6 opacity-60"
            />
          )}
        </div>
      )}

      {/* Step 3: Review */}
      {step === "review" && (
        <div>
          <h1 className="text-xl font-bold text-slate-800 mb-2">
            Review Words
          </h1>
          <p className="text-sm text-slate-500 mb-6">
            Uncheck any words you don&apos;t want to include.
          </p>

          <WordReviewList
            tests={tests}
            onToggleWord={handleToggleWord}
            onUpdateTitle={handleUpdateTitle}
            toggledOff={toggledOff}
          />

          <div className="mt-6 pb-6">
            <button
              onClick={handleSaveAll}
              disabled={saving}
              className="w-full bg-accent-green text-white rounded-2xl py-4 px-6 text-lg font-semibold shadow-md active:scale-[0.98] transition-transform disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? "Saving..." : "Save All Tests"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
