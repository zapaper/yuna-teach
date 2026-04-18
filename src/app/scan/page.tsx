"use client";

import { Suspense, useState, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
  const [processingStep, setProcessingStep] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newWordText, setNewWordText] = useState("");
  const [addingToTest, setAddingToTest] = useState<number | null>(null);

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

  function handleDeleteWord(testIdx: number, wordIdx: number) {
    setTests((prev) =>
      prev.map((t, i) =>
        i === testIdx
          ? { ...t, words: t.words.filter((_, wi) => wi !== wordIdx) }
          : t
      )
    );
  }

  function handleAddWord(testIdx: number) {
    const text = newWordText.trim();
    if (!text) return;
    setTests((prev) =>
      prev.map((t, i) =>
        i === testIdx
          ? { ...t, words: [...t.words, { text, orderIndex: t.words.length + 1 }] }
          : t
      )
    );
    setNewWordText("");
    setAddingToTest(null);
  }

  function handleUpdateTitle(testIndex: number, title: string) {
    setTests((prev) =>
      prev.map((t, i) => (i === testIndex ? { ...t, title } : t))
    );
  }

  async function handleSaveAll() {
    setSaving(true);
    try {
      const savedIds: string[] = [];
      for (let testIdx = 0; testIdx < tests.length; testIdx++) {
        const test = tests[testIdx];
        const words = test.words.map((w, idx) => ({
          text: w.text,
          orderIndex: idx + 1,
          enabled: true,
        }));

        if (words.length === 0) continue;

        const res = await fetch("/api/tests", {
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
        if (res.ok) {
          const data = await res.json();
          if (data.id) savedIds.push(data.id);
        } else {
          const errData = await res.json().catch(() => ({}));
          console.error(`[scan] Save test ${testIdx} failed:`, res.status, errData);
          setError(errData.error ?? `Save failed (HTTP ${res.status})`);
        }
      }

      // Navigate to the first created spelling test
      if (savedIds.length > 0) {
        const firstTestUrl = `/test/${savedIds[0]}${userId ? `?userId=${userId}` : ""}`;
        if (savedIds.length > 1) {
          alert(`${savedIds.length} spelling lists created. Opening the first one.`);
        }
        router.push(firstTestUrl);
      } else {
        router.push(userId ? `/spelling?userId=${userId}` : "/");
      }
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
        <div className="min-h-screen">
          {/* Mobile sticky top bar */}
          <div className="lg:hidden sticky top-0 z-10 bg-[#eff4ff] px-4 py-3 flex items-center gap-3 border-b border-[#d3e4fe]">
            <button
              onClick={() => setStep("capture")}
              className="p-2 -ml-2 rounded-full hover:bg-[#d3e4fe] transition-colors"
            >
              <span className="material-symbols-outlined text-[#001e40]">arrow_back</span>
            </button>
            <span className="font-headline font-bold text-[#001e40] text-lg">Verification</span>
          </div>

          <div className="max-w-4xl mx-auto px-4 lg:px-8 py-6 lg:py-10 pb-40 lg:pb-8">
            {/* Desktop back button */}
            <button
              onClick={() => setStep("capture")}
              className="hidden lg:flex items-center gap-2 text-[#43474f] mb-6 hover:text-[#001e40] transition-colors"
            >
              <span className="material-symbols-outlined text-xl">arrow_back</span>
              <span className="text-sm font-medium">Back</span>
            </button>

            {tests.map((test, testIdx) => (
              <div key={testIdx} className={testIdx > 0 ? "mt-10" : ""}>
                {/* Section header */}
                <div className="mb-6">
                  <div className="flex items-center gap-3 mb-3">
                    <span className="inline-flex items-center gap-1.5 bg-[#006c49]/10 text-[#006c49] text-xs font-bold px-3 py-1.5 rounded-full">
                      <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                      AI Scan Complete
                    </span>
                    <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                      test.language === "CHINESE"
                        ? "bg-red-100 text-red-700"
                        : test.language === "JAPANESE"
                        ? "bg-pink-100 text-pink-700"
                        : "bg-blue-100 text-blue-700"
                    }`}>
                      {test.language === "CHINESE" ? "中文" : test.language === "JAPANESE" ? "日本語" : "English"}
                    </span>
                  </div>
                  <input
                    type="text"
                    value={test.title}
                    onChange={(e) => handleUpdateTitle(testIdx, e.target.value)}
                    className="w-full text-2xl lg:text-3xl font-headline font-extrabold text-[#001e40] bg-transparent border-none outline-none tracking-tight"
                  />
                  <p className="text-sm text-[#43474f] mt-1">
                    Tap the delete icon to remove a word, or add any missing ones.
                  </p>
                </div>

                {/* Word cards grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 lg:gap-4">
                  {test.words.map((word, wordIdx) => (
                    <div
                      key={wordIdx}
                      className="group bg-white rounded-2xl border border-[#e8eaf0] px-5 py-4 flex items-center justify-between hover:border-[#a7c8ff] hover:shadow-md transition-all"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-sm font-bold text-[#001e40]/20 group-hover:text-[#001e40]/60 transition-colors w-7 shrink-0 tabular-nums">
                          {String(wordIdx + 1).padStart(2, "0")}
                        </span>
                        <span className="font-headline font-bold text-xl text-[#001e40] truncate">
                          {word.text}
                        </span>
                      </div>
                      <button
                        onClick={() => handleDeleteWord(testIdx, wordIdx)}
                        className="shrink-0 ml-2 w-8 h-8 rounded-full flex items-center justify-center text-slate-300 hover:bg-red-50 hover:text-red-500 active:text-red-600 transition-all"
                        aria-label="Delete word"
                      >
                        <span className="material-symbols-outlined text-lg">close</span>
                      </button>
                    </div>
                  ))}

                  {/* Add word — inline input card */}
                  {addingToTest === testIdx ? (
                    <div className="bg-white rounded-2xl border-2 border-[#003366] px-5 py-4 flex items-center gap-3">
                      <span className="text-sm font-bold text-[#001e40]/40 w-7 shrink-0 tabular-nums">
                        {String(test.words.length + 1).padStart(2, "0")}
                      </span>
                      <input
                        autoFocus
                        type="text"
                        value={newWordText}
                        onChange={(e) => setNewWordText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleAddWord(testIdx);
                          if (e.key === "Escape") { setAddingToTest(null); setNewWordText(""); }
                        }}
                        placeholder="Type word…"
                        className="flex-1 font-headline font-bold text-xl text-[#001e40] bg-transparent outline-none placeholder:text-[#737780] placeholder:font-normal placeholder:text-base"
                      />
                      <button
                        onClick={() => handleAddWord(testIdx)}
                        className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-[#006c49] hover:bg-[#006c49]/10 transition-colors"
                      >
                        <span className="material-symbols-outlined text-lg">check</span>
                      </button>
                    </div>
                  ) : (
                    /* Desktop dashed add card — hidden on mobile (mobile uses fixed bottom sheet) */
                    <button
                      onClick={() => setAddingToTest(testIdx)}
                      className="hidden lg:flex bg-white rounded-2xl border-2 border-dashed border-[#d0d5e0] px-5 py-4 items-center gap-3 text-[#43474f] hover:border-[#003366] hover:text-[#001e40] hover:bg-[#eff4ff] transition-all"
                    >
                      <span className="material-symbols-outlined text-xl">add_circle</span>
                      <span className="font-medium text-sm">Add Word</span>
                    </button>
                  )}

                  {/* Mobile — dashed add placeholder card (always visible in list) */}
                  {addingToTest !== testIdx && (
                    <button
                      onClick={() => setAddingToTest(testIdx)}
                      className="lg:hidden bg-white rounded-2xl border-2 border-dashed border-[#d0d5e0] px-5 py-4 flex items-center gap-3 text-[#43474f] active:bg-[#eff4ff] transition-all"
                    >
                      <span className="material-symbols-outlined text-xl">add_circle</span>
                      <span className="font-medium text-sm">Add word…</span>
                    </button>
                  )}
                </div>
              </div>
            ))}

            {error && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-xl px-4 py-3 mt-6">
                {error}
              </p>
            )}

            {/* Desktop footer */}
            <div className="hidden lg:flex items-center justify-between mt-8 pt-6 border-t border-[#e8eaf0]">
              <button
                onClick={() => setAddingToTest(0)}
                className="flex items-center gap-2 px-6 py-3 rounded-2xl border-2 border-[#003366] text-[#001e40] font-bold hover:bg-[#eff4ff] transition-colors"
              >
                <span className="material-symbols-outlined">add</span>
                Add Word
              </button>
              <button
                onClick={handleSaveAll}
                disabled={saving}
                className="px-8 py-3 rounded-2xl bg-gradient-to-r from-[#001e40] to-[#006c49] text-white font-bold shadow-lg hover:shadow-xl active:scale-[0.98] transition-all disabled:opacity-50"
              >
                {saving ? "Saving…" : "Finalize List"}
              </button>
            </div>
          </div>

          {/* Mobile fixed bottom action sheet */}
          <div className="lg:hidden fixed bottom-0 left-0 right-0 z-20 bg-white/95 backdrop-blur-sm border-t border-[#e8eaf0] px-4 pt-3 pb-6 safe-area-bottom">
            <div className="grid grid-cols-2 gap-3 max-w-lg mx-auto">
              <button
                onClick={() => setAddingToTest(0)}
                className="flex items-center justify-center gap-2 px-4 py-3.5 rounded-2xl border-2 border-[#003366] text-[#001e40] font-bold hover:bg-[#eff4ff] active:bg-[#d3e4fe] transition-colors"
              >
                <span className="material-symbols-outlined text-lg">add</span>
                Add Word
              </button>
              <button
                onClick={handleSaveAll}
                disabled={saving}
                className="px-4 py-3.5 rounded-2xl bg-gradient-to-r from-[#001e40] to-[#006c49] text-white font-bold shadow-md active:scale-[0.98] transition-all disabled:opacity-50"
              >
                {saving ? "Saving…" : "Finalize List"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Capture ── */}
      {step === "capture" && (
        <div className="min-h-screen flex items-center justify-center p-6 bg-[#001e40]/10 backdrop-blur-sm">
          <div className="bg-white w-full max-w-2xl rounded-[2rem] shadow-[0_20px_60px_-15px_rgba(11,28,48,0.15)] overflow-hidden relative">

            {/* Close / back */}
            <button
              onClick={() => router.push(userId ? `/spelling?userId=${userId}` : "/")}
              className="absolute top-6 right-6 p-2 rounded-full hover:bg-[#eff4ff] transition-colors text-[#43474f]">
              <span className="material-symbols-outlined">close</span>
            </button>

            {/* Content */}
            <div className="pt-14 pb-10 px-10 lg:px-12 text-center">

              {/* Header */}
              <div className="mb-10">
                <h2 className="text-2xl lg:text-3xl font-headline font-extrabold text-[#001e40] mb-4 tracking-tight">
                  Scan Spelling / 听写
                </h2>
                <p className="text-[#43474f] text-base lg:text-lg leading-relaxed max-w-md mx-auto">
                  Transform your spelling list into personalised test instantly.
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
