"use client";

import { Suspense, useState, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";

interface DiagramRow { label: string; units: number; value: string | null; }
interface DiagramStep { title: string | null; rows: DiagramRow[]; unitValue: string | null; }

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
  const [diagrams, setDiagrams] = useState<DiagramStep[]>([]);
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
      setDiagrams(data.diagrams ?? []);
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
      const W = 1080;
      const H = 1920;
      const PADDING = 56;
      const LOGO_H = 130;
      const FONT = "system-ui, -apple-system, sans-serif";

      const img = new Image();
      img.src = imageDataUrl;
      await new Promise<void>(resolve => { img.onload = () => resolve(); });

      const MAX_IMG_H = Math.round(H * 0.42);
      const imgAspect = img.naturalHeight / img.naturalWidth;
      const imgDrawH = Math.min(Math.round(W * imgAspect), MAX_IMG_H);

      // Diagram section height
      const D_ROW_H = 76;
      const D_ROW_GAP = 18;
      const D_SECTION_LABEL_H = 56;
      const D_STEP_TITLE_H = 36;
      const D_STEP_GAP = 24;
      const stepH = (step: DiagramStep) =>
        (step.title ? D_STEP_TITLE_H : 0) + step.rows.length * (D_ROW_H + D_ROW_GAP) - D_ROW_GAP + (step.unitValue ? 56 : 24);
      const diagramH = diagrams.length > 0
        ? D_SECTION_LABEL_H + diagrams.reduce((s, d, i) => s + stepH(d) + (i < diagrams.length - 1 ? D_STEP_GAP : 0), 0) + 16
        : 0;

      const solutionAreaH = H - imgDrawH - 2 - diagramH - (diagramH > 0 ? 2 : 0) - LOGO_H;

      function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number, fontSize: number): string[] {
        ctx.font = `${fontSize}px ${FONT}`;
        const result: string[] = [];
        for (const paragraph of text.split("\n")) {
          if (!paragraph.trim()) { result.push(""); continue; }
          const words = paragraph.split(" ");
          let line = "";
          for (const word of words) {
            const test = line ? `${line} ${word}` : word;
            if (ctx.measureText(test).width > maxW) { if (line) result.push(line); line = word; }
            else { line = test; }
          }
          if (line) result.push(line);
        }
        return result;
      }

      function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
        ctx.beginPath();
        ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
      }

      const canvas = document.createElement("canvas");
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext("2d")!;

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);

      // Question image
      ctx.drawImage(img, 0, 0, W, imgDrawH);
      ctx.fillStyle = "#e2e8f0";
      ctx.fillRect(0, imgDrawH, W, 2);

      let curY = imgDrawH + 2;

      // Bar model diagrams
      if (diagrams.length > 0) {
        const D_LABEL_W = 240;
        const D_BAR_W = W - PADDING * 2 - D_LABEL_W - 160;
        const D_VALUE_X = PADDING + D_LABEL_W + D_BAR_W + 14;
        const D_COLORS = [
          { fill: "#dbeafe", stroke: "#60a5fa", text: "#1d4ed8" },
          { fill: "#ede9fe", stroke: "#a78bfa", text: "#6d28d9" },
          { fill: "#d1fae5", stroke: "#34d399", text: "#065f46" },
          { fill: "#fef3c7", stroke: "#fbbf24", text: "#92400e" },
          { fill: "#fce7f3", stroke: "#f472b6", text: "#9d174d" },
        ];

        ctx.fillStyle = "#6b7280";
        ctx.font = `bold 28px ${FONT}`;
        ctx.textAlign = "left";
        ctx.fillText("MODEL DIAGRAM", PADDING, curY + 40);
        curY += D_SECTION_LABEL_H;

        for (let si = 0; si < diagrams.length; si++) {
          const step = diagrams[si];
          const maxUnits = Math.max(...step.rows.map(r => r.units), 1);
          const unitW = D_BAR_W / maxUnits;

          // Step title
          if (step.title) {
            ctx.fillStyle = "#2563eb";
            ctx.font = `bold 26px ${FONT}`;
            ctx.textAlign = "left";
            ctx.fillText(step.title, PADDING, curY + 26);
            curY += D_STEP_TITLE_H;
          }

          for (let i = 0; i < step.rows.length; i++) {
            const row = step.rows[i];
            const col = D_COLORS[i % D_COLORS.length];
            const barX = PADDING + D_LABEL_W;
            const rowY = curY + i * (D_ROW_H + D_ROW_GAP);

            ctx.fillStyle = "#475569";
            ctx.font = `500 28px ${FONT}`;
            ctx.textAlign = "right";
            ctx.fillText(row.label, PADDING + D_LABEL_W - 12, rowY + D_ROW_H / 2 + 10);

            ctx.fillStyle = "#f1f5f9";
            roundRect(ctx, barX, rowY, D_BAR_W, D_ROW_H, 8);
            ctx.fill();
            ctx.strokeStyle = "#e2e8f0"; ctx.lineWidth = 2; ctx.stroke();

            ctx.fillStyle = col.fill;
            roundRect(ctx, barX, rowY, row.units * unitW, D_ROW_H, 8);
            ctx.fill();
            ctx.strokeStyle = col.stroke; ctx.lineWidth = 3; ctx.stroke();

            ctx.strokeStyle = col.stroke; ctx.lineWidth = 2; ctx.globalAlpha = 0.6;
            for (let j = 1; j < row.units; j++) {
              ctx.beginPath();
              ctx.moveTo(barX + j * unitW, rowY + 10);
              ctx.lineTo(barX + j * unitW, rowY + D_ROW_H - 10);
              ctx.stroke();
            }
            ctx.globalAlpha = 1;

            if (row.value) {
              ctx.fillStyle = col.text;
              ctx.font = `bold 28px ${FONT}`;
              ctx.textAlign = "left";
              ctx.fillText(row.value, D_VALUE_X, rowY + D_ROW_H / 2 + 10);
            }
          }

          curY += step.rows.length * (D_ROW_H + D_ROW_GAP) - D_ROW_GAP;

          if (step.unitValue) {
            curY += 40;
            ctx.fillStyle = "#64748b";
            ctx.font = `24px ${FONT}`;
            ctx.textAlign = "left";
            ctx.fillText(`1 unit = ${step.unitValue}`, PADDING + D_LABEL_W, curY);
            curY += 16;
          } else {
            curY += 24;
          }

          // Divider between steps
          if (si < diagrams.length - 1) {
            ctx.fillStyle = "#e2e8f0";
            ctx.fillRect(PADDING, curY, W - PADDING * 2, 1);
            curY += D_STEP_GAP;
          }
        }

        curY += 16;
        ctx.fillStyle = "#e2e8f0";
        ctx.fillRect(0, curY, W, 2);
        curY += 2;
      }

      // Solution gradient
      const grad = ctx.createLinearGradient(0, curY, 0, H - LOGO_H);
      grad.addColorStop(0, "#eff6ff"); grad.addColorStop(1, "#dbeafe");
      ctx.fillStyle = grad;
      ctx.fillRect(0, curY, W, H - LOGO_H - curY);

      const LABEL_SIZE = 28;
      const LABEL_H = LABEL_SIZE + 16;
      ctx.fillStyle = "#6b7280";
      ctx.font = `bold ${LABEL_SIZE}px ${FONT}`;
      ctx.textAlign = "left";
      ctx.fillText("SOLUTION", PADDING, curY + LABEL_H);

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
      const textStartY = curY + LABEL_H + 16;
      lines.forEach((line, i) => { ctx.fillText(line, PADDING, textStartY + i * LINE_H); });

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
      ctx.fillText("Practice more with similar questions", W / 2, logoY + 100);

      canvas.toBlob(async (blob) => {
        if (!blob) return;
        const file = new File([blob], "markforyou-solution.png", { type: "image/png" });
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], title: "Check out this solution on MarkForYou.com" });
        } else {
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url; a.download = "markforyou-solution.png"; a.click();
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

            {/* Bar model diagrams */}
            {diagrams.length > 0 && (
              <div className="rounded-2xl bg-white border border-slate-100 p-4 space-y-4">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Model Diagram</p>
                {diagrams.map((step, i) => (
                  <div key={i}>
                    {step.title && (
                      <p className="text-xs font-semibold text-primary-600 mb-2">{step.title}</p>
                    )}
                    <BarModel diagram={step} />
                    {i < diagrams.length - 1 && <div className="border-t border-slate-100 mt-4" />}
                  </div>
                ))}
              </div>
            )}

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
              onClick={() => { setStep("capture"); setImageDataUrl(null); setError(null); setNoStudentLinked(false); setDiagrams([]); }}
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

// ─── Bar model diagram (Singapore model method) ──────────────────────────────

function splitLabel(label: string): [string, string | null] {
  // ~10 chars fits comfortably in LABEL_W at fontSize 12; split longer labels
  if (label.length <= 11) return [label, null];
  const mid = Math.ceil(label.length / 2);
  const spaceIdx = label.lastIndexOf(" ", mid + 4);
  if (spaceIdx > 0) return [label.slice(0, spaceIdx), label.slice(spaceIdx + 1)];
  return [label.slice(0, 11), label.slice(11)];
}

function BarModel({ diagram }: { diagram: DiagramStep }) {
  const ROW_H = 44;
  const ROW_GAP = 10;
  const LABEL_W = 100;
  const BAR_AREA_W = 190;
  const VALUE_W = 62;
  const PAD_X = 8;
  const PAD_Y = 8;
  const TOTAL_W = PAD_X + LABEL_W + BAR_AREA_W + VALUE_W + PAD_X;

  const maxUnits = Math.max(...diagram.rows.map((r) => r.units), 1);
  const unitW = BAR_AREA_W / maxUnits;

  const FOOTER_H = diagram.unitValue ? 26 : 0;
  const totalH = PAD_Y + diagram.rows.length * (ROW_H + ROW_GAP) - ROW_GAP + FOOTER_H + PAD_Y;

  const COLORS = [
    { fill: "#dbeafe", stroke: "#60a5fa", text: "#1d4ed8" },
    { fill: "#ede9fe", stroke: "#a78bfa", text: "#6d28d9" },
    { fill: "#d1fae5", stroke: "#34d399", text: "#065f46" },
    { fill: "#fef3c7", stroke: "#fbbf24", text: "#92400e" },
    { fill: "#fce7f3", stroke: "#f472b6", text: "#9d174d" },
  ];

  return (
    <svg viewBox={`0 0 ${TOTAL_W} ${totalH}`} width="100%" style={{ display: "block", maxWidth: TOTAL_W }}>
      {diagram.rows.map((row, i) => {
        const y = PAD_Y + i * (ROW_H + ROW_GAP);
        const barX = PAD_X + LABEL_W;
        const barW = row.units * unitW;
        const col = COLORS[i % COLORS.length];
        const [line1, line2] = splitLabel(row.label);
        const labelX = PAD_X + LABEL_W - 6;

        return (
          <g key={i}>
            {line2 ? (
              <text x={labelX} textAnchor="end"
                fontSize="11" fontFamily="system-ui,sans-serif" fontWeight="500" fill="#475569">
                <tspan x={labelX} y={y + ROW_H / 2 - 3}>{line1}</tspan>
                <tspan x={labelX} dy="14">{line2}</tspan>
              </text>
            ) : (
              <text x={labelX} y={y + ROW_H / 2 + 4} textAnchor="end"
                fontSize="12" fontFamily="system-ui,sans-serif" fontWeight="500" fill="#475569">
                {line1}
              </text>
            )}
            <rect x={barX} y={y} width={BAR_AREA_W} height={ROW_H} rx={4}
              fill="#f1f5f9" stroke="#e2e8f0" strokeWidth={1} />
            <rect x={barX} y={y} width={barW} height={ROW_H} rx={4}
              fill={col.fill} stroke={col.stroke} strokeWidth={1.5} />
            {Array.from({ length: row.units - 1 }, (_, j) => (
              <line key={j}
                x1={barX + (j + 1) * unitW} y1={y + 6}
                x2={barX + (j + 1) * unitW} y2={y + ROW_H - 6}
                stroke={col.stroke} strokeWidth={1} opacity={0.6} />
            ))}
            {row.value && (
              <text x={barX + BAR_AREA_W + 6} y={y + ROW_H / 2 + 4}
                fontSize="13" fontFamily="system-ui,sans-serif" fontWeight="700" fill={col.text}>
                {row.value}
              </text>
            )}
          </g>
        );
      })}
      {diagram.unitValue && (
        <text x={PAD_X + LABEL_W} y={PAD_Y + diagram.rows.length * (ROW_H + ROW_GAP) - ROW_GAP + 20}
          fontSize="11" fontFamily="system-ui,sans-serif" fill="#64748b">
          1 unit = {diagram.unitValue}
        </text>
      )}
    </svg>
  );
}
