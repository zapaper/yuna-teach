"use client";

import { Suspense, useState, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function SolverPage() {
  return (
    <Suspense>
      <SolverContent />
    </Suspense>
  );
}

function SolverContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<"capture" | "solving" | "result">("capture");
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [topic, setTopic] = useState("");
  const [solution, setSolution] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creatingTest, setCreatingTest] = useState(false);
  const [noStudentLinked, setNoStudentLinked] = useState(false);
  const [sharing, setSharing] = useState(false);

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
            if (width > height) { height = (height / width) * maxDim; width = maxDim; }
            else { width = (width / height) * maxDim; height = maxDim; }
          }
          canvas.width = width;
          canvas.height = height;
          canvas.getContext("2d")!.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", 0.85));
        };
        img.onerror = reject;
        img.src = e.target?.result as string;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function handleFile(file: File) {
    setError(null);
    try {
      const dataUrl = await compressImage(file);
      setImageDataUrl(dataUrl);
      setStep("solving");

      const res = await fetch("/api/solver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: dataUrl }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to solve");
        setStep("capture");
        return;
      }
      setSubject(data.subject);
      setTopic(data.topic ?? "");
      setSolution(data.solution);
      setStep("result");
    } catch {
      setError("Something went wrong. Please try again.");
      setStep("capture");
    }
  }

  async function createFocusedTest() {
    setCreatingTest(true);
    setNoStudentLinked(false);
    try {
      // Get linked students for this parent
      const usersRes = await fetch("/api/users");
      const usersData = await usersRes.json();
      const usersList: { id: string; linkedStudents: { id: string }[] }[] = usersData.users ?? [];
      const currentUser = usersList.find((u) => u.id === userId) ?? null;
      const linkedStudents = currentUser?.linkedStudents ?? [];

      if (linkedStudents.length === 0) {
        setNoStudentLinked(true);
        setCreatingTest(false);
        return;
      }

      const res = await fetch("/api/focused-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentId: userId, subject, topic }),
      });
      const data = await res.json();
      if (res.ok && data.id) {
        router.push(`/home/${userId}`);
      } else {
        setError(data.error ?? "Could not create focused test");
      }
    } catch {
      setError("Failed to create focused test");
    } finally {
      setCreatingTest(false);
    }
  }

  async function handleShare() {
    if (!imageDataUrl || !solution) return;
    setSharing(true);
    try {
      // Fixed 9:16 canvas (1080×1920)
      const W = 1080;
      const H = 1920;
      const PADDING = 56;
      const LOGO_H = 130;
      const FONT = "system-ui, -apple-system, sans-serif";

      const img = new Image();
      img.src = imageDataUrl;
      await new Promise<void>(resolve => { img.onload = () => resolve(); });

      // Image takes up top 42% max, letterboxed with white bg
      const MAX_IMG_H = Math.round(H * 0.42);
      const imgAspect = img.naturalHeight / img.naturalWidth;
      const imgDrawW = W;
      const imgDrawH = Math.min(Math.round(W * imgAspect), MAX_IMG_H);
      const IMG_SECTION_H = imgDrawH;

      const solutionAreaH = H - IMG_SECTION_H - LOGO_H;

      // Helper: wrap text at given font size, returns lines
      function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number, fontSize: number): string[] {
        ctx.font = `${fontSize}px ${FONT}`;
        const result: string[] = [];
        for (const paragraph of text.split("\n")) {
          if (!paragraph.trim()) { result.push(""); continue; }
          const words = paragraph.split(" ");
          let line = "";
          for (const word of words) {
            const test = line ? `${line} ${word}` : word;
            if (ctx.measureText(test).width > maxW) {
              if (line) result.push(line);
              line = word;
            } else {
              line = test;
            }
          }
          if (line) result.push(line);
        }
        return result;
      }

      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d")!;

      // White background
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);

      // Question image (centred horizontally, top-aligned)
      ctx.drawImage(img, 0, 0, imgDrawW, imgDrawH);

      // Separator
      ctx.fillStyle = "#e2e8f0";
      ctx.fillRect(0, IMG_SECTION_H, W, 2);

      // Solution background gradient
      const grad = ctx.createLinearGradient(0, IMG_SECTION_H, 0, H - LOGO_H);
      grad.addColorStop(0, "#eff6ff");
      grad.addColorStop(1, "#dbeafe");
      ctx.fillStyle = grad;
      ctx.fillRect(0, IMG_SECTION_H + 2, W, solutionAreaH - 2);

      // "SOLUTION" label
      const LABEL_SIZE = 28;
      const LABEL_H = LABEL_SIZE + 16;
      ctx.fillStyle = "#6b7280";
      ctx.font = `bold ${LABEL_SIZE}px ${FONT}`;
      ctx.fillText("SOLUTION", PADDING, IMG_SECTION_H + LABEL_H);

      // Auto-size solution font to fit available height
      const textAreaH = solutionAreaH - LABEL_H - PADDING;
      let fontSize = 32;
      let lines: string[] = [];
      while (fontSize >= 18) {
        lines = wrapText(ctx, solution, W - PADDING * 2, fontSize);
        const lineH = Math.round(fontSize * 1.55);
        if (lines.length * lineH <= textAreaH) break;
        fontSize -= 1;
      }
      const LINE_H = Math.round(fontSize * 1.55);

      ctx.fillStyle = "#1e293b";
      ctx.font = `${fontSize}px ${FONT}`;
      const textStartY = IMG_SECTION_H + LABEL_H + 16;
      lines.forEach((line, i) => {
        ctx.fillText(line, PADDING, textStartY + i * LINE_H);
      });

      // Logo bar
      const logoY = H - LOGO_H;
      ctx.fillStyle = "#1d4ed8";
      ctx.fillRect(0, logoY, W, LOGO_H);
      ctx.fillStyle = "#ffffff";
      ctx.font = `bold 52px ${FONT}`;
      ctx.textAlign = "center";
      ctx.fillText("MarkForYou.com", W / 2, logoY + 58);
      ctx.font = `30px ${FONT}`;
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.fillText("AI-powered exam practice for Singapore students", W / 2, logoY + 100);
      ctx.textAlign = "left";

      canvas.toBlob(async (blob) => {
        if (!blob) return;
        const file = new File([blob], "markforyou-solution.png", { type: "image/png" });
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], title: "Check out this solution on MarkForYou.com" });
        } else {
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = "markforyou-solution.png";
          a.click();
          URL.revokeObjectURL(url);
        }
      }, "image/png");
    } finally {
      setSharing(false);
    }
  }

  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <div className="bg-white border-b border-slate-100 px-4 py-3 flex items-center gap-3">
        <button
          onClick={() => router.push(`/home/${userId}`)}
          className="p-1.5 -ml-1 rounded-lg text-slate-500 hover:text-slate-700 hover:bg-slate-100"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <h1 className="text-base font-semibold text-slate-800">AI Solver</h1>
      </div>

      <div className="p-4 max-w-lg mx-auto">
        {step === "capture" && (
          <div className="mt-8">
            <p className="text-sm text-slate-500 text-center mb-6">
              Take a photo or upload an image of a question and let AI solve it.
            </p>

            {error && (
              <div className="mb-4 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
            />

            <button
              onClick={() => { if (fileInputRef.current) { fileInputRef.current.removeAttribute("capture"); fileInputRef.current.click(); } }}
              className="w-full flex items-center justify-center gap-3 bg-primary-500 text-white rounded-2xl py-5 text-lg font-semibold shadow-lg active:scale-[0.98] transition-transform mb-4"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="12" cy="12" r="4" />
                <line x1="12" y1="2" x2="12" y2="4" />
              </svg>
              Upload Photo
            </button>

            <button
              onClick={() => { if (fileInputRef.current) { fileInputRef.current.setAttribute("capture", "environment"); fileInputRef.current.click(); } }}
              className="w-full flex items-center justify-center gap-3 border-2 border-primary-200 text-primary-600 rounded-2xl py-5 text-lg font-semibold active:scale-[0.98] transition-transform"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
              Take Photo
            </button>
          </div>
        )}

        {step === "solving" && (
          <div className="mt-16 flex flex-col items-center gap-4">
            {imageDataUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imageDataUrl} alt="Question" className="w-full max-h-64 object-contain rounded-xl border border-slate-100" />
            )}
            <div className="animate-spin rounded-full h-10 w-10 border-4 border-primary-200 border-t-primary-500 mt-4" />
            <p className="text-slate-500 text-sm">Solving question...</p>
          </div>
        )}

        {step === "result" && (
          <div className="mt-4 space-y-4">
            {/* Question image */}
            {imageDataUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={imageDataUrl} alt="Question" className="w-full rounded-xl border border-slate-100" />
            )}

            {/* Subject + topic tag */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`px-3 py-1 rounded-full text-xs font-semibold ${subject === "Science" ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700"}`}>
                {subject}
              </span>
              {topic && (
                <span className="px-3 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-600">
                  {topic}
                </span>
              )}
            </div>

            {/* Solution */}
            <div className="rounded-2xl bg-gradient-to-br from-primary-50 to-blue-50 border border-slate-100 p-4">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Solution</p>
              <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-line">{solution}</p>
            </div>

            {/* Share button */}
            <button
              onClick={handleShare}
              disabled={sharing}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {sharing ? (
                <span className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white inline-block" />
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>
                </svg>
              )}
              {sharing ? "Preparing..." : "Share Solution"}
            </button>

            {/* Focused test prompt */}
            {topic && (
              <div className="rounded-2xl border border-slate-200 p-4">
                <p className="text-sm text-slate-700 font-medium mb-3">
                  Create a focused test on <span className="text-primary-600 font-semibold">{topic}</span> for your child?
                </p>

                {noStudentLinked ? (
                  <p className="text-sm text-amber-600 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
                    Please link a student to your account first.
                  </p>
                ) : error ? (
                  <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{error}</p>
                ) : null}

                <div className="flex gap-3 mt-3">
                  <button
                    onClick={() => router.push(`/home/${userId}`)}
                    className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-600 text-sm font-medium hover:bg-slate-50 transition-colors"
                  >
                    No
                  </button>
                  <button
                    onClick={createFocusedTest}
                    disabled={creatingTest}
                    className="flex-1 py-2.5 rounded-xl bg-primary-500 text-white text-sm font-semibold hover:bg-primary-600 transition-colors disabled:opacity-50"
                  >
                    {creatingTest ? (
                      <span className="inline-flex items-center justify-center gap-2">
                        <span className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white inline-block" />
                        Creating...
                      </span>
                    ) : "Yes, Create Test"}
                  </button>
                </div>
              </div>
            )}

            {/* Try another */}
            <button
              onClick={() => { setStep("capture"); setImageDataUrl(null); setError(null); setNoStudentLinked(false); }}
              className="w-full py-3 rounded-xl border border-slate-200 text-slate-500 text-sm font-medium hover:bg-slate-50 transition-colors"
            >
              Solve another question
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
