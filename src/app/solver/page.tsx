"use client";

import { Suspense, useState, useRef, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import FormattedText from "@/components/FormattedText";

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

  const [step, setStep] = useState<"capture" | "solving" | "result">("capture");
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [topic, setTopic] = useState("");
  const [solution, setSolution] = useState("");
  const [diagrams, setDiagrams] = useState<DiagramStep[]>([]);
  const [hint, setHint] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creatingTest, setCreatingTest] = useState(false);
  const [noStudentLinked, setNoStudentLinked] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [linkedStudent, setLinkedStudent] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    if (!userId) return;
    fetch("/api/users").then(r => r.json()).then(data => {
      const me = (data.users ?? []).find((u: { id: string; linkedStudents: { id: string; name: string }[] }) => u.id === userId);
      const first = me?.linkedStudents?.[0] ?? null;
      setLinkedStudent(first);
      setNoStudentLinked(!first);
    }).catch(() => {});
  }, [userId]);

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
        body: JSON.stringify({ imageBase64: dataUrl, hint: hint.trim() || undefined }),
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
    if (!linkedStudent) { setNoStudentLinked(true); return; }
    setCreatingTest(true);
    try {
      const res = await fetch("/api/focused-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentId: userId, studentId: linkedStudent.id, subject, topic }),
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
      const PADDING = 56;
      const LOGO_H = 80;
      const FONT = "system-ui, -apple-system, sans-serif";
      const MIN_FONT = 18;
      const LABEL_SIZE = 28;
      const LABEL_H = LABEL_SIZE + 16;

      const img = new Image();
      img.src = imageDataUrl;
      await new Promise<void>(resolve => { img.onload = () => resolve(); });

      const imgAspect = img.naturalHeight / img.naturalWidth;
      const imgDrawH = Math.min(Math.round(W * imgAspect), Math.round(1920 * 0.42));

      // Diagram drawing constants
      const D_ROW_H = 60;
      const D_ROW_GAP = 12;
      const D_SECTION_LABEL_H = 48;
      const D_STEP_TITLE_H = 30;
      const D_STEP_GAP = 20;

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

      function splitCanvasLabel(label: string): [string, string | null] {
        if (label.length <= 11) return [label, null];
        const mid = Math.ceil(label.length / 2);
        const spaceIdx = label.lastIndexOf(" ", mid + 4);
        if (spaceIdx > 0) return [label.slice(0, spaceIdx), label.slice(spaceIdx + 1)];
        return [label.slice(0, 11), label.slice(11)];
      }

      function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
        ctx.beginPath();
        ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
      }

      // Compute dynamic canvas height so content never clips
      const measureCanvas = document.createElement("canvas");
      measureCanvas.width = W;
      const mCtx = measureCanvas.getContext("2d")!;
      const solutionLines = wrapText(mCtx, solution, W - PADDING * 2, MIN_FONT);
      const solutionLineH = Math.round(MIN_FONT * 1.55);
      const diagramStepsH = diagrams.length > 0
        ? D_SECTION_LABEL_H + diagrams.reduce((s, d, i) =>
            s + (d.title ? D_STEP_TITLE_H : 0) + d.rows.length * (D_ROW_H + D_ROW_GAP) - D_ROW_GAP
            + (d.unitValue ? 56 : 24) + (i < diagrams.length - 1 ? D_STEP_GAP : 0), 0) + 18
        : 0;
      const H = imgDrawH + 2 + diagramStepsH + (diagramStepsH > 0 ? 2 : 0)
        + LABEL_H + 16 + solutionLines.length * solutionLineH + PADDING + LOGO_H + 60;

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

          const D_LABEL_FONT = 20;
          for (let i = 0; i < step.rows.length; i++) {
            const row = step.rows[i];
            const col = D_COLORS[i % D_COLORS.length];
            const barX = PADDING + D_LABEL_W;
            const rowY = curY + i * (D_ROW_H + D_ROW_GAP);
            const labelX = PADDING + D_LABEL_W - 12;

            // Draw row label — split to two lines if long
            ctx.fillStyle = "#475569";
            ctx.font = `500 ${D_LABEL_FONT}px ${FONT}`;
            ctx.textAlign = "right";
            const [lbl1, lbl2] = splitCanvasLabel(row.label);
            if (lbl2) {
              ctx.fillText(lbl1, labelX, rowY + D_ROW_H / 2);
              ctx.fillText(lbl2, labelX, rowY + D_ROW_H / 2 + D_LABEL_FONT + 2);
            } else {
              ctx.fillText(lbl1, labelX, rowY + D_ROW_H / 2 + 7);
            }

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
              ctx.font = `bold ${D_LABEL_FONT + 2}px ${FONT}`;
              ctx.textAlign = "left";
              ctx.fillText(row.value, D_VALUE_X, rowY + D_ROW_H / 2 + 7);
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

      ctx.fillStyle = "#6b7280";
      ctx.font = `bold ${LABEL_SIZE}px ${FONT}`;
      ctx.textAlign = "left";
      ctx.fillText("SOLUTION", PADDING, curY + LABEL_H);

      // Derive actual available height from real curY position
      const solutionAreaH = H - LOGO_H - curY;
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
      const textStartY = curY + LABEL_H + 32;
      lines.forEach((line, i) => { ctx.fillText(line, PADDING, textStartY + i * LINE_H); });

      // Logo bar
      const logoY = H - LOGO_H;
      ctx.fillStyle = "#1d4ed8";
      ctx.fillRect(0, logoY, W, LOGO_H);
      ctx.fillStyle = "#ffffff";
      ctx.font = `bold 38px ${FONT}`;
      ctx.textAlign = "center";
      ctx.fillText("MarkForYou.com", W / 2, logoY + 36);
      ctx.font = `22px ${FONT}`;
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.fillText("Practice with more similar questions", W / 2, logoY + 64);

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

  const fileUploadRef = useRef<HTMLInputElement>(null);
  const cameraCaptureRef = useRef<HTMLInputElement>(null);

  return (
    <div className="min-h-screen bg-[#f8f9ff] font-body text-[#0b1c30] antialiased">
      {/* Hidden file inputs */}
      <input ref={fileUploadRef} type="file" accept="image/*" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />
      <input ref={cameraCaptureRef} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }} />

      {/* Top App Bar */}
      <header className="sticky top-0 z-50 bg-[#eff4ff] flex justify-between items-center px-6 py-4">
        <div className="flex items-center gap-4">
          <button onClick={() => router.push(`/home/${userId}`)}
            className="w-10 h-10 rounded-full flex items-center justify-center hover:bg-[#d3e4fe] transition-colors">
            <span className="material-symbols-outlined text-[#001e40]">arrow_back</span>
          </button>
          <div className="flex items-center gap-2">
            <img src="/logo_t.png" alt="Owl" className="w-8 h-8 object-contain" />
            <span className="text-xl font-headline font-extrabold text-[#001e40]">AI Solver</span>
          </div>
        </div>
        <span className="material-symbols-outlined text-slate-400">account_circle</span>
      </header>

      <main className="px-6 pt-4 pb-16 max-w-md mx-auto">
        {/* Hero */}
        {step !== "result" && (
          <section className="mb-10 text-center">
            <div className="inline-flex items-center justify-center p-4 mb-6 rounded-3xl bg-[#d3e4fe] relative">
              <span className="material-symbols-outlined text-5xl text-[#001e40]" style={{ fontVariationSettings: "'FILL' 1" }}>psychology</span>
              <span className="absolute -top-2 -right-2 bg-[#006c49] text-white text-[10px] font-bold px-2 py-0.5 rounded-full">AI</span>
            </div>
            <h1 className="text-2xl font-headline font-extrabold text-[#001e40] mb-3 leading-tight tracking-tight">Capture &amp; Solve</h1>
            <p className="text-[#43474f] text-sm px-4 leading-relaxed">Take a photo or upload an image of a question and let AI solve it.</p>
          </section>
        )}

        {step === "capture" && (
          <div className="space-y-6">
            {error && <div className="bg-red-50 text-red-600 text-sm px-4 py-3 rounded-xl border border-red-100">{error}</div>}
            <div className="grid grid-cols-2 gap-4">
              <button onClick={() => cameraCaptureRef.current?.click()}
                className="flex flex-col items-center justify-center bg-[#001e40] p-8 rounded-[2rem] text-white shadow-xl hover:scale-[1.02] active:scale-95 transition-all relative overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-br from-[#001e40] to-[#003366] opacity-50" />
                <span className="material-symbols-outlined text-4xl mb-3 relative z-10" style={{ fontVariationSettings: "'FILL' 1" }}>photo_camera</span>
                <span className="font-headline font-bold text-sm relative z-10">Take Photo</span>
              </button>
              <button onClick={() => fileUploadRef.current?.click()}
                className="flex flex-col items-center justify-center bg-[#d3e4fe] p-8 rounded-[2rem] text-[#001e40] border-2 border-transparent hover:border-[#003366]/20 transition-all hover:scale-[1.02] active:scale-95">
                <span className="material-symbols-outlined text-4xl mb-3 text-[#799dd6]">upload_file</span>
                <span className="font-headline font-bold text-sm">Upload Photo</span>
              </button>
            </div>
            <div className="space-y-3">
              <label className="block text-xs font-bold text-[#001e40] uppercase tracking-widest px-1">Additional context (optional)</label>
              <div className="relative group">
                <textarea value={hint} onChange={(e) => setHint(e.target.value)}
                  className="w-full h-32 bg-white border-none rounded-2xl p-4 text-sm text-[#0b1c30] placeholder:text-[#737780] focus:ring-2 focus:ring-[#003366]/30 transition-all shadow-sm resize-none"
                  placeholder="e.g. 'Solve for x' or 'Explain this concept simply'..." />
                <div className="absolute bottom-3 right-3 opacity-20 group-focus-within:opacity-100 transition-opacity">
                  <span className="material-symbols-outlined text-[#001e40] text-lg">edit_note</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {step === "solving" && (
          <div className="flex flex-col items-center justify-center py-16 gap-6">
            {imageDataUrl && <img src={imageDataUrl} alt="Question" className="w-full max-h-48 object-contain rounded-2xl shadow-sm border border-slate-100" />}
            <div className="animate-spin rounded-full h-10 w-10 border-4 border-[#003366]/20 border-t-[#003366]" />
            <p className="text-sm font-medium text-[#43474f]">AI is working on it…</p>
          </div>
        )}

        {step === "result" && (
          <div className="space-y-4 pt-4">
            {imageDataUrl && <img src={imageDataUrl} alt="Question" className="w-full rounded-xl border border-slate-100" />}
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`px-3 py-1 rounded-full text-xs font-semibold ${subject === "Science" ? "bg-green-100 text-green-700" : subject === "English" ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"}`}>{subject}</span>
              {topic && <span className="px-3 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-600">{topic}</span>}
            </div>
            {diagrams.length > 0 && (
              <div className="rounded-2xl bg-white border border-slate-100 p-4 space-y-4">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Model Diagram</p>
                {diagrams.map((d, i) => (
                  <div key={i}>
                    {d.title && <p className="text-xs font-semibold text-blue-600 mb-2">{d.title}</p>}
                    <BarModel diagram={d} />
                    {i < diagrams.length - 1 && <div className="border-t border-slate-100 mt-4" />}
                  </div>
                ))}
              </div>
            )}
            <div className="rounded-2xl bg-gradient-to-br from-[#eff6ff] to-[#eff4ff] border border-slate-100 p-4">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Solution</p>
              <FormattedText text={solution} className="text-sm text-slate-800 leading-relaxed whitespace-pre-line" />
              <p className="text-xs text-slate-400 mt-3 italic">The AI is not yet trained on PSLE, so answers may sometimes be incorrect.</p>
            </div>
            <button onClick={handleShare} disabled={sharing}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl bg-[#001e40] text-white text-sm font-semibold hover:opacity-90 transition-colors disabled:opacity-50">
              {sharing ? <span className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white" /> : <span className="material-symbols-outlined text-base">share</span>}
              {sharing ? "Preparing…" : "Share Solution"}
            </button>
            {topic && (
              <div className="rounded-2xl border border-slate-200 bg-white p-4">
                <p className="text-sm text-[#0b1c30] font-medium mb-3">
                  Create a focused test on <span className="text-[#003366] font-semibold">{topic}</span> for <span className="text-[#003366] font-semibold">{linkedStudent?.name ?? "your child"}</span>?
                </p>
                {noStudentLinked && <p className="text-sm text-amber-600 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 mb-3">Please link a student to your account first.</p>}
                {error && <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3 mb-3">{error}</p>}
                <div className="flex gap-3">
                  <button onClick={() => router.push(`/home/${userId}`)}
                    className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-600 text-sm font-medium hover:bg-slate-50 transition-colors">No</button>
                  <button onClick={createFocusedTest} disabled={creatingTest}
                    className="flex-1 py-2.5 rounded-xl bg-[#003366] text-white text-sm font-semibold hover:bg-[#003366]/90 transition-colors disabled:opacity-50">
                    {creatingTest ? "Creating…" : "Yes, Create Test"}
                  </button>
                </div>
              </div>
            )}
            <button onClick={() => { setStep("capture"); setImageDataUrl(null); setError(null); setNoStudentLinked(false); setDiagrams([]); }}
              className="w-full py-3 rounded-xl border border-slate-200 text-slate-500 text-sm font-medium hover:bg-slate-50 transition-colors">
              Solve another question
            </button>
          </div>
        )}
      </main>
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
            {row.units <= 12 && Array.from({ length: row.units - 1 }, (_, j) => (
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
