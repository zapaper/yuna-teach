"use client";

import {
  Suspense,
  useEffect,
  useState,
  use,
  useRef,
  useImperativeHandle,
  forwardRef,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ExamPaperDetail } from "@/types";
import QuestionCard from "@/components/QuestionCard";
import { renderPdfToImages } from "@/lib/pdf";
import { jsPDF } from "jspdf";

const PEN_CURSOR = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath d='M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z' fill='%232563eb' stroke='white' stroke-width='1.5' stroke-linejoin='round'/%3E%3C/svg%3E") 2 22, crosshair`;

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

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

// ─── Types ────────────────────────────────────────────────────────────────────

type DrawTool = "scroll" | "pen" | "eraser";

interface DrawablePageHandle {
  undo: () => void;
  clear: () => void;
  exportComposite: () => Promise<Blob>;
  exportInk: () => Promise<Blob>;
  loadInk: (blob: Blob) => void;
}

// ─── Main content ─────────────────────────────────────────────────────────────

function ExamPracticeContent({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId");
  const backPath = userId ? `/home/${userId}` : "/";

  const [paper, setPaper] = useState<ExamPaperDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageImages, setPageImages] = useState<string[]>([]);
  const [inkBlobs, setInkBlobs] = useState<(Blob | null)[]>([]);
  const [loadingPdf, setLoadingPdf] = useState(false);
  const [view, setView] = useState<"paper" | "questions">("paper");
  const [tool, setTool] = useState<DrawTool>("scroll");
  const [zoom, setZoom] = useState(1);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [submitStatus, setSubmitStatus] = useState<
    "idle" | "saving" | "submitting" | "submitted"
  >("idle");
  const [showAutoSaved, setShowAutoSaved] = useState(false);
  const [showSubmittedModal, setShowSubmittedModal] = useState(false);

  // ── Timer ──
  const [displaySeconds, setDisplaySeconds] = useState(0);
  const baseSeconds = useRef(0);       // timeSpentSeconds from DB
  const sessionStart = useRef<number | null>(null);

  const pageHandles = useRef<(DrawablePageHandle | null)[]>([]);
  const lastDrawnPage = useRef<number | null>(null);
  const hasUnsavedInk = useRef(false);
  const autoSaving = useRef(false);

  // Initialise base time once paper loads; sessionStart set later (after PDF renders)
  useEffect(() => {
    if (!paper) return;
    baseSeconds.current = paper.timeSpentSeconds ?? 0;
    setDisplaySeconds(baseSeconds.current);

    const interval = setInterval(() => {
      if (!sessionStart.current) return; // wait until PDF is ready
      const elapsed = Math.floor((Date.now() - sessionStart.current) / 1000);
      setDisplaySeconds(baseSeconds.current + elapsed);
    }, 1000);

    return () => clearInterval(interval);
  }, [paper?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auto-save every 5 minutes (silently, only if ink changed) ──
  useEffect(() => {
    const AUTO_SAVE_MS = 5 * 60 * 1000;
    const timer = setInterval(async () => {
      if (!hasUnsavedInk.current || autoSaving.current) return;
      autoSaving.current = true;
      try {
        const form = new FormData();
        form.append("action", "save");
        for (let i = 0; i < pageHandles.current.length; i++) {
          const handle = pageHandles.current[i];
          if (handle) {
            const [composite, ink] = await Promise.all([
              handle.exportComposite(),
              handle.exportInk(),
            ]);
            form.append(`page_${i}`, composite, `page_${i}.jpg`);
            form.append(`page_${i}_ink`, ink, `page_${i}_ink.png`);
          }
        }
        await fetch(`/api/exam/${id}/submission`, { method: "POST", body: form });
        hasUnsavedInk.current = false;
        setShowAutoSaved(true);
        setTimeout(() => setShowAutoSaved(false), 3000);
        console.log("[auto-save] Saved ink successfully");
      } catch (err) {
        console.warn("[auto-save] Failed:", err);
      } finally {
        autoSaving.current = false;
      }
    }, AUTO_SAVE_MS);
    return () => clearInterval(timer);
  }, [id]);

  // ── Warn before accidental page reload if unsaved ink ──
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (hasUnsavedInk.current) {
        e.preventDefault();
      }
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // ── Intercept browser back button: save ink + time, then navigate ──
  const backSaving = useRef(false);
  const submitStatusRef = useRef(submitStatus);
  submitStatusRef.current = submitStatus;

  useEffect(() => {
    // Push a single duplicate history entry so pressing back triggers popstate instead of leaving.
    // This effect must only run ONCE per mount — never re-run on state changes — otherwise
    // multiple pushState calls stack up and the back button gets stuck.
    window.history.pushState(null, "", window.location.href);

    function onPopState() {
      if (backSaving.current) return;
      if (submitStatusRef.current === "submitted" || !sessionStart.current) {
        router.replace(backPath);
        return;
      }
      backSaving.current = true;

      // Save ink + time in the background, then navigate
      (async () => {
        try {
          const form = new FormData();
          form.append("action", "save");
          for (let i = 0; i < pageHandles.current.length; i++) {
            const handle = pageHandles.current[i];
            if (handle) {
              const [composite, ink] = await Promise.all([
                handle.exportComposite(),
                handle.exportInk(),
              ]);
              form.append(`page_${i}`, composite, `page_${i}.jpg`);
              form.append(`page_${i}_ink`, ink, `page_${i}_ink.png`);
            }
          }
          await Promise.all([
            fetch(`/api/exam/${id}/submission`, { method: "POST", body: form }),
            saveTimeToServer(),
          ]);
        } catch (err) {
          console.warn("[back-button] Save failed:", err);
        } finally {
          backSaving.current = false;
          router.replace(backPath);
        }
      })();
    }

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function getCurrentTime() {
    if (!sessionStart.current) return baseSeconds.current;
    return baseSeconds.current + Math.floor((Date.now() - sessionStart.current) / 1000);
  }

  async function saveTimeToServer() {
    await fetch(`/api/exam/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeSpentSeconds: getCurrentTime() }),
    });
  }

  useEffect(() => {
    async function fetchPaper() {
      try {
        const res = await fetch(`/api/exam/${id}`);
        if (!res.ok) throw new Error("Not found");
        const data: ExamPaperDetail = await res.json();
        setPaper(data);
        if (data.completedAt) setSubmitStatus("submitted");
        if (data.pdfPath) {
          loadPdf(); // timer starts inside loadPdf when done
        } else {
          sessionStart.current = Date.now(); // no PDF — start timer immediately
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
      pageHandles.current = new Array(images.length).fill(null);

      // Always try to load previously saved ink (save & exit or submitted)
      const subRes = await fetch(`/api/exam/${id}/submission`);
      if (subRes.ok) {
        const sub = await subRes.json();
        if (sub.pageCount > 0) {
          const blobs = await Promise.all(
            Array.from({ length: sub.pageCount }, (_, i) =>
              fetch(`/api/exam/${id}/submission?page=${i}&type=ink`)
                .then((r) => (r.ok ? r.blob() : null))
                .catch(() => null)
            )
          );
          setInkBlobs(blobs);
        }
      }
    } catch (err) {
      console.warn("Could not load PDF:", err);
    } finally {
      setLoadingPdf(false);
      sessionStart.current = Date.now(); // start timer after PDF (and ink) are ready
    }
  }

  async function compositeAndUpload(action: "save" | "submit") {
    setSubmitStatus(action === "submit" ? "submitting" : "saving");
    try {
      const form = new FormData();
      form.append("action", action);
      for (let i = 0; i < displayPages.length; i++) {
        const handle = pageHandles.current[i];
        if (handle) {
          const [composite, ink] = await Promise.all([
            handle.exportComposite(),
            handle.exportInk(),
          ]);
          form.append(`page_${i}`, composite, `page_${i}.jpg`);
          form.append(`page_${i}_ink`, ink, `page_${i}_ink.png`);
        }
      }
      await Promise.all([
        fetch(`/api/exam/${id}/submission`, { method: "POST", body: form }),
        saveTimeToServer(),
      ]);
      hasUnsavedInk.current = false;
      if (action === "submit") {
        setPaper((prev) =>
          prev ? { ...prev, completedAt: new Date().toISOString() } : prev
        );
        setSubmitStatus("submitted");
        setShowSubmittedModal(true);
      } else {
        setSubmitStatus("idle");
      }
    } catch (err) {
      console.error("Submission failed:", err);
      setSubmitStatus("idle");
    }
  }

  async function handleSaveAndExit() {
    await compositeAndUpload("save");
    router.push(backPath);
  }

  async function handleSubmit() {
    await compositeAndUpload("submit");
    router.push(backPath);
  }

  function handleUndo() {
    if (lastDrawnPage.current !== null) {
      pageHandles.current[lastDrawnPage.current]?.undo();
    }
  }

  function clearAllInk() {
    pageHandles.current.forEach((h) => h?.clear());
  }

  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [downloadingExam, setDownloadingExam] = useState(false);
  const [uploadingPdf, setUploadingPdf] = useState(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const [reminderType, setReminderType] = useState<"scan" | "download" | null>(null);

  async function downloadSubmissionPdf() {
    if (!paper || downloadingPdf) return;
    setDownloadingPdf(true);
    try {
      const metaRes = await fetch(`/api/exam/${id}/submission`);
      const meta = await metaRes.json();
      const count = meta.pageCount ?? 0;
      if (count === 0) return;

      // Fetch each page and convert to data URL via canvas
      const pages: { dataUrl: string; w: number; h: number }[] = [];
      for (let i = 0; i < count; i++) {
        const res = await fetch(`/api/exam/${id}/submission?page=${i}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const el = new window.Image();
          el.onload = () => resolve(el);
          el.onerror = reject;
          el.src = url;
        });
        // Draw to canvas to get a stable data URL for jsPDF
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext("2d", { desynchronized: true })!.drawImage(img, 0, 0);
        pages.push({ dataUrl: canvas.toDataURL("image/jpeg", 0.92), w: img.naturalWidth, h: img.naturalHeight });
        URL.revokeObjectURL(url);
      }

      const first = pages[0];
      const pdf = new jsPDF({
        orientation: first.w > first.h ? "landscape" : "portrait",
        unit: "px",
        format: [first.w, first.h],
      });
      pdf.addImage(first.dataUrl, "JPEG", 0, 0, first.w, first.h);

      for (let i = 1; i < pages.length; i++) {
        const pg = pages[i];
        pdf.addPage([pg.w, pg.h], pg.w > pg.h ? "landscape" : "portrait");
        pdf.addImage(pg.dataUrl, "JPEG", 0, 0, pg.w, pg.h);
      }

      pdf.save(`${paper.title}.pdf`);
    } catch (err) {
      console.error("Download PDF failed:", err);
    } finally {
      setDownloadingPdf(false);
    }
  }

  async function downloadExamForPrinting() {
    if (!paper || downloadingExam || displayPages.length === 0) return;
    setDownloadingExam(true);
    try {
      const pages: { dataUrl: string; w: number; h: number }[] = [];
      for (const { src } of displayPages) {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const el = new window.Image();
          el.onload = () => resolve(el);
          el.onerror = reject;
          el.src = src;
        });
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d", { desynchronized: true })!;
        ctx.drawImage(img, 0, 0);
        const pxToMm = 25.4 / 150;
        pages.push({
          dataUrl: canvas.toDataURL("image/jpeg", 0.92),
          w: img.naturalWidth * pxToMm,
          h: img.naturalHeight * pxToMm,
        });
      }
      const first = pages[0];
      const pdf = new jsPDF({
        orientation: first.w > first.h ? "landscape" : "portrait",
        unit: "mm",
        format: [first.w, first.h],
      });
      pdf.addImage(first.dataUrl, "JPEG", 0, 0, first.w, first.h);
      for (let i = 1; i < pages.length; i++) {
        const pg = pages[i];
        pdf.addPage([pg.w, pg.h], pg.w > pg.h ? "landscape" : "portrait");
        pdf.addImage(pg.dataUrl, "JPEG", 0, 0, pg.w, pg.h);
      }
      pdf.save(`${paper.title} - Questions.pdf`);
    } catch (err) {
      console.error("Download exam failed:", err);
    } finally {
      setDownloadingExam(false);
    }
  }

  async function loadUploadedPdf(file: File) {
    if (!paper || uploadingPdf) return;
    setUploadingPdf(true);
    try {
      const images = await renderPdfToImages(file);
      // Replace displayed pages with uploaded PDF pages
      setPageImages(images);
      setInkBlobs([]); // clear any existing ink
      pageHandles.current = new Array(images.length).fill(null);
      setView("paper");
      setSubmitStatus("idle");
    } catch (err) {
      console.error("Upload PDF failed:", err);
    } finally {
      setUploadingPdf(false);
    }
  }

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
        <button onClick={() => router.push(backPath)} className="mt-4 text-primary-500 underline">
          Go Home
        </button>
      </div>
    );
  }

  const hiddenPageSet = new Set([
    ...(paper.metadata?.answerPages ?? []).map((p) => p - 1),
    ...(paper.metadata?.skipPages ?? []).map((p: number) => p - 1),
  ]);
  const displayPages = pageImages
    .map((src, i) => ({ src, originalIndex: i }))
    .filter(({ originalIndex }) => !hiddenPageSet.has(originalIndex));

  // Comprehension passage pages — displayed read-only just before open-ended section
  // These are NOT part of displayPages so they don't affect submission index mapping
  const passagePageImages = (paper.metadata?.passagePages ?? [])
    .map((p: number) => pageImages[p - 1])
    .filter(Boolean) as string[];
  const firstOpenEndedOriginalIndex = paper.questions
    .filter(q => q.syllabusTopic === "Comprehension (Open-ended)")
    .map(q => q.pageIndex)
    .sort((a, b) => a - b)[0] ?? -1;
  const passageInsertBeforeDisplayIndex = passagePageImages.length === 0 ? -1
    : firstOpenEndedOriginalIndex === -1 ? -1
    : displayPages.findIndex(({ originalIndex }) => originalIndex >= firstOpenEndedOriginalIndex);

  const hasPdf = displayPages.length > 0;
  const questions = paper.questions;
  const isBusy = submitStatus === "saving" || submitStatus === "submitting";

  return (
    <div className="min-h-screen bg-white select-none" style={{ overscrollBehavior: "none", WebkitTouchCallout: "none", WebkitUserSelect: "none" }}>
      {/* ── Fixed header + drawing toolbar — pinned to top of viewport for iPad compatibility ── */}
      <div className="fixed top-0 left-0 right-0 z-50 bg-white shadow-md">
        <div className="border-b border-slate-100 px-4 py-2 flex items-center gap-2">
          <button
            onClick={handleSaveAndExit}
            disabled={isBusy}
            className="p-1.5 -ml-1 rounded-lg text-slate-500 hover:text-slate-700 hover:bg-slate-100 shrink-0 disabled:opacity-50"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>

          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-slate-800 truncate">{paper.title}</p>
            <div className="flex items-center gap-1.5">
              {paper.subject ? (
                <span className="text-[10px] font-medium px-1.5 rounded-full bg-purple-100 text-purple-700">
                  {paper.subject}
                </span>
              ) : null}
              {paper.level ? (
                <span className="text-[10px] font-medium px-1.5 rounded-full bg-green-100 text-green-700">
                  {paper.level}
                </span>
              ) : null}
            </div>
          </div>

          {/* Timer */}
          <div className="flex items-center gap-1 px-2.5 py-1 rounded-xl bg-slate-100 text-slate-600 text-xs font-mono font-semibold shrink-0">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
            </svg>
            {formatTime(displaySeconds)}
          </div>

          {showAutoSaved ? (
            <span className="text-[10px] font-medium text-green-500 shrink-0 animate-pulse">Auto-saved</span>
          ) : null}

          {hasPdf ? (
            <div className="flex rounded-xl border border-slate-200 overflow-hidden shrink-0 text-xs font-medium">
              <button onClick={() => setView("paper")}
                className={`px-3 py-1.5 ${view === "paper" ? "bg-primary-500 text-white" : "text-slate-500 hover:bg-slate-50"}`}>
                Paper
              </button>
              <button onClick={() => setView("questions")}
                className={`px-3 py-1.5 ${view === "questions" ? "bg-primary-500 text-white" : "text-slate-500 hover:bg-slate-50"}`}>
                Q&A
              </button>
            </div>
          ) : null}

          {submitStatus !== "submitted" ? (
            <button
              onClick={handleSubmit}
              disabled={isBusy}
              className="px-3 py-1.5 rounded-xl bg-green-500 text-white text-xs font-semibold hover:bg-green-600 disabled:opacity-50 transition-colors shrink-0"
            >
              {submitStatus === "submitting" ? "Submitting…" : "Submit"}
            </button>
          ) : null}
        </div>

        {/* Drawing toolbar */}
        {hasPdf && view === "paper" && (
          <div className="bg-white border-b border-slate-200 px-4 py-1.5 flex items-center gap-2"
            style={{ userSelect: "none", WebkitUserSelect: "none" }}>
            <ToolButton active={tool === "scroll"} onClick={() => setTool("scroll")} title="Scroll">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8L22 12L18 16M2 12H22" />
              </svg>
              Scroll
            </ToolButton>
            <ToolButton active={tool === "pen"} onClick={() => setTool("pen")} title="Pen"
              activeClass="bg-blue-100 text-blue-700 border-blue-300">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
              </svg>
              Pen
            </ToolButton>
            <ToolButton active={tool === "eraser"} onClick={() => setTool("eraser")} title="Eraser">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21M22 21H7M5 11l9 9" />
              </svg>
              Eraser
            </ToolButton>
            <div className="w-px h-5 bg-slate-200 mx-0.5" />
            <button onClick={handleUndo} title="Undo"
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl border border-slate-200 text-xs font-medium text-slate-500 hover:bg-slate-50 transition-colors">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7v6h6" /><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
              </svg>
              Undo
            </button>
            <div className="flex-1" />
            <div className="w-px h-5 bg-slate-200 mx-0.5" />
            <button onClick={() => setZoom((z) => Math.max(1, z - 0.25))}
              className="px-2 py-1.5 rounded-xl border border-slate-200 text-xs font-bold text-slate-500 hover:bg-slate-50 transition-colors leading-none">
              −
            </button>
            <span className="text-[10px] font-medium text-slate-400 min-w-[2.5rem] text-center">{Math.round(zoom * 100)}%</span>
            <button onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
              className="px-2 py-1.5 rounded-xl border border-slate-200 text-xs font-bold text-slate-500 hover:bg-slate-50 transition-colors leading-none">
              +
            </button>
          </div>
        )}
      </div>
      {/* Spacer to push content below the fixed header */}
      <div style={{ height: hasPdf && view === "paper" ? 88 : 52 }} />

      {/* ── PDF loading ── */}
      {loadingPdf ? (
        <div className="flex items-center gap-2 px-4 py-2 bg-blue-50 border-b border-blue-100 text-xs text-blue-600">
          <span className="animate-spin rounded-full h-3.5 w-3.5 border-2 border-blue-200 border-t-blue-500 shrink-0 inline-block" />
          <span>Loading exam paper…</span>
        </div>
      ) : null}

      {/* ── Paper drawing view ── */}
      {hasPdf && view === "paper" ? (
        <div style={{
          width: "100vw",
          marginLeft: "calc(50% - 50vw)",
          transform: zoom !== 1 ? `scale(${zoom})` : undefined,
          transformOrigin: "top center",
        }}>
          {/* Submitted banner */}
          {submitStatus === "submitted" ? (
            <div className="flex items-center gap-2 px-4 py-2 bg-green-50 border-b border-green-200 text-xs text-green-700">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
              <span className="flex-1">
                Submitted{paper.completedAt ? ` on ${new Date(paper.completedAt).toLocaleDateString()}` : ""}
              </span>
              <button onClick={downloadSubmissionPdf} disabled={downloadingPdf}
                className="text-green-600 font-medium hover:text-green-800 transition-colors disabled:opacity-50">
                {downloadingPdf ? "Downloading…" : "Download PDF"}
              </button>
            </div>
          ) : null}

          {/* ── Action bar (moved to top to avoid accidental taps) ── */}
          <div
            className="bg-white border-b border-slate-200 px-4 py-3 flex flex-col gap-2"
            style={{ userSelect: "none", WebkitUserSelect: "none" }}
          >
            <div className="flex items-center gap-3">
              <button
                onClick={handleSaveAndExit}
                disabled={isBusy}
                className="flex-1 py-2.5 rounded-xl border-2 border-slate-300 text-slate-600 text-sm font-medium hover:bg-slate-50 disabled:opacity-50 transition-colors"
              >
                {submitStatus === "saving" ? "Saving…" : "Save & exit"}
              </button>
              <button
                onClick={handleSubmit}
                disabled={isBusy}
                className="flex-1 py-2.5 rounded-xl bg-green-500 text-white text-sm font-semibold hover:bg-green-600 disabled:opacity-50 transition-colors"
              >
                {submitStatus === "submitting"
                  ? "Submitting…"
                  : submitStatus === "submitted"
                  ? "Resubmit"
                  : "Submit exam"}
              </button>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setReminderType("download")}
                disabled={downloadingExam}
                className="flex-1 py-2 rounded-xl border border-dashed border-slate-300 text-slate-500 text-xs font-medium hover:bg-slate-50 hover:border-primary-300 hover:text-primary-600 disabled:opacity-50 transition-colors"
              >
                {downloadingExam ? "Downloading…" : "Download for printing"}
              </button>
              <button
                onClick={() => setReminderType("scan")}
                disabled={uploadingPdf}
                className="flex-1 py-2 rounded-xl border border-dashed border-slate-300 text-slate-500 text-xs font-medium hover:bg-slate-50 hover:border-primary-300 hover:text-primary-600 disabled:opacity-50 transition-colors"
              >
                {uploadingPdf ? "Loading PDF…" : "Upload scanned PDF"}
              </button>
            </div>
            <p className="text-center text-[10px] text-slate-400">
              Use <span className="font-semibold text-blue-500">blue ink</span> for hand-written answers so AI can distinguish your writing from printed text.
            </p>
            <p className="text-center text-[10px] text-slate-300 italic">
              For Apple users: turn on &quot;Draw with Apple Pencil&quot; and turn off &quot;Scribble&quot; for smooth writing.
            </p>
          </div>

          {/* PDF pages */}
          <div className="divide-y divide-slate-100">
            {displayPages.map(({ src }, displayIndex) => (
              <div key={displayIndex}>
                {/* Inject comprehension passage pages just before the open-ended section */}
                {passageInsertBeforeDisplayIndex === displayIndex && passagePageImages.map((imgSrc, pi) => (
                  <div key={`passage-${pi}`} className="relative border-b border-blue-100">
                    <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-blue-500 text-white text-[10px] font-semibold px-3 py-0.5 rounded-full z-10 shadow-sm whitespace-nowrap pointer-events-none">
                      Comprehension Passage (Reference)
                    </div>
                    <img src={imgSrc} className="w-full block" alt={`Comprehension passage ${pi + 1}`} draggable={false} />
                  </div>
                ))}
                <DrawablePage
                  ref={(el) => { pageHandles.current[displayIndex] = el; }}
                  imageUrl={src}
                  tool={tool}
                  inkBlob={inkBlobs[displayIndex] ?? undefined}
                  onStrokeStart={() => { lastDrawnPage.current = displayIndex; hasUnsavedInk.current = true; }}
                />
              </div>
            ))}
            {/* If no open-ended questions detected, append passage at end */}
            {passagePageImages.length > 0 && passageInsertBeforeDisplayIndex === -1 && passagePageImages.map((imgSrc, pi) => (
              <div key={`passage-end-${pi}`} className="relative border-b border-blue-100">
                <div className="absolute top-2 left-1/2 -translate-x-1/2 bg-blue-500 text-white text-[10px] font-semibold px-3 py-0.5 rounded-full z-10 shadow-sm whitespace-nowrap pointer-events-none">
                  Comprehension Passage (Reference)
                </div>
                <img src={imgSrc} className="w-full block" alt={`Comprehension passage ${pi + 1}`} draggable={false} />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* ── Question cards ── */}
      {(view === "questions" || !hasPdf) && !loadingPdf ? (
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
              onNext={() => setCurrentIndex((i) => Math.min(questions.length - 1, i + 1))}
            />
          )}
        </div>
      ) : null}

      {/* Reminder modal */}
      {reminderType && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-6">
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-xl">
            <p className="text-slate-800 font-semibold text-base mb-3">
              {reminderType === "scan" ? "Before you upload" : "Before you print"}
            </p>
            <p className="text-slate-600 text-sm leading-relaxed">
              {reminderType === "scan"
                ? "Please make sure you scan every page, including cover pages, and answers are written in blue ink."
                : "Please make sure you write in blue ink."}
            </p>
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => setReminderType(null)}
                className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-500 text-sm font-medium hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (reminderType === "scan") uploadInputRef.current?.click();
                  else downloadExamForPrinting();
                  setReminderType(null);
                }}
                className="flex-1 py-2.5 rounded-xl bg-primary-500 text-white text-sm font-semibold hover:bg-primary-600 transition-colors"
              >
                OK, got it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hidden file input for PDF upload */}
      <input
        ref={uploadInputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) loadUploadedPdf(f);
          e.target.value = "";
        }}
      />

      {/* ── Submitted modal ── */}
      {showSubmittedModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl px-8 py-7 mx-4 max-w-sm w-full flex flex-col items-center gap-4">
            <div className="flex items-center justify-center w-14 h-14 rounded-full bg-green-100">
              <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                className="text-green-500">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </div>
            <div className="text-center">
              <h2 className="text-lg font-bold text-slate-800">Submitted!</h2>
              <p className="text-sm text-slate-500 mt-1">Your exam has been submitted successfully.</p>
            </div>
            <div className="flex gap-3 w-full mt-1">
              <button
                onClick={() => { setShowSubmittedModal(false); router.push(backPath); }}
                className="flex-1 py-2.5 rounded-xl border-2 border-slate-300 text-slate-600 text-sm font-medium hover:bg-slate-50 transition-colors"
              >
                Exit
              </button>
              <button
                onClick={() => setShowSubmittedModal(false)}
                className="flex-1 py-2.5 rounded-xl bg-green-500 text-white text-sm font-semibold hover:bg-green-600 transition-colors"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Tool button ──────────────────────────────────────────────────────────────

function ToolButton({
  active, onClick, title,
  activeClass = "bg-primary-100 text-primary-700 border-primary-300",
  children,
}: {
  active: boolean; onClick: () => void; title: string;
  activeClass?: string; children: React.ReactNode;
}) {
  return (
    <button onClick={onClick} title={title}
      className={`flex items-center gap-1 px-2.5 py-1.5 rounded-xl border text-xs font-medium transition-colors ${
        active ? activeClass : "border-slate-200 text-slate-500 hover:bg-slate-50"
      }`}>
      {children}
    </button>
  );
}

// ─── Drawable PDF page ────────────────────────────────────────────────────────

const DrawablePage = forwardRef<
  DrawablePageHandle,
  { imageUrl: string; tool: DrawTool; inkBlob?: Blob; onStrokeStart: () => void }
>(function DrawablePage({ imageUrl, tool, inkBlob, onStrokeStart }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const isDrawing = useRef(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const history = useRef<ImageData[]>([]);
  const inkApplied = useRef(false);

  useImperativeHandle(ref, () => ({
    undo() {
      const canvas = canvasRef.current;
      if (!canvas || history.current.length === 0) return;
      canvas.getContext("2d", { desynchronized: true })!.putImageData(history.current.pop()!, 0, 0);
    },
    clear() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.getContext("2d", { desynchronized: true })?.clearRect(0, 0, canvas.width, canvas.height);
      history.current = [];
    },
    exportComposite(): Promise<Blob> {
      return new Promise((resolve, reject) => {
        const inkCanvas = canvasRef.current;
        const imgEl = imgRef.current;
        if (!inkCanvas || !imgEl || !imgEl.complete) { reject(new Error("Not ready")); return; }
        const composite = document.createElement("canvas");
        composite.width = inkCanvas.width || imgEl.naturalWidth;
        composite.height = inkCanvas.height || imgEl.naturalHeight;
        const ctx = composite.getContext("2d")!;
        ctx.drawImage(imgEl, 0, 0, composite.width, composite.height);
        if (inkCanvas.width > 0) ctx.drawImage(inkCanvas, 0, 0);
        composite.toBlob(
          (blob) => blob ? resolve(blob) : reject(new Error("Export failed")),
          "image/jpeg", 0.88
        );
      });
    },
    exportInk(): Promise<Blob> {
      return new Promise((resolve, reject) => {
        const canvas = canvasRef.current;
        if (!canvas) { reject(new Error("Not ready")); return; }
        canvas.toBlob(
          (blob) => blob ? resolve(blob) : reject(new Error("Export failed")),
          "image/png"
        );
      });
    },
    loadInk(blob: Blob) {
      applyInkBlob(blob);
    },
  }));

  function applyInkBlob(blob: Blob) {
    const canvas = canvasRef.current;
    if (!canvas || canvas.width === 0) return; // not initialized yet
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      canvas.getContext("2d", { desynchronized: true })?.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }

  function initCanvas(imgEl: HTMLImageElement) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = imgEl.naturalWidth;
    canvas.height = imgEl.naturalHeight;
    // Apply pending ink blob if not yet applied
    if (inkBlob && !inkApplied.current) {
      inkApplied.current = true;
      applyInkBlob(inkBlob);
    }
  }

  // Also apply when inkBlob arrives after canvas is already initialized
  useEffect(() => {
    if (inkBlob && !inkApplied.current && canvasRef.current?.width) {
      inkApplied.current = true;
      applyInkBlob(inkBlob);
    }
  }, [inkBlob]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cache bounding rect — avoids forced layout reflow on every pointer event
  const cachedRect = useRef<DOMRect | null>(null);
  function invalidateRect() { cachedRect.current = null; }

  function getPos(clientX: number, clientY: number) {
    const canvas = canvasRef.current!;
    if (!cachedRect.current) cachedRect.current = canvas.getBoundingClientRect();
    const rect = cachedRect.current;
    return {
      x: (clientX - rect.left) * (canvas.width / rect.width),
      y: (clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  // Invalidate cached rect on scroll/resize
  useEffect(() => {
    window.addEventListener("scroll", invalidateRect, true);
    window.addEventListener("resize", invalidateRect);
    return () => {
      window.removeEventListener("scroll", invalidateRect, true);
      window.removeEventListener("resize", invalidateRect);
    };
  }, []);

  function saveSnapshot() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { desynchronized: true })!;
    history.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (history.current.length > 30) history.current.shift();
  }

  // Debounced snapshot: only captures after 300ms idle, never between rapid strokes
  const pendingSnapshot = useRef<ImageData | null>(null);
  const snapshotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function cancelPendingCapture() {
    if (snapshotTimer.current) {
      clearTimeout(snapshotTimer.current);
      snapshotTimer.current = null;
    }
  }

  function scheduleSnapshotCapture() {
    cancelPendingCapture();
    snapshotTimer.current = setTimeout(() => {
      snapshotTimer.current = null;
      const canvas = canvasRef.current;
      if (!canvas) return;
      pendingSnapshot.current = canvas.getContext("2d", { desynchronized: true })!.getImageData(0, 0, canvas.width, canvas.height);
    }, 300);
  }

  // Store tool and onStrokeStart in refs so native listeners always see latest values
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const onStrokeStartRef = useRef(onStrokeStart);
  onStrokeStartRef.current = onStrokeStart;

  // Stable native event listeners — attached once, never re-attached
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Get a cached 2D context once — avoids repeated getContext calls
    const ctx = canvas.getContext("2d", { desynchronized: true })!;

    function applyStyle() {
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      if (toolRef.current === "eraser") {
        ctx.globalCompositeOperation = "destination-out";
        ctx.strokeStyle = "rgba(0,0,0,1)";
        ctx.lineWidth = 24;
      } else {
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = "rgba(37,99,235,0.85)";
        ctx.lineWidth = 3;
      }
    }

    function handlePointerDown(e: PointerEvent) {
      if (toolRef.current === "scroll") return;
      e.preventDefault();
      // Cancel any pending snapshot immediately
      cancelPendingCapture();
      onStrokeStartRef.current();
      isDrawing.current = true;
      if (pendingSnapshot.current) {
        history.current.push(pendingSnapshot.current);
        if (history.current.length > 30) history.current.shift();
        pendingSnapshot.current = null;
      } else if (history.current.length === 0) {
        saveSnapshot();
      }
      const pos = getPos(e.clientX, e.clientY);
      lastPos.current = pos;
      applyStyle();
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, toolRef.current === "eraser" ? 12 : 1.5, 0, Math.PI * 2);
      ctx.fill();
    }

    function handlePointerMove(e: PointerEvent) {
      if (!isDrawing.current || !lastPos.current) return;
      e.preventDefault();
      const pos = getPos(e.clientX, e.clientY);
      applyStyle();
      ctx.beginPath();
      ctx.moveTo(lastPos.current.x, lastPos.current.y);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
      lastPos.current = pos;
    }

    function handlePointerUp() {
      if (!isDrawing.current) return;
      isDrawing.current = false;
      lastPos.current = null;
      scheduleSnapshotCapture();
    }

    function handleContextMenu(e: Event) {
      e.preventDefault();
    }

    canvas.addEventListener("pointerdown", handlePointerDown, { passive: false });
    canvas.addEventListener("pointermove", handlePointerMove, { passive: false });
    canvas.addEventListener("pointerup", handlePointerUp);
    canvas.addEventListener("pointercancel", handlePointerUp);
    canvas.addEventListener("contextmenu", handleContextMenu);

    return () => {
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerup", handlePointerUp);
      canvas.removeEventListener("pointercancel", handlePointerUp);
      canvas.removeEventListener("contextmenu", handleContextMenu);
      cancelPendingCapture();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const drawing = tool !== "scroll";

  return (
    <div className="relative"
      style={{ touchAction: drawing ? "none" : "auto", userSelect: "none", WebkitUserSelect: "none" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img ref={imgRef} src={imageUrl} alt="Exam page" className="w-full h-auto block"
        style={{ pointerEvents: "none", display: "block" }}
        onLoad={(e) => initCanvas(e.currentTarget)} draggable={false} />
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full"
        style={{
          pointerEvents: drawing ? "auto" : "none",
          touchAction: "none",
          cursor: tool === "pen" ? PEN_CURSOR : tool === "eraser" ? "cell" : "default",
        }}
      />
    </div>
  );
});
