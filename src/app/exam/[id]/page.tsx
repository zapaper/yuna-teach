"use client";

import { Suspense, useEffect, useState, use, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ExamPaperDetail } from "@/types";
import QuestionCard from "@/components/QuestionCard";
import { renderPdfToImages } from "@/lib/pdf";

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

// ─── Tool type ────────────────────────────────────────────────────────────────

type DrawTool = "scroll" | "pen" | "eraser";

// ─── Main content ─────────────────────────────────────────────────────────────

function ExamPracticeContent({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId");

  const [paper, setPaper] = useState<ExamPaperDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageImages, setPageImages] = useState<string[]>([]);
  const [loadingPdf, setLoadingPdf] = useState(false);
  const [view, setView] = useState<"paper" | "questions">("paper");
  const [tool, setTool] = useState<DrawTool>("scroll");
  const [currentIndex, setCurrentIndex] = useState(0);

  // one canvas ref per PDF page
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([]);

  useEffect(() => {
    async function fetchPaper() {
      try {
        const res = await fetch(`/api/exam/${id}`);
        if (!res.ok) throw new Error("Not found");
        const data: ExamPaperDetail = await res.json();
        setPaper(data);
        if (data.pdfPath) {
          loadPdf();
        }
      } catch {
        // handled by null check
      } finally {
        setLoading(false);
      }
    }
    fetchPaper();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadPdf() {
    setLoadingPdf(true);
    try {
      const res = await fetch(`/api/exam/${id}/pdf`);
      if (!res.ok) return;
      const blob = await res.blob();
      const file = new File([blob], "exam.pdf", { type: "application/pdf" });
      const images = await renderPdfToImages(file);
      setPageImages(images);
      canvasRefs.current = new Array(images.length).fill(null);
    } catch (err) {
      console.warn("Could not load PDF:", err);
    } finally {
      setLoadingPdf(false);
    }
  }

  function clearAllInk() {
    canvasRefs.current.forEach((canvas) => {
      if (canvas) {
        const ctx = canvas.getContext("2d");
        ctx?.clearRect(0, 0, canvas.width, canvas.height);
      }
    });
  }

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

  const hasPdf = pageImages.length > 0;
  const questions = paper.questions;

  return (
    <div className="min-h-screen bg-white">
      {/* ── Header ── */}
      <div className="sticky top-0 z-10 bg-white border-b border-slate-100 px-4 py-2 flex items-center gap-3">
        <button
          onClick={() => router.push(backPath)}
          className="p-1.5 -ml-1 rounded-lg text-slate-500 hover:text-slate-700 hover:bg-slate-100 shrink-0"
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
        </button>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-slate-800 truncate">
            {paper.title}
          </p>
          <div className="flex items-center gap-1.5 flex-wrap">
            {paper.subject && (
              <span className="text-[10px] font-medium px-1.5 py-0 rounded-full bg-purple-100 text-purple-700">
                {paper.subject}
              </span>
            )}
            {paper.level && (
              <span className="text-[10px] font-medium px-1.5 py-0 rounded-full bg-green-100 text-green-700">
                {paper.level}
              </span>
            )}
          </div>
        </div>

        {/* Tab toggle (only if PDF loaded) */}
        {hasPdf && (
          <div className="flex rounded-xl border border-slate-200 overflow-hidden shrink-0 text-xs font-medium">
            <button
              onClick={() => setView("paper")}
              className={`px-3 py-1.5 ${
                view === "paper"
                  ? "bg-primary-500 text-white"
                  : "text-slate-500 hover:bg-slate-50"
              }`}
            >
              Paper
            </button>
            <button
              onClick={() => setView("questions")}
              className={`px-3 py-1.5 ${
                view === "questions"
                  ? "bg-primary-500 text-white"
                  : "text-slate-500 hover:bg-slate-50"
              }`}
            >
              Q&A
            </button>
          </div>
        )}
      </div>

      {/* ── PDF loading indicator ── */}
      {loadingPdf && (
        <div className="flex items-center gap-2 px-4 py-2 bg-blue-50 border-b border-blue-100 text-xs text-blue-600">
          <div className="animate-spin rounded-full h-3.5 w-3.5 border-2 border-blue-200 border-t-blue-500 shrink-0" />
          Loading exam paper…
        </div>
      )}

      {/* ── Paper view ── */}
      {(!hasPdf || view === "paper") && hasPdf && (
        <>
          {/* Drawing toolbar */}
          <div className="sticky top-[53px] z-10 bg-white border-b border-slate-100 px-4 py-2 flex items-center gap-2">
            <ToolButton
              active={tool === "scroll"}
              onClick={() => setTool("scroll")}
              title="Scroll / read"
            >
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
              >
                <path d="M18 8L22 12L18 16" />
                <path d="M2 12H22" />
              </svg>
              Scroll
            </ToolButton>
            <ToolButton
              active={tool === "pen"}
              onClick={() => setTool("pen")}
              title="Draw in blue ink"
              activeClass="bg-blue-100 text-blue-700 border-blue-300"
            >
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
              >
                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              </svg>
              Pen
            </ToolButton>
            <ToolButton
              active={tool === "eraser"}
              onClick={() => setTool("eraser")}
              title="Erase ink"
            >
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
              >
                <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
                <path d="M22 21H7" />
                <path d="m5 11 9 9" />
              </svg>
              Eraser
            </ToolButton>

            <div className="flex-1" />

            <button
              onClick={clearAllInk}
              className="text-xs text-slate-400 hover:text-red-500 px-2 py-1 rounded-lg hover:bg-red-50 transition-colors"
              title="Clear all ink"
            >
              Clear all
            </button>
          </div>

          {/* PDF pages with drawing canvas */}
          <div className="divide-y divide-slate-100">
            {pageImages.map((src, i) => (
              <DrawablePage
                key={i}
                imageUrl={src}
                tool={tool}
                onCanvasReady={(el) => {
                  canvasRefs.current[i] = el;
                }}
              />
            ))}
          </div>
        </>
      )}

      {/* ── Question cards view (or fallback when no PDF) ── */}
      {(view === "questions" || !hasPdf) && !loadingPdf && (
        <div className="p-4 pb-24">
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
      )}

      {/* ── No PDF, loading done, show message ── */}
      {!hasPdf && !loadingPdf && !paper.pdfPath && questions.length === 0 && (
        <div className="text-center py-12 text-slate-400 text-sm">
          No content available for this exam.
        </div>
      )}
    </div>
  );
}

// ─── Tool button ──────────────────────────────────────────────────────────────

function ToolButton({
  active,
  onClick,
  title,
  activeClass = "bg-primary-100 text-primary-700 border-primary-300",
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  activeClass?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`flex items-center gap-1 px-2.5 py-1.5 rounded-xl border text-xs font-medium transition-colors ${
        active
          ? activeClass
          : "border-slate-200 text-slate-500 hover:bg-slate-50"
      }`}
    >
      {children}
    </button>
  );
}

// ─── Drawable PDF page ────────────────────────────────────────────────────────

function DrawablePage({
  imageUrl,
  tool,
  onCanvasReady,
}: {
  imageUrl: string;
  tool: DrawTool;
  onCanvasReady: (el: HTMLCanvasElement | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawing = useRef(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);

  // Expose canvas element to parent
  useEffect(() => {
    onCanvasReady(canvasRef.current);
    return () => onCanvasReady(null);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function initCanvas(img: HTMLImageElement) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
  }

  function getPos(clientX: number, clientY: number): { x: number; y: number } {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * (canvas.width / rect.width),
      y: (clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  function applyStyle(ctx: CanvasRenderingContext2D) {
    if (tool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
      ctx.lineWidth = 24;
    } else {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "rgba(37, 99, 235, 0.85)";
      ctx.lineWidth = 3;
    }
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }

  function onStart(clientX: number, clientY: number) {
    if (tool === "scroll") return;
    isDrawing.current = true;
    const pos = getPos(clientX, clientY);
    lastPos.current = pos;
    // Draw dot at start point
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    applyStyle(ctx);
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, tool === "eraser" ? 12 : 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  function onMove(clientX: number, clientY: number) {
    if (!isDrawing.current || !lastPos.current || tool === "scroll") return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;
    const pos = getPos(clientX, clientY);
    applyStyle(ctx);
    ctx.beginPath();
    ctx.moveTo(lastPos.current.x, lastPos.current.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    lastPos.current = pos;
  }

  function onEnd() {
    isDrawing.current = false;
    lastPos.current = null;
  }

  const drawing = tool !== "scroll";

  return (
    <div className="relative" style={{ touchAction: drawing ? "none" : "auto" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={imageUrl}
        alt="Exam page"
        className="w-full h-auto block"
        onLoad={(e) => initCanvas(e.currentTarget)}
        draggable={false}
      />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{
          pointerEvents: drawing ? "auto" : "none",
          touchAction: "none",
          cursor: tool === "pen" ? "crosshair" : tool === "eraser" ? "cell" : "default",
        }}
        onMouseDown={(e) => onStart(e.clientX, e.clientY)}
        onMouseMove={(e) => onMove(e.clientX, e.clientY)}
        onMouseUp={onEnd}
        onMouseLeave={onEnd}
        onTouchStart={(e) => {
          e.preventDefault();
          onStart(e.touches[0].clientX, e.touches[0].clientY);
        }}
        onTouchMove={(e) => {
          e.preventDefault();
          onMove(e.touches[0].clientX, e.touches[0].clientY);
        }}
        onTouchEnd={onEnd}
      />
    </div>
  );
}
