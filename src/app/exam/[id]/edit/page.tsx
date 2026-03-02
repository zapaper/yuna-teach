"use client";

import {
  Suspense,
  useEffect,
  useState,
  use,
  useRef,
  useCallback,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ExamPaperDetail, ExamQuestionItem } from "@/types";
import Image from "next/image";
import { renderPdfToImages } from "@/lib/pdf";

export default function ExamEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <Suspense>
      <ExamEditContent id={id} />
    </Suspense>
  );
}

// ─── Types ───────────────────────────────────────────────────────────────────

type SelectTarget = {
  questionId: string;
  field: "imageData" | "answerImageData";
  defaultPageIndex: number;
};

// ─── Main content ─────────────────────────────────────────────────────────────

function ExamEditContent({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";

  const [paper, setPaper] = useState<ExamPaperDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [pageImages, setPageImages] = useState<string[]>([]);
  const [loadingPdf, setLoadingPdf] = useState(false);
  const [selectTarget, setSelectTarget] = useState<SelectTarget | null>(null);

  useEffect(() => {
    async function fetchPaper() {
      try {
        const res = await fetch(`/api/exam/${id}`);
        if (!res.ok) throw new Error("Not found");
        const data: ExamPaperDetail = await res.json();
        setPaper(data);
        // Auto-load PDF from server if stored
        if (data.pdfPath) {
          loadPdfFromServer();
        }
      } catch {
        // handled by null check
      } finally {
        setLoading(false);
      }
    }
    fetchPaper();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadPdfFromServer() {
    setLoadingPdf(true);
    try {
      const res = await fetch(`/api/exam/${id}/pdf`);
      if (!res.ok) return;
      const blob = await res.blob();
      const file = new File([blob], "exam.pdf", { type: "application/pdf" });
      const images = await renderPdfToImages(file);
      setPageImages(images);
    } catch (err) {
      console.warn("Could not auto-load PDF from server:", err);
    } finally {
      setLoadingPdf(false);
    }
  }

  async function handlePdfLoad(file: File) {
    setLoadingPdf(true);
    try {
      const images = await renderPdfToImages(file);
      setPageImages(images);
      // Persist to server so it auto-loads next time
      const form = new FormData();
      form.append("pdf", file);
      await fetch(`/api/exam/${id}/pdf`, { method: "POST", body: form });
    } finally {
      setLoadingPdf(false);
    }
  }

  async function saveQuestion(
    questionId: string,
    field: keyof ExamQuestionItem,
    value: string | null
  ) {
    setSaving(questionId + field);
    try {
      await fetch(`/api/exam/questions/${questionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      setPaper((prev) =>
        prev
          ? {
              ...prev,
              questions: prev.questions.map((q) =>
                q.id === questionId ? { ...q, [field]: value } : q
              ),
            }
          : prev
      );
    } finally {
      setSaving(null);
    }
  }

  const backPath = `/exam/${id}/overview?userId=${userId}`;

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
          Go Back
        </button>
      </div>
    );
  }

  return (
    <div className="p-6 pb-24 max-w-2xl mx-auto">
      {/* Back */}
      <button
        onClick={() => router.push(backPath)}
        className="flex items-center gap-1 text-slate-500 mb-6 hover:text-slate-700"
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
        Overview
      </button>

      <h1 className="text-xl font-bold text-slate-800 mb-1">
        Edit Questions &amp; Answers
      </h1>
      <p className="text-sm text-slate-400 mb-5">{paper.title}</p>

      {/* PDF loader */}
      <PdfLoader
        loaded={pageImages.length > 0}
        loading={loadingPdf}
        onFile={handlePdfLoad}
      />

      {/* Question cards */}
      <div className="space-y-4 mt-5">
        {paper.questions.map((q) => (
          <QuestionEditCard
            key={q.id}
            question={q}
            saving={saving?.startsWith(q.id) ? saving.slice(q.id.length) as keyof ExamQuestionItem : null}
            pdfLoaded={pageImages.length > 0}
            onSave={saveQuestion}
            onSelectArea={(field) =>
              setSelectTarget({
                questionId: q.id,
                field,
                defaultPageIndex: q.pageIndex,
              })
            }
          />
        ))}
      </div>

      {/* Area selection modal */}
      {selectTarget && (
        <PageSelectionModal
          pageImages={pageImages}
          defaultPageIndex={selectTarget.defaultPageIndex}
          onConfirm={(croppedDataUrl) => {
            saveQuestion(
              selectTarget.questionId,
              selectTarget.field,
              croppedDataUrl
            );
            setSelectTarget(null);
          }}
          onClose={() => setSelectTarget(null)}
        />
      )}
    </div>
  );
}

// ─── PDF Loader ───────────────────────────────────────────────────────────────

function PdfLoader({
  loaded,
  loading,
  onFile,
}: {
  loaded: boolean;
  loading: boolean;
  onFile: (file: File) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  return (
    <div
      className={`rounded-2xl border-2 px-4 py-3 flex items-center gap-3 ${
        loaded
          ? "border-green-200 bg-green-50"
          : "border-dashed border-slate-300 bg-slate-50"
      }`}
    >
      {loaded ? (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-green-500 shrink-0"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="text-slate-400 shrink-0"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-slate-700">
          {loaded ? "PDF loaded — manual selection enabled" : "Load original PDF"}
        </p>
        <p className="text-xs text-slate-400">
          {loaded
            ? "You can now select any area from any page"
            : "Required to manually select question or answer areas"}
        </p>
      </div>
      <input
        ref={ref}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
        }}
      />
      <button
        onClick={() => ref.current?.click()}
        disabled={loading}
        className="shrink-0 text-xs font-medium px-3 py-1.5 rounded-xl border border-slate-300 text-slate-600 hover:bg-white hover:border-slate-400 disabled:opacity-50 transition-colors"
      >
        {loading ? "Loading…" : loaded ? "Reload" : "Choose PDF"}
      </button>
    </div>
  );
}

// ─── Question card ────────────────────────────────────────────────────────────

function QuestionEditCard({
  question,
  saving,
  pdfLoaded,
  onSave,
  onSelectArea,
}: {
  question: ExamQuestionItem;
  saving: keyof ExamQuestionItem | null;
  pdfLoaded: boolean;
  onSave: (
    id: string,
    field: keyof ExamQuestionItem,
    value: string | null
  ) => void;
  onSelectArea: (field: "imageData" | "answerImageData") => void;
}) {
  const [qNum, setQNum] = useState(question.questionNum);
  const [answer, setAnswer] = useState(question.answer ?? "");
  const [qNumDirty, setQNumDirty] = useState(false);
  const [answerDirty, setAnswerDirty] = useState(false);

  // Keep local state in sync when parent updates (after save)
  useEffect(() => {
    setQNum(question.questionNum);
    setQNumDirty(false);
  }, [question.questionNum]);

  useEffect(() => {
    setAnswer(question.answer ?? "");
    setAnswerDirty(false);
  }, [question.answer]);

  const isMissingAnswer =
    !question.answer ||
    question.answer.trim() === "" ||
    question.answer === "?";

  return (
    <div
      className={`rounded-2xl border-2 bg-white shadow-sm overflow-hidden ${
        isMissingAnswer ? "border-red-200" : "border-slate-100"
      }`}
    >
      {/* ── Question image section ── */}
      <div className="relative bg-slate-50">
        <Image
          src={question.imageData}
          alt={`Question ${question.questionNum}`}
          width={800}
          height={400}
          className="w-full h-auto object-contain"
          unoptimized
        />
        <button
          onClick={() => onSelectArea("imageData")}
          disabled={!pdfLoaded}
          title={
            pdfLoaded
              ? "Select question area from PDF"
              : "Load PDF first to use manual selection"
          }
          className="absolute bottom-2 right-2 flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-xl bg-white/90 border border-slate-200 text-slate-600 hover:bg-white hover:border-primary-300 hover:text-primary-600 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm transition-colors"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 3h5v5H3zM16 3h5v5h-5zM3 16h5v5H3zM16 16h5v5h-5z" />
          </svg>
          Select area
        </button>
      </div>

      <div className="p-4 space-y-3">
        {/* Question number */}
        <div className="flex items-center gap-3">
          <label className="text-xs font-medium text-slate-500 w-24 shrink-0">
            Question No.
          </label>
          <div className="flex-1 flex gap-2">
            <input
              type="text"
              value={qNum}
              onChange={(e) => {
                setQNum(e.target.value);
                setQNumDirty(e.target.value !== question.questionNum);
              }}
              className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:border-primary-400"
            />
            {qNumDirty && (
              <button
                onClick={() => {
                  onSave(question.id, "questionNum", qNum);
                  setQNumDirty(false);
                }}
                disabled={saving === "questionNum"}
                className="px-3 py-2 rounded-xl bg-primary-500 text-white text-xs font-medium hover:bg-primary-600 disabled:opacity-50"
              >
                {saving === "questionNum" ? "…" : "Save"}
              </button>
            )}
          </div>
        </div>

        {/* Answer text */}
        <div className="flex items-start gap-3">
          <label
            className={`text-xs font-medium w-24 shrink-0 mt-2 ${
              isMissingAnswer ? "text-red-500" : "text-slate-500"
            }`}
          >
            Answer{isMissingAnswer && " ⚠"}
          </label>
          <div className="flex-1 flex gap-2">
            <textarea
              value={answer}
              rows={2}
              onChange={(e) => {
                setAnswer(e.target.value);
                setAnswerDirty(e.target.value !== (question.answer ?? ""));
              }}
              placeholder={isMissingAnswer ? "Enter answer…" : ""}
              className={`flex-1 rounded-xl border px-3 py-2 text-sm focus:outline-none resize-none ${
                isMissingAnswer
                  ? "border-red-300 focus:border-red-400 bg-red-50 placeholder:text-red-300"
                  : "border-slate-200 focus:border-primary-400"
              }`}
            />
            {answerDirty && (
              <button
                onClick={() => {
                  onSave(question.id, "answer", answer);
                  setAnswerDirty(false);
                }}
                disabled={saving === "answer"}
                className="px-3 py-2 rounded-xl bg-primary-500 text-white text-xs font-medium hover:bg-primary-600 disabled:opacity-50 self-start"
              >
                {saving === "answer" ? "…" : "Save"}
              </button>
            )}
          </div>
        </div>

        {/* Answer image — collapsed by default, expands when image exists or user clicks */}
        {question.answerImageData ? (
          <div className="flex items-start gap-3">
            <span className="text-xs font-medium text-slate-500 w-24 shrink-0 mt-1">
              Answer img
            </span>
            <div className="flex-1 space-y-2">
              <Image
                src={question.answerImageData}
                alt="Answer image"
                width={600}
                height={200}
                className="w-full h-auto rounded-xl border border-slate-100 object-contain"
                unoptimized
              />
              <div className="flex gap-2">
                {pdfLoaded && (
                  <button
                    onClick={() => onSelectArea("answerImageData")}
                    className="text-xs text-slate-500 hover:text-primary-600 transition-colors"
                  >
                    Replace
                  </button>
                )}
                <button
                  onClick={() => onSave(question.id, "answerImageData", null)}
                  className="text-xs text-slate-500 hover:text-red-500 transition-colors"
                >
                  Remove
                </button>
              </div>
            </div>
          </div>
        ) : pdfLoaded ? (
          <button
            onClick={() => onSelectArea("answerImageData")}
            className="text-xs text-slate-400 hover:text-primary-600 transition-colors ml-27"
          >
            + Add answer image
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ─── Page selection modal ─────────────────────────────────────────────────────

function PageSelectionModal({
  pageImages,
  defaultPageIndex,
  onConfirm,
  onClose,
}: {
  pageImages: string[];
  defaultPageIndex: number;
  onConfirm: (croppedDataUrl: string) => void;
  onClose: () => void;
}) {
  const [pageIndex, setPageIndex] = useState(
    Math.min(defaultPageIndex, pageImages.length - 1)
  );
  const [selection, setSelection] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const [dragging, setDragging] = useState<{
    startX: number;
    startY: number;
  } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Reset selection when page changes
  useEffect(() => {
    setSelection(null);
  }, [pageIndex]);

  function getRelativeCoords(
    e: React.MouseEvent | React.TouchEvent
  ): { x: number; y: number } {
    const rect = containerRef.current!.getBoundingClientRect();
    const clientX =
      "touches" in e ? e.touches[0].clientX : (e as React.MouseEvent).clientX;
    const clientY =
      "touches" in e ? e.touches[0].clientY : (e as React.MouseEvent).clientY;
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
    };
  }

  function onPointerDown(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault();
    const { x, y } = getRelativeCoords(e);
    setDragging({ startX: x, startY: y });
    setSelection({ x, y, w: 0, h: 0 });
  }

  function onPointerMove(e: React.MouseEvent | React.TouchEvent) {
    if (!dragging) return;
    const { x, y } = getRelativeCoords(e);
    setSelection({
      x: Math.min(dragging.startX, x),
      y: Math.min(dragging.startY, y),
      w: Math.abs(x - dragging.startX),
      h: Math.abs(y - dragging.startY),
    });
  }

  function onPointerUp(e: React.MouseEvent | React.TouchEvent) {
    onPointerMove(e);
    setDragging(null);
  }

  const handleConfirm = useCallback(() => {
    if (!selection || !imgRef.current) return;
    const img = imgRef.current;
    const natW = img.naturalWidth;
    const natH = img.naturalHeight;

    const canvas = document.createElement("canvas");
    const cropX = Math.round(selection.x * natW);
    const cropY = Math.round(selection.y * natH);
    const cropW = Math.max(1, Math.round(selection.w * natW));
    const cropH = Math.max(1, Math.round(selection.h * natH));
    canvas.width = cropW;
    canvas.height = cropH;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
    onConfirm(canvas.toDataURL("image/jpeg", 0.92));
  }, [selection, onConfirm]);

  const hasSelection = selection && selection.w > 0.01 && selection.h > 0.01;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/80">
      {/* Toolbar */}
      <div className="flex items-center justify-between bg-slate-900 px-4 py-3 shrink-0">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
            disabled={pageIndex === 0}
            className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-700 disabled:opacity-30"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
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
          <span className="text-sm text-slate-300 tabular-nums">
            Page {pageIndex + 1} / {pageImages.length}
          </span>
          <button
            onClick={() =>
              setPageIndex((i) => Math.min(pageImages.length - 1, i + 1))
            }
            disabled={pageIndex === pageImages.length - 1}
            className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-700 disabled:opacity-30"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        </div>

        <p className="text-xs text-slate-400 hidden sm:block">
          Drag to select an area
        </p>

        <div className="flex items-center gap-2">
          <button
            onClick={handleConfirm}
            disabled={!hasSelection}
            className="px-4 py-2 rounded-xl bg-primary-500 text-white text-sm font-semibold hover:bg-primary-600 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Use selection
          </button>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-slate-700"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Page + drag overlay */}
      <div className="flex-1 overflow-auto flex items-start justify-center p-2 sm:p-6">
        <div
          ref={containerRef}
          className="relative select-none cursor-crosshair"
          onMouseDown={onPointerDown}
          onMouseMove={onPointerMove}
          onMouseUp={onPointerUp}
          onMouseLeave={onPointerUp}
          onTouchStart={onPointerDown}
          onTouchMove={onPointerMove}
          onTouchEnd={onPointerUp}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imgRef}
            src={pageImages[pageIndex]}
            alt={`Page ${pageIndex + 1}`}
            className="max-w-full h-auto block rounded shadow-lg"
            draggable={false}
          />

          {/* Selection overlay */}
          {selection && selection.w > 0 && selection.h > 0 && (
            <div
              className="absolute border-2 border-primary-400 bg-primary-400/10 pointer-events-none"
              style={{
                left: `${selection.x * 100}%`,
                top: `${selection.y * 100}%`,
                width: `${selection.w * 100}%`,
                height: `${selection.h * 100}%`,
              }}
            />
          )}
        </div>
      </div>

      {/* Hint */}
      <div className="bg-slate-900 px-4 py-2 text-center shrink-0">
        <p className="text-xs text-slate-500">
          {hasSelection
            ? "Selection ready — tap \"Use selection\" to crop"
            : "Drag on the page to select the area you want"}
        </p>
      </div>
    </div>
  );
}
