"use client";

import { Suspense, useState, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import WordReviewList from "@/components/WordReviewList";
import { ExtractedTest } from "@/types";

type Step = "capture" | "processing" | "review";

export default function ScanPage() {
  return (
    <Suspense>
      <ScanPageContent />
    </Suspense>
  );
}

function ScanPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>("capture");
  const [guidance, setGuidance] = useState("");
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
      setProcessingStep("Extracting spelling words...");
      const extractRes = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: dataUrl, guidance: guidance || undefined }),
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
            userId,
            words,
          }),
        });
      }

      router.push(userId ? `/home/${userId}?t=${Date.now()}` : "/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  // Hidden file inputs
  const uploadInput = (
    <input ref={fileInputRef} type="file" accept="image/*"
      onChange={handleFileSelect} className="hidden" />
  );
  const cameraInput = (
    <input ref={cameraInputRef} type="file" accept="image/*" capture="environment"
      onChange={handleFileSelect} className="hidden" />
  );

  return (
    <div className="min-h-screen bg-[#f8f9ff] font-body text-[#0b1c30] antialiased">
      {uploadInput}{cameraInput}

      {/* ── Processing ── */}
      {step === "processing" && (
        <div className="min-h-screen flex flex-col items-center justify-center gap-6 px-6">
          {imageData && <img src={imageData} alt="Processing" className="w-48 rounded-2xl opacity-60 border border-slate-100" />}
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-[#003366]/20 border-t-[#003366]" />
          <p className="text-lg font-headline font-bold text-[#001e40]">Processing…</p>
          <p className="text-sm text-[#43474f]">{processingStep}</p>
        </div>
      )}

      {/* ── Review ── */}
      {step === "review" && (
        <div className="p-6 max-w-lg mx-auto">
          <button onClick={() => setStep("capture")}
            className="flex items-center gap-2 text-[#43474f] mb-6 hover:text-[#001e40] transition-colors">
            <span className="material-symbols-outlined text-xl">arrow_back</span>
            <span className="text-sm font-medium">Back</span>
          </button>
          <h1 className="text-xl font-headline font-bold text-[#001e40] mb-2">Review Words</h1>
          <p className="text-sm text-[#43474f] mb-6">Uncheck any words you don&apos;t want to include.</p>
          <WordReviewList tests={tests} onToggleWord={handleToggleWord} onUpdateTitle={handleUpdateTitle} toggledOff={toggledOff} />
          {error && <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl px-4 py-3 mt-4">{error}</p>}
          <div className="mt-6 pb-6">
            <button onClick={handleSaveAll} disabled={saving}
              className="w-full bg-[#006c49] text-white rounded-2xl py-4 px-6 text-base font-bold shadow-md active:scale-[0.98] transition-transform disabled:opacity-50">
              {saving ? "Saving…" : "Save All Tests"}
            </button>
          </div>
        </div>
      )}

      {/* ── Capture ── */}
      {step === "capture" && (
        <div className="min-h-screen flex items-center justify-center p-6 bg-[#001e40]/10 backdrop-blur-sm">
          <div className="bg-white w-full max-w-2xl rounded-[2rem] shadow-[0_20px_60px_-15px_rgba(11,28,48,0.15)] overflow-hidden relative">

            {/* Close / back */}
            <button
              onClick={() => router.push(userId ? `/home/${userId}` : "/")}
              className="absolute top-6 right-6 p-2 rounded-full hover:bg-[#eff4ff] transition-colors text-[#43474f]">
              <span className="material-symbols-outlined">close</span>
            </button>

            {/* Content */}
            <div className="p-10 lg:p-12 text-center">

              {/* Header */}
              <div className="mb-10">
                <h2 className="text-3xl lg:text-4xl font-headline font-extrabold text-[#001e40] mb-4 tracking-tight">
                  Scan Spelling / 听写
                </h2>
                <p className="text-[#43474f] text-base lg:text-lg leading-relaxed max-w-md mx-auto">
                  Transform your handwritten notes into personalised practice tests instantly.
                </p>
              </div>

              {error && (
                <div className="mb-6 bg-red-50 border border-red-100 rounded-2xl px-5 py-4 text-sm text-red-700 text-left flex items-start gap-3">
                  <span className="material-symbols-outlined text-red-400 text-base mt-0.5">error</span>
                  <span>{error}</span>
                  <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-600"><span className="material-symbols-outlined text-base">close</span></button>
                </div>
              )}

              {/* Action buttons */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-10">
                <button onClick={() => cameraInputRef.current?.click()}
                  className="group flex flex-col items-center justify-center p-10 bg-[#001e40] rounded-[1.5rem] text-white hover:bg-[#003366] transition-all duration-300 hover:-translate-y-1 shadow-lg active:scale-95">
                  <div className="w-16 h-16 bg-white/10 rounded-full flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                    <span className="material-symbols-outlined text-4xl" style={{ fontVariationSettings: "'FILL' 1" }}>photo_camera</span>
                  </div>
                  <span className="text-xl font-bold tracking-tight">Take Photo</span>
                  <span className="text-white/60 text-sm mt-2 font-medium">Use your camera</span>
                </button>

                <button onClick={() => fileInputRef.current?.click()}
                  className="group flex flex-col items-center justify-center p-10 bg-[#eff4ff] border-2 border-transparent hover:border-[#a7c8ff] rounded-[1.5rem] text-[#001e40] transition-all duration-300 hover:-translate-y-1 active:scale-95">
                  <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center mb-6 shadow-sm group-hover:scale-110 transition-transform">
                    <span className="material-symbols-outlined text-4xl text-[#006c49]">upload_file</span>
                  </div>
                  <span className="text-xl font-bold tracking-tight">Upload Image</span>
                  <span className="text-[#43474f] text-sm mt-2 font-medium">JPG, PNG or PDF</span>
                </button>
              </div>

              {/* Guidance input */}
              <div className="mb-8 text-left">
                <label className="block text-xs font-bold text-[#43474f] uppercase tracking-widest px-1 mb-2">
                  Guidance <span className="font-normal normal-case text-[#737780]">(optional)</span>
                </label>
                <input type="text" value={guidance} onChange={(e) => setGuidance(e.target.value)}
                  placeholder="e.g. only underlined words"
                  className="w-full bg-[#eff4ff] border-none rounded-xl px-4 py-3 text-sm text-[#0b1c30] placeholder:text-[#737780] focus:ring-2 focus:ring-[#003366]/20 focus:outline-none transition-all" />
              </div>

              {/* Pro tip */}
              <div className="bg-[#e5eeff] rounded-2xl p-5 flex items-start gap-4 text-left">
                <span className="material-symbols-outlined text-[#003366] mt-0.5">lightbulb</span>
                <p className="text-sm text-[#43474f] leading-relaxed">
                  <strong className="text-[#001e40] font-semibold">Pro tip:</strong> Ensure your handwritten text is clearly visible and well-lit for the best scan accuracy. Our system works best with standard ruled paper.
                </p>
              </div>
            </div>

            {/* Gradient accent bar */}
            <div className="h-2 w-full bg-gradient-to-r from-[#001e40] via-[#006c49] to-[#a7c8ff]" />
          </div>
        </div>
      )}
    </div>
  );
}
