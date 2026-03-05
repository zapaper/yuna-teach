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
  const [extracting, setExtracting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchPaper = useCallback(async () => {
    try {
      const res = await fetch(`/api/exam/${id}`);
      if (!res.ok) throw new Error("Not found");
      const data: ExamPaperDetail = await res.json();
      setPaper(data);
      setExtracting(data.extractionStatus === "processing");
      return data;
    } catch {
      return null;
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchPaper().then((data) => {
      if (data && data.extractionStatus !== "processing") {
        loadPageImages();
      }
    });
  }, [fetchPaper]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll while extraction is in progress
  useEffect(() => {
    if (extracting) {
      pollRef.current = setInterval(async () => {
        const data = await fetchPaper();
        if (data && data.extractionStatus !== "processing") {
          setExtracting(false);
          loadPageImages();
        }
      }, 4000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [extracting, fetchPaper]); // eslint-disable-line react-hooks/exhaustive-deps

  // Try loading page images from disk first, fall back to PDF rendering
  async function loadPageImages() {
    setLoadingPdf(true);
    try {
      // Try disk pages first
      const countRes = await fetch(`/api/exam/${id}/pages`);
      if (countRes.ok) {
        const { pageCount } = await countRes.json();
        if (pageCount > 0) {
          const images: string[] = [];
          for (let i = 0; i < pageCount; i++) {
            const pageRes = await fetch(`/api/exam/${id}/pages?page=${i}`);
            if (!pageRes.ok) throw new Error("Page fetch failed");
            const blob = await pageRes.blob();
            const url = URL.createObjectURL(blob);
            images.push(url);
          }
          setPageImages(images);
          return;
        }
      }
      // Fall back to PDF rendering
      await loadPdfFromServer();
    } catch {
      // Fall back to PDF rendering
      await loadPdfFromServer();
    } finally {
      setLoadingPdf(false);
    }
  }

  async function loadPdfFromServer() {
    try {
      const res = await fetch(`/api/exam/${id}/pdf`);
      if (!res.ok) return;
      const blob = await res.blob();
      const file = new File([blob], "exam.pdf", { type: "application/pdf" });
      const images = await renderPdfToImages(file);
      setPageImages(images);
    } catch (err) {
      console.warn("Could not auto-load PDF from server:", err);
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
    value: string | number | null
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

  async function deleteQuestion(questionId: string) {
    await fetch(`/api/exam/questions/${questionId}`, { method: "DELETE" });
    setPaper((prev) =>
      prev
        ? { ...prev, questions: prev.questions.filter((q) => q.id !== questionId) }
        : prev
    );
  }

  function buildQuestionFromResponse(newQ: Record<string, unknown>): ExamQuestionItem {
    return {
      id: newQ.id as string,
      questionNum: newQ.questionNum as string,
      imageData: newQ.imageData as string,
      answer: newQ.answer as string | null,
      answerImageData: newQ.answerImageData as string | null,
      pageIndex: newQ.pageIndex as number,
      orderIndex: newQ.orderIndex as number,
      yStartPct: newQ.yStartPct as number | null,
      yEndPct: newQ.yEndPct as number | null,
      marksAwarded: newQ.marksAwarded as number | null,
      marksAvailable: newQ.marksAvailable as number | null,
      markingNotes: newQ.markingNotes as string | null,
    };
  }

  async function addQuestion() {
    const res = await fetch(`/api/exam/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "addQuestion" }),
    });
    if (!res.ok) return;
    const newQ = buildQuestionFromResponse(await res.json());
    setPaper((prev) =>
      prev
        ? { ...prev, questions: [...prev.questions, newQ] }
        : prev
    );
  }

  async function addQuestionAfter(afterOrderIndex: number) {
    const res = await fetch(`/api/exam/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "addQuestion", afterOrderIndex }),
    });
    if (!res.ok) return;
    const newQ = buildQuestionFromResponse(await res.json());
    setPaper((prev) => {
      if (!prev) return prev;
      // Increment orderIndex for all questions after the insertion point
      const updated = prev.questions.map((q) =>
        q.orderIndex > afterOrderIndex ? { ...q, orderIndex: q.orderIndex + 1 } : q
      );
      // Insert the new question and re-sort
      return { ...prev, questions: [...updated, newQ].sort((a, b) => a.orderIndex - b.orderIndex) };
    });
  }

  // Convert a blob URL or data URL to a base64 data URL
  async function toDataUrl(src: string): Promise<string> {
    if (src.startsWith("data:")) return src;
    const res = await fetch(src);
    const blob = await res.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });
  }

  async function redoQuestion(questionId: string) {
    const q = paper?.questions.find((x) => x.id === questionId);
    if (!q || pageImages.length === 0) return;

    setSaving(questionId + "redo");
    try {
      // Send page images around the question for re-extraction
      const pageIdx = q.pageIndex;
      const srcs = [pageImages[pageIdx]];
      if (pageIdx + 1 < pageImages.length) srcs.push(pageImages[pageIdx + 1]);
      // Convert blob URLs to base64 data URLs for the API
      const imagesToSend = await Promise.all(srcs.map(toDataUrl));

      const idx = paper!.questions.indexOf(q);
      const surrounding = paper!.questions
        .filter((_, i) => i >= idx - 1 && i <= idx + 1)
        .map((x) => x.questionNum);

      const prevQ = idx > 0 ? paper!.questions[idx - 1] : null;

      const res = await fetch("/api/exam/redo-question", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          images: imagesToSend,
          questionNum: q.questionNum,
          surroundingQuestions: surrounding,
          isFirstInBooklet: idx === 0,
          previousBoundary: prevQ
            ? { questionNum: prevQ.questionNum, yEndPct: prevQ.yEndPct }
            : undefined,
        }),
      });
      if (!res.ok) return;

      const result = await res.json();
      const actualPage = pageIdx + (result.pageOffset ?? 0);

      // Crop the new area from the page image
      const img = new window.Image();
      img.crossOrigin = "anonymous";
      await new Promise<void>((resolve) => {
        img.onload = () => resolve();
        img.src = pageImages[actualPage] ?? pageImages[pageIdx];
      });

      const canvas = document.createElement("canvas");
      const natH = img.naturalHeight;
      const natW = img.naturalWidth;
      const topPad = Math.round(0.05 * natH);
      const botPad = Math.round(0.02 * natH);
      const cropTop = Math.max(0, Math.floor((result.yStartPct / 100) * natH) - topPad);
      const cropBottom = Math.min(natH, Math.ceil((result.yEndPct / 100) * natH) + botPad);
      canvas.width = natW;
      canvas.height = cropBottom - cropTop;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, cropTop, natW, canvas.height, 0, 0, natW, canvas.height);
      const newImageData = canvas.toDataURL("image/jpeg", 0.92);

      await saveQuestion(questionId, "imageData", newImageData);
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

      {/* Extraction in progress banner */}
      {extracting && (
        <div className="rounded-2xl border-2 border-blue-200 bg-blue-50 p-4 mb-5 flex items-center gap-3">
          <div className="animate-spin rounded-full h-5 w-5 border-2 border-blue-200 border-t-blue-600 shrink-0" />
          <div>
            <p className="text-sm font-medium text-blue-800">Extraction in progress...</p>
            <p className="text-xs text-blue-600">This takes 3–5 mins. Feel free to continue with other work!</p>
          </div>
        </div>
      )}

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
            saving={saving?.startsWith(q.id) ? saving.slice(q.id.length) as keyof ExamQuestionItem | "redo" : null}
            pdfLoaded={pageImages.length > 0}
            onSave={saveQuestion}
            onDelete={() => deleteQuestion(q.id)}
            onRedo={() => redoQuestion(q.id)}
            onAddAfter={() => addQuestionAfter(q.orderIndex)}
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

      {/* Add question button */}
      <button
        onClick={addQuestion}
        className="w-full mt-4 py-3 rounded-2xl border-2 border-dashed border-slate-300 text-slate-500 font-medium hover:border-primary-300 hover:text-primary-600 transition-colors"
      >
        + Add Question
      </button>

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
  onDelete,
  onRedo,
  onAddAfter,
  onSelectArea,
}: {
  question: ExamQuestionItem;
  saving: keyof ExamQuestionItem | "redo" | null;
  pdfLoaded: boolean;
  onSave: (
    id: string,
    field: keyof ExamQuestionItem,
    value: string | number | null
  ) => void;
  onDelete: () => void;
  onRedo: () => void;
  onAddAfter: () => void;
  onSelectArea: (field: "imageData" | "answerImageData") => void;
}) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
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
      {/* ── Question image ── */}
      <div className="bg-slate-50">
        <Image
          src={question.imageData}
          alt={`Question ${question.questionNum}`}
          width={800}
          height={400}
          className="w-full h-auto object-contain"
          unoptimized
        />
      </div>

      {/* ── Action bar ── */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-slate-100 bg-slate-50/50">
        <button
          onClick={onRedo}
          disabled={!pdfLoaded || saving === "redo"}
          title={pdfLoaded ? "Re-extract question boundaries" : "Load PDF first"}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-xl border border-slate-200 text-slate-600 hover:bg-white hover:border-amber-300 hover:text-amber-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {saving === "redo" ? (
            <span className="animate-spin rounded-full h-3 w-3 border-2 border-slate-200 border-t-slate-600 inline-block" />
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />
            </svg>
          )}
          Redo extract
        </button>
        <button
          onClick={() => onSelectArea("imageData")}
          disabled={!pdfLoaded}
          title={pdfLoaded ? "Select question area from PDF" : "Load PDF first"}
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-xl border border-slate-200 text-slate-600 hover:bg-white hover:border-primary-300 hover:text-primary-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 3h5v5H3zM16 3h5v5h-5zM3 16h5v5H3zM16 16h5v5h-5z" />
          </svg>
          Select area
        </button>
        <div className="flex-1" />
        <button
          onClick={() => setShowDeleteConfirm(true)}
          title="Delete this question"
          className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-xl border border-slate-200 text-slate-500 hover:bg-red-50 hover:border-red-300 hover:text-red-600 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
          </svg>
          Delete
        </button>
      </div>

      <div className="p-4 space-y-3">
        {/* Question number + marks */}
        <div className="flex items-center gap-3">
          <label className="text-xs font-medium text-slate-500 w-24 shrink-0">
            Question No.
          </label>
          <div className="flex-1 flex items-center gap-2">
            <input
              type="text"
              value={qNum}
              onChange={(e) => {
                setQNum(e.target.value);
                setQNumDirty(e.target.value !== question.questionNum);
              }}
              className="w-20 rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:border-primary-400"
            />
            {qNumDirty ? (
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
            ) : null}
            <div className="flex items-center gap-1 ml-auto text-xs text-slate-500">
              <input
                type="number"
                defaultValue={question.marksAwarded ?? ""}
                onBlur={(e) => {
                  const v = e.target.value === "" ? null : Number(e.target.value);
                  if (v !== (question.marksAwarded ?? null)) {
                    onSave(question.id, "marksAwarded", v);
                  }
                }}
                placeholder="–"
                className="w-10 text-center rounded-lg border border-slate-200 px-1 py-1 text-xs focus:outline-none focus:border-primary-400"
              />
              <span>/</span>
              <input
                type="number"
                defaultValue={question.marksAvailable ?? ""}
                onBlur={(e) => {
                  const v = e.target.value === "" ? null : Number(e.target.value);
                  if (v !== (question.marksAvailable ?? null)) {
                    onSave(question.id, "marksAvailable", v);
                  }
                }}
                placeholder="–"
                className="w-10 text-center rounded-lg border border-slate-200 px-1 py-1 text-xs focus:outline-none focus:border-primary-400"
              />
              <span className="text-slate-400">marks</span>
            </div>
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
            {answerDirty ? (
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
            ) : null}
          </div>
        </div>

        {/* Answer image — collapsed by default, expands when image exists or user clicks */}
        <div>
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
                  {pdfLoaded ? (
                    <button
                      onClick={() => onSelectArea("answerImageData")}
                      className="text-xs text-slate-500 hover:text-primary-600 transition-colors"
                    >
                      Replace
                    </button>
                  ) : null}
                  <button
                    onClick={() => onSave(question.id, "answerImageData", null)}
                    className="text-xs text-slate-500 hover:text-red-500 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <button
              onClick={() => onSelectArea("answerImageData")}
              disabled={!pdfLoaded}
              className="text-xs px-3 py-1.5 rounded-lg border border-dashed border-slate-300 text-slate-500 hover:text-primary-600 hover:border-primary-300 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span>+ Add answer image</span>{!pdfLoaded ? <span> (load PDF first)</span> : null}
            </button>
          )}
        </div>
      </div>

      {/* Add Qn button — bottom right */}
      <div className="flex justify-end px-4 pb-3">
        <button
          onClick={onAddAfter}
          className="text-[11px] font-medium px-2.5 py-1 rounded-lg border border-dashed border-slate-300 text-slate-400 hover:border-primary-300 hover:text-primary-600 hover:bg-primary-50 transition-colors"
        >
          + Add Qn
        </button>
      </div>

      {/* Delete confirmation */}
      {showDeleteConfirm && (
        <div className="px-4 pb-4">
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 flex items-center justify-between">
            <p className="text-xs text-red-700">Delete Q{question.questionNum}?</p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="text-xs px-3 py-1 rounded-lg border border-slate-200 text-slate-600 hover:bg-white"
              >
                Cancel
              </button>
              <button
                onClick={() => { onDelete(); setShowDeleteConfirm(false); }}
                className="text-xs px-3 py-1 rounded-lg bg-red-500 text-white hover:bg-red-600"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
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
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [displaySrc, setDisplaySrc] = useState("");
  const [baseWidth, setBaseWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Measure available width on mount
  useEffect(() => {
    if (scrollRef.current) {
      setBaseWidth(scrollRef.current.clientWidth - 48);
    }
  }, []);

  // Pre-render image with rotation baked in — so selection maps directly to pixels
  useEffect(() => {
    setSelection(null);
    const src = pageImages[pageIndex];
    if (!src) return;

    const deg = ((rotation % 360) + 360) % 360;
    if (deg === 0) {
      setDisplaySrc(src);
      return;
    }

    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const c = document.createElement("canvas");
      const swap = deg === 90 || deg === 270;
      c.width = swap ? img.naturalHeight : img.naturalWidth;
      c.height = swap ? img.naturalWidth : img.naturalHeight;
      const ctx = c.getContext("2d")!;
      ctx.translate(c.width / 2, c.height / 2);
      ctx.rotate((deg * Math.PI) / 180);
      ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
      setDisplaySrc(c.toDataURL("image/jpeg", 0.92));
    };
    img.src = src;
  }, [pageImages, pageIndex, rotation]);

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

  // Crop directly from the displayed (already-rotated) image — no extra transform needed
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
      <div className="bg-slate-900 px-4 py-3 shrink-0 space-y-2">
        {/* Row 1: Page nav + confirm/close */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setPageIndex((i) => Math.max(0, i - 1))}
              disabled={pageIndex === 0}
              className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-700 disabled:opacity-30"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
            <span className="text-sm text-slate-300 tabular-nums">
              Page {pageIndex + 1} / {pageImages.length}
            </span>
            <button
              onClick={() => setPageIndex((i) => Math.min(pageImages.length - 1, i + 1))}
              disabled={pageIndex === pageImages.length - 1}
              className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-700 disabled:opacity-30"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          </div>
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
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Row 2: Zoom + Rotate controls */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500 mr-1">Zoom:</span>
          <button
            onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}
            className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-700"
            title="Zoom out"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /><path d="M8 11h6" />
            </svg>
          </button>
          <span className="text-xs text-slate-400 tabular-nums w-10 text-center">{Math.round(zoom * 100)}%</span>
          <button
            onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
            className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-700"
            title="Zoom in"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /><path d="M11 8v6" /><path d="M8 11h6" />
            </svg>
          </button>
          <div className="w-px h-5 bg-slate-700 mx-2" />
          <button
            onClick={() => setRotation((r) => r + 90)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-slate-700"
            title="Rotate 90°"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />
            </svg>
            <span className="text-xs">Rotate</span>
          </button>
        </div>
      </div>

      {/* Page + drag overlay */}
      <div ref={scrollRef} className="flex-1 overflow-auto p-2 sm:p-6">
        <div
          ref={containerRef}
          className="relative select-none cursor-crosshair mx-auto"
          style={{ width: baseWidth > 0 ? `${baseWidth * zoom}px` : "100%" }}
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
            src={displaySrc}
            alt={`Page ${pageIndex + 1}`}
            className="w-full block rounded shadow-lg"
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
