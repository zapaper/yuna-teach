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
import AdminNav from "@/components/AdminNav";
import { formatQNum } from "@/lib/format";

export default function EnglishNormalExtractPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <Suspense>
      <EnglishNormalExtractContent id={id} />
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

function EnglishNormalExtractContent({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";

  const [paper, setPaper] = useState<ExamPaperDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pageImages, setPageImages] = useState<string[]>([]);
  const [loadingPdf, setLoadingPdf] = useState(false);
  const [selectTarget, setSelectTarget] = useState<SelectTarget | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [taggingSyllabus, setTaggingSyllabus] = useState(false);
  const [savingClean, setSavingClean] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchPaper = useCallback(async () => {
    try {
      const [paperRes, difficultyRes] = await Promise.all([
        fetch(`/api/exam/${id}`),
        // Admin-only endpoint — non-admins get 403, which we treat as "no
        // empirical data" and proceed. The visible UI badge also hides for
        // non-admins via the requesterIsAdmin flag on the paper.
        fetch(`/api/admin/question-difficulty?paperId=${id}`).catch(() => null),
      ]);
      if (!paperRes.ok) throw new Error("Not found");
      const data: ExamPaperDetail = await paperRes.json();
      // Merge empirical difficulty into the question rows when available.
      if (difficultyRes && difficultyRes.ok) {
        const dd = await difficultyRes.json() as { questions: Record<string, { empiricalDifficulty: number | null; attempts: number }> };
        data.questions = data.questions.map(q => {
          const m = dd.questions[q.questionNum];
          if (!m) return q;
          return { ...q, empiricalDifficulty: m.empiricalDifficulty, empiricalAttempts: m.attempts };
        });
      }
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

  // Scroll to the question targeted by the URL hash (e.g. #q-abc123 when
  // arriving from the Flagged Q&A page). Runs once paper.questions renders.
  useEffect(() => {
    if (!paper?.questions?.length) return;
    const hash = typeof window !== "undefined" ? window.location.hash : "";
    if (!hash.startsWith("#q-")) return;
    // Allow one paint so the target node exists.
    const t = setTimeout(() => {
      const el = document.getElementById(hash.slice(1));
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        el.style.transition = "box-shadow 0.6s ease-out";
        el.style.boxShadow = "0 0 0 4px rgba(0, 108, 73, 0.35)";
        setTimeout(() => { el.style.boxShadow = ""; }, 2000);
      }
    }, 150);
    return () => clearTimeout(t);
  }, [paper?.questions]);

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
    setSaveError(null);
    try {
      const res = await fetch(`/api/exam/questions/${questionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setSaveError(`Save failed (${res.status}): ${errData.error ?? "Unknown error"}`);
        return;
      }
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
    } catch (err) {
      setSaveError(`Save failed: ${err instanceof Error ? err.message : "Network error"}`);
    } finally {
      setSaving(null);
    }
  }

  async function deleteQuestion(questionId: string) {
    // Actually delete the question from the database
    await fetch(`/api/exam/questions/${questionId}`, {
      method: "DELETE",
    });
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
      syllabusTopic: newQ.syllabusTopic as string | null ?? null,
      studentAnswer: newQ.studentAnswer as string | null ?? null,
      transcribedStem: newQ.transcribedStem as string | null ?? null,
      transcribedOptions: newQ.transcribedOptions as string[] | null ?? null,
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

  async function tagSyllabus() {
    if (!paper || taggingSyllabus) return;
    setTaggingSyllabus(true);
    try {
      const res = await fetch(`/api/exam/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "tagSyllabus" }),
      });
      if (!res.ok) return;
      const { tags } = await res.json() as { tags: Record<string, string | null> };
      setPaper((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          questions: prev.questions.map((q) =>
            q.questionNum in tags ? { ...q, syllabusTopic: tags[q.questionNum] } : q
          ),
        };
      });
    } finally {
      setTaggingSyllabus(false);
    }
  }

  async function saveCleanQuestions() {
    if (!paper || savingClean) return;
    setSavingClean(true);
    try {
      // Fetch fresh paper data to avoid using stale state (e.g. after deleting questions)
      const freshRes = await fetch(`/api/exam/${id}`);
      const freshPaper: ExamPaperDetail = await freshRes.json();
      const metadata = freshPaper.metadata;
      const ocrTexts = metadata?.sectionOcrTexts ?? {};

      for (const q of freshPaper.questions) {
        const topic = q.syllabusTopic ?? "";
        const topicLower = topic.toLowerCase();
        const sectionOcr = ocrTexts[topic];

        // Determine what to save based on section type
        const isStandalone = topicLower.includes("grammar mcq") || topicLower.includes("vocabulary mcq") || topicLower.includes("synthesis");
        const isPassageBound = topicLower.includes("grammar cloze") || topicLower.includes("editing") || topicLower.includes("comprehension cloze") || topicLower.includes("vocabulary cloze mcq") || (topicLower.includes("comprehension") && topicLower.includes("open"));
        const isVisualText = topicLower.includes("visual text");

        // Build transcribedSubparts to store passage reference
        const subparts: Array<{ label: string; text: string; diagramBase64?: string | null }> = [];

        if (isPassageBound && sectionOcr?.ocrText) {
          // Store the passage OCR as a sentinel subpart
          subparts.push({ label: "_passage", text: sectionOcr.ocrText });
        }

        if (isPassageBound && sectionOcr?.passageOcrText) {
          // Store the line-numbered passage for Comp OEQ
          subparts.push({ label: "_passageText", text: sectionOcr.passageOcrText });
        }

        if (isVisualText && sectionOcr?.passagePageIndices) {
          // Store visual page indices as sentinel
          subparts.push({ label: "_visualPages", text: JSON.stringify(sectionOcr.passagePageIndices) });
        }

        // Save the question with clean extract data
        const data: Record<string, unknown> = {};

        if (q.transcribedStem) {
          data.transcribedStem = q.transcribedStem;
        }
        if (q.transcribedOptions) {
          data.transcribedOptions = q.transcribedOptions;
        }
        if (subparts.length > 0) {
          data.transcribedSubparts = subparts;
        }

        // Only PATCH if there's something to save
        if (Object.keys(data).length > 0) {
          await fetch(`/api/exam/questions/${q.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
          });
        }
      }

      // Deduplicate: remove blank duplicate questions (same questionNum + syllabusTopic)
      const seen = new Map<string, string>();
      for (const q of freshPaper.questions) {
        const key = `${q.questionNum}:${q.syllabusTopic ?? ""}`;
        if (seen.has(key)) {
          // Keep the one with transcribedStem, delete the blank one
          if (!q.transcribedStem?.trim()) {
            await fetch(`/api/exam/questions/${q.id}`, { method: "DELETE" });
          }
        } else {
          seen.set(key, q.id);
        }
      }

      // Mark paper as clean-extracted
      await fetch(`/api/exam/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extractionStatus: "ready" }),
      });

      // Clear any AI audit flags — admin has reviewed the Q&A
      await fetch(`/api/exam/${id}/audit-qa`, { method: "DELETE" }).catch(() => {});

      await fetchPaper();
      alert("Clean questions saved successfully!");
    } catch (err) {
      console.error("Save clean questions failed:", err);
      alert("Failed to save clean questions.");
    } finally {
      setSavingClean(false);
    }
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
      const MAX_W = 1200;
      const outW = Math.min(natW, MAX_W);
      const outH = Math.round((cropBottom - cropTop) * (outW / natW));
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, cropTop, natW, cropBottom - cropTop, 0, 0, outW, outH);
      const newImageData = canvas.toDataURL("image/jpeg", 0.78);

      // Save cropped image + updated coordinates + page
      const updates: Record<string, unknown> = {
        imageData: newImageData,
        yStartPct: result.yStartPct,
        yEndPct: result.yEndPct,
      };
      if (actualPage !== pageIdx) updates.pageIndex = actualPage;

      const saveRes = await fetch(`/api/exam/questions/${questionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });
      if (!saveRes.ok) {
        const errData = await saveRes.json().catch(() => ({}));
        setSaveError(`Redo save failed (${saveRes.status}): ${errData.error ?? "Unknown error"}`);
        return;
      }
      setPaper((prev) =>
        prev
          ? {
              ...prev,
              questions: prev.questions.map((qq) =>
                qq.id === questionId
                  ? { ...qq, imageData: newImageData, yStartPct: result.yStartPct, yEndPct: result.yEndPct, pageIndex: actualPage }
                  : qq
              ),
            }
          : prev
      );
    } catch (err) {
      setSaveError(`Redo failed: ${err instanceof Error ? err.message : "Network error"}`);
    } finally {
      setSaving(null);
    }
  }

  const subjectLower = (paper?.subject || "").toLowerCase();
  const subjectRaw = paper?.subject || "";
  const isMathPaper = subjectLower.includes("math");
  const isEnglishPaper = subjectLower.includes("english");
  const isChinesePaper = subjectLower.includes("chinese") || subjectRaw.includes("华文") || subjectRaw.includes("中文") || subjectRaw.includes("华语");
  // Audit flags intentionally NOT surfaced here. They live on the
  // BASIC edit page (/exam/[id]/edit) only — by the time the admin
  // reaches normal-extract they've already reviewed and corrected
  // anything the AI flagged. Re-displaying here is noisy and almost
  // always stale.
  // The /edit section-grouped view applies to BOTH English and
  // Chinese — same data shape (sectionOcrTexts keyed by section name,
  // questions with syllabusTopic), same renderer. Forking later if
  // 华文 needs UI tweaks; for now share EnglishEditView so the user
  // sees section headers + grouped questions.
  const isSectionedPaper = isEnglishPaper || isChinesePaper;
  const isTaggablePaper = isMathPaper || subjectLower.includes("science") || isEnglishPaper || isChinesePaper;
  // Back path: prefer ?userId= when present so the overview stays
  // scoped to the same admin/view-as session, but drop the empty
  // param when it's missing — bare /exam/[id]/overview keeps the
  // overview page from bouncing to an "unknown user" home route.
  const backPath = userId ? `/exam/${id}/overview?userId=${userId}` : `/exam/${id}/overview`;

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

  // English-only guard. /normal-extract is the language-isolated copy
  // of /edit; if a non-English paper ends up here, bounce to /edit
  // (the canonical multi-subject page).
  if (!(paper.subject ?? "").toLowerCase().includes("english")) {
    return (
      <div className="p-6 text-center py-24">
        <p className="text-slate-500">Normal Extract is English-only. This paper is &ldquo;{paper.subject}&rdquo;.</p>
        <button
          onClick={() => router.push(`/exam/${id}/edit${userId ? `?userId=${userId}` : ""}`)}
          className="mt-4 text-primary-500 underline"
        >
          Open /edit
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {userId && <AdminNav userId={userId} />}
      {/* Fallback model warning */}
      {(() => {
        const fb = (paper.metadata as Record<string, unknown> | null)?.fallbackModelUsed;
        if (!fb) return null;
        return (
        <div className="lg:ml-56 px-6 pt-4">
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3 max-w-2xl mx-auto">
            <span className="material-symbols-outlined text-amber-600 shrink-0 mt-0.5">warning</span>
            <div>
              <p className="text-sm font-bold text-amber-800">Backup AI model was used for extraction</p>
              <p className="text-xs text-amber-600 mt-1">The primary model was unavailable due to high demand. A backup model ({String(fb)}) was used instead. Results may be less accurate — please review carefully and re-extract if needed.</p>
            </div>
          </div>
        </div>
        );
      })()}
      <div className="lg:ml-56 pb-24 lg:pb-0 p-6 max-w-2xl mx-auto">
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

      {/* Save error banner */}
      {saveError && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 mb-4 flex items-center justify-between gap-3">
          <p className="text-sm text-red-600">{saveError}</p>
          <button onClick={() => setSaveError(null)} className="text-red-400 hover:text-red-600 shrink-0">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </div>
      )}

      {/* PDF loader */}
      <PdfLoader
        loaded={pageImages.length > 0}
        loading={loadingPdf}
        onFile={handlePdfLoad}
      />

      {/* Per-section "Normal Extract" trigger row. Re-runs the
          gemini-3.1-pro-preview bounds extractor for one section at a
          time; on success, refetches the paper so the per-question
          QuestionEditCard list below picks up the new yStartPct /
          yEndPct (and x bounds for Booklet B sections). Useful when
          the initial Booklet-A extraction was sloppy and individual
          questions don't crop right. */}
      <NormalExtractTriggerRow
        paperId={id}
        state={(paper.metadata as { normalExtractEnglish?: Record<string, unknown> } | null)?.normalExtractEnglish ?? {}}
        onExtracted={fetchPaper}
      />

      {/* /normal-extract intentionally forces the per-question card
          path even for English papers. The /edit page switches English
          papers to the section-based EnglishEditView; this page does
          NOT — the whole point is to mirror the math/science Normal
          Extract layout (QuestionEditCard with crop + Redo extract +
          Select area + Delete + Add question). EnglishEditView is
          still reachable from /edit if needed. */}
      <div className="space-y-4 mt-5">
        {paper.questions.map((q) => (
          <div key={q.id} id={`q-${q.id}`}>
          <QuestionEditCard
            key={q.id}
            paperId={id}
            question={q}
            saving={saving?.startsWith(q.id) ? saving.slice(q.id.length) as keyof ExamQuestionItem | "redo" : null}
            pdfLoaded={pageImages.length > 0}
            syllabusTopics={isTaggablePaper ? (isMathPaper ? P6_MATH_TOPICS : isEnglishPaper ? ENGLISH_TOPICS : isChinesePaper ? CHINESE_TOPICS : SCIENCE_TOPICS) : null}
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
          </div>
        ))}
      </div>

      {/* Save Clean Questions — English only */}
      {isEnglishPaper && paper.metadata?.sectionOcrTexts && (
        <div className="mt-4">
          <button
            onClick={saveCleanQuestions}
            disabled={savingClean}
            className="w-full py-3 rounded-2xl bg-[#003366] text-white font-bold hover:bg-[#001e40] transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {savingClean ? (
              <>
                <span className="animate-spin rounded-full h-4 w-4 border-2 border-white/30 border-t-white inline-block" />
                Saving...
              </>
            ) : (
              <>
                <span className="material-symbols-outlined text-lg">save</span>
                Save Clean Questions
              </>
            )}
          </button>
        </div>
      )}

      {/* Add question + Tag syllabus buttons */}
      <div className="flex gap-3 mt-4">
        <button
          onClick={addQuestion}
          className="flex-1 py-3 rounded-2xl border-2 border-dashed border-slate-300 text-slate-500 font-medium hover:border-primary-300 hover:text-primary-600 transition-colors"
        >
          + Add Question
        </button>
        {isTaggablePaper ? (
          <button
            onClick={tagSyllabus}
            disabled={taggingSyllabus}
            className="py-3 px-5 rounded-2xl border-2 border-dashed border-purple-300 text-purple-500 font-medium hover:border-purple-400 hover:text-purple-700 hover:bg-purple-50 disabled:opacity-50 transition-colors"
          >
            {taggingSyllabus ? "Tagging..." : "Tag Syllabus"}
          </button>
        ) : null}
        <button
          onClick={() => router.push(`/exam/${id}/annotate?userId=${userId}`)}
          className="py-3 px-5 rounded-2xl border-2 border-dashed border-red-300 text-red-500 font-medium hover:border-red-400 hover:text-red-700 hover:bg-red-50 transition-colors flex items-center gap-2"
        >
          <span className="material-symbols-outlined text-sm">edit_note</span>
          Annotate Paper
        </button>
      </div>

      {/* Save & Exit */}
      <button
        onClick={async () => {
          // Clear "extraction failed" status since admin has manually reviewed Q&A
          if (paper?.extractionStatus === "failed" || paper?.extractionStatus === "processing") {
            await fetch(`/api/exam/${id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ extractionStatus: "ready" }),
            });
          }
          router.push(backPath);
        }}
        disabled={!!saving}
        className="w-full mt-4 py-3 rounded-2xl bg-primary-500 text-white text-sm font-semibold hover:bg-primary-600 transition-colors shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {saving ? "Saving…" : "Save & Exit"}
      </button>
      <p className="text-center text-[10px] text-slate-400 mt-2 mb-4">
        All changes are saved automatically when you leave a field.
      </p>

      {/* Area selection modal */}
      {selectTarget && (
        <PageSelectionModal
          pageImages={pageImages}
          defaultPageIndex={selectTarget.defaultPageIndex}
          onConfirm={async (croppedDataUrl, selectedPage, yStartPct, yEndPct, xStartPct, xEndPct) => {
            const qId = selectTarget.questionId;
            const field = selectTarget.field;
            setSelectTarget(null);

            if (field === "imageData") {
              // Save image + page + bounds in one PATCH. xStartPct /
              // xEndPct flow through so a manual re-select on a Grammar
              // Cloze / Editing / Comp Cloze question (sections that
              // store narrow horizontal bounds) overwrites the original
              // auto-extracted X bounds instead of leaving them stale.
              setSaving(qId + field);
              setSaveError(null);
              try {
                const res = await fetch(`/api/exam/questions/${qId}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ imageData: croppedDataUrl, pageIndex: selectedPage, yStartPct, yEndPct, xStartPct, xEndPct }),
                });
                if (!res.ok) {
                  const errData = await res.json().catch(() => ({}));
                  setSaveError(`Save failed (${res.status}): ${errData.error ?? "Unknown error"}`);
                } else {
                  setPaper((prev) =>
                    prev
                      ? { ...prev, questions: prev.questions.map((qq) =>
                          qq.id === qId ? { ...qq, imageData: croppedDataUrl, pageIndex: selectedPage, yStartPct, yEndPct, xStartPct, xEndPct } : qq
                        ) }
                      : prev
                  );
                }
              } catch (err) {
                setSaveError(`Save failed: ${err instanceof Error ? err.message : "Network error"}`);
              } finally {
                setSaving(null);
              }
            } else {
              saveQuestion(qId, field, croppedDataUrl);
            }
          }}
          onClose={() => setSelectTarget(null)}
        />
      )}
      </div>
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

const P6_MATH_TOPICS = [
  "Basic math operations",
  "Fractions",
  "Percentage",
  "Ratio",
  "Algebra",
  "Area and circumference of circle",
  "Volume of cube and cuboid",
  "Geometry",
  "Statistics",
  "Time",
  "Volume measurement",
];

const SCIENCE_TOPICS = [
  "Diversity of living and non-living things",
  "Diversity of materials",
  "Life cycles in plants and animals",
  "Plant parts and functions",
  "Human digestive system",
  "Cycles in matter",
  "Water cycle, evaporation, condensation",
  "Plant respiratory and circulatory systems",
  "Human respiratory and circulatory systems",
  "Reproduction in plants and animals",
  "Light energy and uses",
  "Heat energy and uses",
  "Electrical system and circuits",
  "Photosynthesis",
  "Energy conversion",
  "Interaction of forces (Magnets)",
  "Interaction of forces (Frictional force, gravitational force, elastic spring force)",
  "Interactions within the environment",
];

const ENGLISH_TOPICS = [
  "Grammar MCQ",
  "Vocabulary MCQ",
  "Vocabulary Cloze MCQ",
  "Visual Text Comprehension MCQ",
  "Grammar Cloze",
  "Editing (Spelling & Grammar)",
  "Comprehension Cloze",
  "Synthesis & Transformation",
  "Comprehension (Open-ended)",
  "Continuous Writing",
  "Situational Writing",
  "Oral Communication",
];

const CHINESE_TOPICS = [
  "语文应用 MCQ",
  "短文填空",
  "阅读理解 MCQ",
  "完成对话",
  "Visual Text Comprehension MCQ",
  "阅读理解 OEQ",
];

function QuestionEditCard({
  paperId,
  question,
  saving,
  pdfLoaded,
  syllabusTopics,
  auditFlag,
  onSave,
  onDelete,
  onRedo,
  onAddAfter,
  onSelectArea,
}: {
  paperId: string;
  question: ExamQuestionItem;
  saving: keyof ExamQuestionItem | "redo" | null;
  pdfLoaded: boolean;
  syllabusTopics: string[] | null;
  // Audit reason from the post-extraction Q&A sanity check. When set,
  // the card outline turns red and a banner with the reason renders
  // at the top of the card.
  auditFlag?: string;
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
  const isMissingPage = question.pageIndex == null;

  return (
    <div
      className={`rounded-2xl border-2 bg-white shadow-sm overflow-hidden ${
        auditFlag
          ? "border-red-500"
          : isMissingPage
            ? "border-amber-300"
            : isMissingAnswer
              ? "border-red-200"
              : "border-slate-100"
      }`}
    >
      {/* Audit-flag banner — surfaces the Q&A sanity-check finding so
          the admin can spot why this card was highlighted. Only
          renders when auditFlag is set. */}
      {auditFlag && (
        <div className="bg-red-50 border-b-2 border-red-300 px-4 py-2.5 flex items-start gap-2">
          <span className="material-symbols-outlined text-red-600 text-base shrink-0 mt-0.5">flag</span>
          <p className="text-sm text-red-800 leading-snug"><span className="font-bold">Likely issue:</span> {auditFlag}</p>
        </div>
      )}
      {/* English question type badge */}
      {syllabusTopics?.includes("Grammar Cloze") && (() => {
        const topic = question.syllabusTopic ?? "";
        const ans = question.answer?.trim() ?? "";
        const isMcq = /^[A-D]$/i.test(ans) || /^[1-4]$/.test(ans);
        let label: string;
        let cls: string;
        if (topic === "Grammar MCQ") { label = "Grammar MCQ"; cls = "bg-blue-100 text-blue-700 border-blue-200"; }
        else if (topic === "Vocabulary MCQ") { label = "Vocabulary MCQ"; cls = "bg-blue-100 text-blue-700 border-blue-200"; }
        else if (topic === "Vocabulary Cloze MCQ") { label = "Vocab Cloze MCQ"; cls = "bg-sky-100 text-sky-700 border-sky-200"; }
        else if (topic === "Visual Text Comprehension MCQ") { label = "Visual Text MCQ"; cls = "bg-cyan-100 text-cyan-700 border-cyan-200"; }
        else if (topic === "Grammar Cloze") { label = "Grammar Cloze"; cls = "bg-orange-100 text-orange-700 border-orange-200"; }
        else if (topic === "Comprehension Cloze") { label = "Comprehension Cloze"; cls = "bg-green-100 text-green-700 border-green-200"; }
        else if (topic.startsWith("Editing")) { label = "Editing"; cls = "bg-yellow-100 text-yellow-700 border-yellow-200"; }
        else if (topic.includes("Open-ended") || topic === "Comprehension (Open-ended)") { label = "Comprehension OEQ"; cls = "bg-purple-100 text-purple-700 border-purple-200"; }
        else if (topic === "Synthesis & Transformation") { label = "Synthesis"; cls = "bg-pink-100 text-pink-700 border-pink-200"; }
        else if (isMcq) { label = "MCQ"; cls = "bg-blue-100 text-blue-700 border-blue-200"; }
        else { label = "Written"; cls = "bg-slate-100 text-slate-500 border-slate-200"; }
        return (
          <div className={`px-3 py-1 border-b flex items-center gap-2 ${cls}`}>
            <span className="text-[11px] font-semibold">{label}</span>
          </div>
        );
      })()}
      {/* No pageIndex warning */}
      {isMissingPage && (
        <div className="px-3 py-1.5 bg-amber-50 border-b border-amber-200 flex items-center gap-2">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className="text-amber-500 shrink-0">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className="text-[11px] text-amber-700 font-medium">No page index — use Redo extract or Select area</span>
        </div>
      )}
      {/* ── Question image ──
          Synthetic questions store imageData as "" (there's no scanned
          page to crop from). For them, the AI-generated diagram lives
          in diagramImageData. Fall back to that so the admin sees the
          generated diagram instead of a broken-image icon. If neither
          is present, show a clean empty-state. */}
      <div className="bg-slate-50">
        {(() => {
          // /normal-extract is bounds-focused: if y/x bounds are set
          // we ALWAYS prefer the page-with-overlay preview, even when
          // a prior manual Select-area crop is stored on imageData.
          // Re-extracting bounds doesn't clear imageData, and the
          // small-crop view hid changes from the new bounds. Bounds
          // win.
          const hasBounds =
            question.pageIndex != null &&
            question.yStartPct != null &&
            question.yEndPct != null;
          const hasImage = !hasBounds && !!question.imageData && question.imageData.length > 3000;
          const hasDiagram = !hasBounds && !!question.diagramImageData && question.diagramImageData.length > 3000;
          if (hasImage) {
            return (
              <Image
                src={question.imageData}
                alt={`Question ${question.questionNum}`}
                width={800}
                height={400}
                className="w-full h-auto object-contain"
                unoptimized
              />
            );
          }
          if (hasDiagram) {
            return (
              <>
                <Image
                  src={question.diagramImageData as string}
                  alt={`Question ${question.questionNum} diagram`}
                  width={800}
                  height={400}
                  className="w-full h-auto object-contain"
                  unoptimized
                />
                <p className="px-3 py-1 text-[10px] text-slate-500 italic">
                  Synthetic question — showing AI-generated diagram (no scanned page image)
                </p>
              </>
            );
          }
          // No imageData and no diagram, but if bounds + pageIndex are
          // set (Normal Extract for English populates these) we render
          // the crop on the fly from the page JPEG on Railway disk.
          // Cheaper than storing a base64 imageData on every row.
          if (
            question.pageIndex != null &&
            question.yStartPct != null &&
            question.yEndPct != null
          ) {
            return <BoundsCropPreview paperId={paperId} question={question} />;
          }
          return (
            <div className="px-4 py-6 text-center text-xs text-slate-400 italic">
              No image attached (text-only question)
            </div>
          );
        })()}
        <p className="px-3 py-0.5 text-[10px] text-blue-500 font-mono">
          page {question.pageIndex ?? "—"}
          {" · y "}
          {question.yStartPct != null ? `${question.yStartPct.toFixed(1)}` : "—"}
          {"–"}
          {question.yEndPct != null ? `${question.yEndPct.toFixed(1)}%` : "—"}
          {(question as { xStartPct?: number | null; xEndPct?: number | null }).xStartPct != null && (question as { xStartPct?: number | null; xEndPct?: number | null }).xEndPct != null && (
            <>
              {" · x "}
              {((question as { xStartPct?: number | null }).xStartPct as number).toFixed(1)}
              {"–"}
              {((question as { xEndPct?: number | null }).xEndPct as number).toFixed(1)}
              {"%"}
            </>
          )}
        </p>
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
              onBlur={() => {
                if (qNum !== question.questionNum) {
                  onSave(question.id, "questionNum", qNum);
                  setQNumDirty(false);
                }
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
              <DifficultyBadge
                aiDifficulty={question.difficulty ?? null}
                empiricalDifficulty={question.empiricalDifficulty ?? null}
                empiricalAttempts={question.empiricalAttempts ?? 0}
                onChange={(d) => onSave(question.id, "difficulty", d)}
              />
              <input
                type="number"
                min={0}
                max={10}
                defaultValue={question.marksAvailable ?? ""}
                onBlur={(e) => {
                  const raw = e.target.value === "" ? null : Math.min(10, Math.max(0, Number(e.target.value)));
                  if (raw !== null) e.target.value = String(raw);
                  if (raw !== (question.marksAvailable ?? null)) {
                    onSave(question.id, "marksAvailable", raw);
                  }
                }}
                placeholder="–"
                className="w-12 text-center rounded-lg border border-slate-200 px-1 py-1 text-xs focus:outline-none focus:border-primary-400"
              />
              <span className="text-slate-400">marks</span>
            </div>
          </div>
        </div>

        {/* Syllabus topic (Math / Science) */}
        {syllabusTopics && (
          <div className="flex items-center gap-3">
            <label className="text-xs font-medium text-slate-500 w-24 shrink-0">
              Topic
            </label>
            <div className="flex-1 flex items-center gap-2">
              {question.syllabusTopic && (
                <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
                  {question.syllabusTopic}
                </span>
              )}
              <select
                value={question.syllabusTopic ?? ""}
                onChange={(e) => {
                  const val = e.target.value || null;
                  onSave(question.id, "syllabusTopic", val);
                }}
                className="text-xs rounded-lg border border-slate-200 px-2 py-1 text-slate-600 focus:outline-none focus:border-primary-400 bg-white"
              >
                <option value="">— none —</option>
                {syllabusTopics.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          </div>
        )}

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
              onBlur={() => {
                if (answer !== (question.answer ?? "")) {
                  onSave(question.id, "answer", answer);
                  setAnswerDirty(false);
                }
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
            <p className="text-xs text-red-700">Delete {formatQNum(question.questionNum)}?</p>
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
  onConfirm: (croppedDataUrl: string, pageIndex: number, yStartPct: number, yEndPct: number, xStartPct: number, xEndPct: number) => void;
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

    // Scale down to max 1200px wide before encoding (keeps payload small)
    const MAX_W = 1200;
    let outCanvas = canvas;
    if (canvas.width > MAX_W) {
      outCanvas = document.createElement("canvas");
      const scale = MAX_W / canvas.width;
      outCanvas.width = MAX_W;
      outCanvas.height = Math.round(canvas.height * scale);
      outCanvas.getContext("2d")!.drawImage(canvas, 0, 0, outCanvas.width, outCanvas.height);
    }

    // Convert selection y-coordinates to percentage of page height
    const yStartPct = Math.round(selection.y * 1000) / 10;       // e.g. 0.175 → 17.5
    const yEndPct = Math.round((selection.y + selection.h) * 1000) / 10;
    // Also pass X bounds so the parent can persist them — without this
    // a manual re-select on a narrow-box section (Grammar Cloze, Editing,
    // Comp Cloze) updates only Y while xStartPct/xEndPct stay at the
    // original auto-extracted values, making the displayed box look
    // shifted relative to the new selection.
    const xStartPct = Math.round(selection.x * 1000) / 10;
    const xEndPct = Math.round((selection.x + selection.w) * 1000) / 10;
    onConfirm(outCanvas.toDataURL("image/jpeg", 0.78), pageIndex, yStartPct, yEndPct, xStartPct, xEndPct);
  }, [selection, onConfirm, pageIndex]);

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

// Small admin-only chip next to the marks input showing the question's
// difficulty. Empirical (from student attempts) overrides the AI rating
// once there are ≥5 attempts; otherwise the AI seed label is shown.
// Click to manually override — opens a 1-5 picker that PATCHes the AI
// difficulty field. Empirical rating still wins once ≥5 attempts come
// in, so manual overrides are a soft seed.
function DifficultyBadge({
  aiDifficulty,
  empiricalDifficulty,
  empiricalAttempts,
  onChange,
}: {
  aiDifficulty: number | null;
  empiricalDifficulty: number | null;
  empiricalAttempts: number;
  onChange?: (d: number) => void;
}) {
  const [picking, setPicking] = useState(false);
  // 0 is a sentinel for 'classification was attempted but no rating came
  // back' — treat it as unrated in the UI.
  const validAi = aiDifficulty !== null && aiDifficulty >= 1 && aiDifficulty <= 5 ? aiDifficulty : null;
  const source = empiricalDifficulty !== null && empiricalAttempts >= 5 ? "empirical" : validAi !== null ? "ai" : null;
  const d = source === "empirical" ? empiricalDifficulty! : (validAi ?? 0);
  const palette = !source
    ? { bg: "bg-slate-100", text: "text-slate-500", ring: "ring-slate-200" }
    : d <= 2
    ? { bg: "bg-emerald-100", text: "text-emerald-700", ring: "ring-emerald-200" }
    : d === 3
    ? { bg: "bg-amber-100", text: "text-amber-700", ring: "ring-amber-200" }
    : { bg: "bg-rose-100", text: "text-rose-700", ring: "ring-rose-200" };
  const label = d === 1 ? "Very Easy" : d === 2 ? "Easy" : d === 3 ? "Medium" : d === 4 ? "Hard" : d === 5 ? "Very Hard" : "Set lvl";
  const title = source === "empirical"
    ? `Empirical (from ${empiricalAttempts} attempts) — click to override AI seed`
    : source === "ai"
    ? "AI-rated — click to override"
    : "No rating yet — click to set manually";
  if (picking && onChange) {
    return (
      <span className="inline-flex items-center gap-0.5 mr-1">
        {[1, 2, 3, 4, 5].map(n => {
          const p = n <= 2
            ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
            : n === 3
            ? "bg-amber-100 text-amber-700 hover:bg-amber-200"
            : "bg-rose-100 text-rose-700 hover:bg-rose-200";
          const isCurrent = n === d;
          return (
            <button
              key={n}
              type="button"
              onClick={() => { onChange(n); setPicking(false); }}
              className={`w-5 h-5 rounded text-[10px] font-bold tabular-nums ${p} ${isCurrent ? "ring-2 ring-[#001e40]" : ""}`}
              title={`Set difficulty ${n}`}
            >{n}</button>
          );
        })}
        <button
          type="button"
          onClick={() => setPicking(false)}
          className="text-slate-400 hover:text-slate-700 text-xs ml-0.5"
          title="Cancel"
        >×</button>
      </span>
    );
  }
  return (
    <button
      type="button"
      title={title}
      onClick={() => onChange && setPicking(true)}
      disabled={!onChange}
      className={`px-1.5 py-0.5 rounded text-[10px] font-bold tabular-nums ${palette.bg} ${palette.text} ring-1 ${palette.ring} mr-1 ${onChange ? "hover:brightness-95 cursor-pointer" : "cursor-default"}`}
    >
      {source ? `Lv ${d} · ${label}` : label}
      {source === "empirical" && <span className="ml-1 opacity-60">◉</span>}
    </button>
  );
}

// ─── NormalExtractTriggerRow ─────────────────────────────────────────────────
// Sectioned re-extraction trigger. Hits the existing
// /api/admin/exam/[id]/normal-extract-english POST endpoint per
// section, then calls onExtracted() so the parent page refetches the
// paper and the per-question card list redraws with the new bounds.

const NORMAL_EXTRACT_SECTIONS: Array<{ type: "booklet-a" | "grammar-cloze" | "editing" | "comp-cloze" | "synthesis" | "comp-oeq"; label: string; stateKey: string }> = [
  { type: "booklet-a", label: "Booklet A (Sequential MCQ)", stateKey: "bookletA" },
  { type: "grammar-cloze", label: "Booklet B — Grammar Cloze", stateKey: "grammarCloze" },
  { type: "editing", label: "Booklet B — Editing", stateKey: "editing" },
  { type: "comp-cloze", label: "Booklet B — Comprehension Cloze", stateKey: "compCloze" },
  { type: "synthesis", label: "Booklet B — Synthesis / Transformation", stateKey: "synthesis" },
  { type: "comp-oeq", label: "Booklet B — Comprehension OEQ", stateKey: "compOeq" },
];

// ─── BoundsCropPreview ───────────────────────────────────────────────────────
// Show the page JPEG from Railway disk with a highlighted box over
// the question's stored bounds. Cheaper than storing a base64 crop
// in Neon, and gives the admin spatial context for recropping (see
// the question + surrounding passage, not just an isolated band).
//
// Why not render an actual scaled-up crop? Tailwind's preflight
// `img { max-width: 100% }` outranks inline `width` percentages in
// at least one prod browser, which made the earlier crop approach
// silently render nothing.
function BoundsCropPreview({
  paperId,
  question,
}: {
  paperId: string;
  question: { pageIndex: number | null; yStartPct: number | null; yEndPct: number | null; xStartPct?: number | null; xEndPct?: number | null; questionNum: string };
}) {
  const url = `/api/exam/${paperId}/pages?page=${question.pageIndex}`;
  const yS = question.yStartPct ?? 0;
  const yE = question.yEndPct ?? 100;
  const xS = question.xStartPct ?? 0;
  const xE = question.xEndPct ?? 100;
  const w = Math.max(0.5, xE - xS);
  const h = Math.max(0.5, yE - yS);
  return (
    <div className="relative w-full bg-slate-100">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={`Question ${question.questionNum} page`} className="block w-full h-auto" />
      <div
        className="absolute pointer-events-none border-2 border-red-500/70 rounded-sm"
        style={{
          left: `${xS}%`,
          top: `${yS}%`,
          width: `${w}%`,
          height: `${h}%`,
          background: "rgba(255, 235, 59, 0.18)",
        }}
        aria-hidden
      />
    </div>
  );
}

function NormalExtractTriggerRow({
  paperId,
  state,
  onExtracted,
}: {
  paperId: string;
  state: Record<string, unknown>;
  onExtracted: () => void | Promise<unknown>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{ section: string; ok: boolean; updated?: number; error?: string; warnings?: string[] } | null>(null);
  // Per-section verdicts populated by the "Extract All" loop so the
  // admin can see which sections succeeded vs failed across the run.
  // Kept separate from lastResult (single-section state) so an
  // Extract All that finishes mid-way still surfaces all the
  // intermediate outcomes.
  type RunSummary = { type: string; section: string; ok: boolean; updated?: number; error?: string; warnings?: string[] };
  const [allResults, setAllResults] = useState<RunSummary[]>([]);
  const [runningAll, setRunningAll] = useState(false);
  // Some school papers place the Q-number to the RIGHT of the answer
  // box for Grammar Cloze / Comp Cloze (editing-style layout) instead
  // of the standard PSLE format where the (N) sits BELOW the blank.
  // The "right" mode swaps the cloze crop to editing's wider yRange
  // + x-right extension. Default to "above" (standard PSLE).
  const [clozeQPosition, setClozeQPosition] = useState<"above" | "right">("above");

  // Runs one section against /normal-extract-english. Returns the
  // outcome instead of mutating component state so the caller can
  // decide whether to push into lastResult (single run) or accumulate
  // into allResults (Extract All loop).
  async function runOne(sectionType: string, label: string): Promise<RunSummary> {
    try {
      const body: Record<string, unknown> = { sectionType };
      // qNumPosition routing:
      //   - grammar-cloze / comp-cloze: default PSLE layout is "above"
      //     (Q-number BELOW the blank). "right" toggle sends the
      //     school-variant where (N) sits to the right.
      //   - editing: default PSLE layout is left-of-word margin column.
      //     "above" toggle = school-variant where (N) sits BELOW the
      //     word inline (crop extends upward). "right" toggle =
      //     school-variant where (N) sits to the RIGHT of the word
      //     inline (crop extends leftward). Without per-variant
      //     deltas the extractor grabs the wrong neighbourhood and
      //     the section can't be extracted at all.
      if ((sectionType === "grammar-cloze" || sectionType === "comp-cloze") && clozeQPosition === "right") {
        body.qNumPosition = "right";
      } else if (sectionType === "editing" && clozeQPosition === "above") {
        body.qNumPosition = "above";
      } else if (sectionType === "editing" && clozeQPosition === "right") {
        body.qNumPosition = "right";
      }
      const res = await fetch(`/api/admin/exam/${paperId}/normal-extract-english`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { /* tolerated */ }
      if (!res.ok) {
        return { type: sectionType, section: label, ok: false, error: (json.error as string) ?? `HTTP ${res.status}` };
      }
      return {
        type: sectionType,
        section: label,
        ok: true,
        updated: typeof json.updated === "number" ? json.updated : 0,
        warnings: Array.isArray(json.warnings) ? json.warnings as string[] : [],
      };
    } catch (err) {
      return { type: sectionType, section: label, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function run(sectionType: string, label: string) {
    setBusy(sectionType);
    setLastResult(null);
    const summary = await runOne(sectionType, label);
    setLastResult(summary);
    if (summary.ok) await onExtracted();
    setBusy(null);
  }

  // Sequential "Extract All" — runs each section's POST one at a time
  // (the upstream extractor hits gemini-3.1-pro hard, so parallel
  // requests would just contend for rate limit). Per-section results
  // stream into `allResults` as they land so the admin can watch
  // progress without waiting for the whole batch.
  async function runAll() {
    setRunningAll(true);
    setAllResults([]);
    setLastResult(null);
    const accum: RunSummary[] = [];
    for (const sec of NORMAL_EXTRACT_SECTIONS) {
      setBusy(sec.type);
      const summary = await runOne(sec.type, sec.label);
      accum.push(summary);
      setAllResults([...accum]);
      // Refetch between sections so the question cards refresh
      // progressively as bounds are written.
      if (summary.ok) await onExtracted();
    }
    setBusy(null);
    setRunningAll(false);
  }

  return (
    <div className="mt-5 p-4 rounded-2xl border border-slate-200 bg-slate-50">
      <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Re-extract bounds (admin)</p>
      <p className="text-[11px] text-slate-500 mb-3">
        Re-run gemini-3.1-pro-preview to recompute per-question y/x bounds for one section. The
        question cards below refresh on success so the new crops show up immediately.
      </p>
      {/* Q-number position toggle.
          - Grammar / Comp Cloze: "above" = PSLE standard, (N) sits
            BELOW the blank. "right" = school variant, (N) sits to
            the right of the blank.
          - Editing: "above" toggle means (N) sits BELOW the underlined
            word inline (school variant). Default (no toggle) is PSLE
            standard, (N) in the left margin column.
          One toggle covers both because the "blank-above-the-N" /
          "answer-area-above-the-N" geometry is the same. */}
      <div className="mb-3 flex items-center gap-2 text-[11px] text-slate-600">
        <span className="font-semibold">Q-number position (Cloze + Editing):</span>
        <div className="inline-flex rounded-md border border-slate-300 overflow-hidden">
          <button
            type="button"
            onClick={() => setClozeQPosition("above")}
            className={`px-2.5 py-1 transition-colors ${clozeQPosition === "above" ? "bg-slate-700 text-white" : "bg-white text-slate-600 hover:bg-slate-100"}`}
            title="Cloze: PSLE default — (N) printed below the blank. Editing: school variant — (N) printed below the underlined word."
          >
            Above blank
          </button>
          <button
            type="button"
            onClick={() => setClozeQPosition("right")}
            className={`px-2.5 py-1 transition-colors border-l border-slate-300 ${clozeQPosition === "right" ? "bg-slate-700 text-white" : "bg-white text-slate-600 hover:bg-slate-100"}`}
            title="Cloze school variant: (N) printed to the right of the blank, like standard editing. Editing school variant: underlined word sits to the RIGHT of the (N) inline — crop extends rightward past the (N)."
          >
            Right of blank
          </button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {/* Extract All — runs every section sequentially. Disabled
            while busy so a second click can't double-fire. Visually
            distinct from per-section buttons (slate, not violet)
            since it's an aggregate action. */}
        <button
          type="button"
          onClick={runAll}
          disabled={busy !== null}
          className="px-3 py-2 rounded-lg text-xs font-bold transition-colors disabled:opacity-50 bg-slate-800 text-white hover:bg-slate-900 flex items-center gap-1.5"
          title="Run every section's normal extract in order"
        >
          <span className="material-symbols-outlined text-base">play_arrow</span>
          {runningAll && busy
            ? `Extract All — ${NORMAL_EXTRACT_SECTIONS.find(s => s.type === busy)?.label ?? busy}…`
            : "Extract All"}
        </button>
        {NORMAL_EXTRACT_SECTIONS.map(sec => {
          const isDone = !!state[sec.stateKey];
          const isBusy = busy === sec.type;
          return (
            <button
              key={sec.type}
              type="button"
              onClick={() => run(sec.type, sec.label)}
              disabled={busy !== null}
              className={`px-3 py-2 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 ${
                isDone
                  ? "bg-violet-100 text-violet-700 hover:bg-violet-200"
                  : "bg-violet-500 text-white hover:bg-violet-600"
              }`}
            >
              {isBusy ? "Running…" : isDone ? `Re-extract ${sec.label}` : `Extract ${sec.label}`}
            </button>
          );
        })}
      </div>
      {/* Extract All summary — per-section verdicts streamed in by the
          loop. Hidden while a single-section run is in progress (its
          own lastResult panel below handles that case). */}
      {allResults.length > 0 && (
        <div className="mt-3 p-3 rounded-xl border border-slate-200 bg-white">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">
            Extract All — {allResults.filter(r => r.ok).length}/{NORMAL_EXTRACT_SECTIONS.length} sections complete
            {runningAll && <span className="ml-1 text-slate-400">(running…)</span>}
          </p>
          <ul className="space-y-1">
            {allResults.map(r => (
              <li key={r.type} className="flex items-start gap-2 text-[11px]">
                <span className={`shrink-0 mt-0.5 ${r.ok ? "text-green-600" : "text-red-600"}`}>
                  {r.ok ? "✓" : "✗"}
                </span>
                <div className="min-w-0 flex-1">
                  <span className="font-medium text-slate-700">{r.section}:</span>{" "}
                  {r.ok ? (
                    <span className="text-slate-600">{r.updated ?? 0} questions updated{r.warnings && r.warnings.length > 0 ? `, ${r.warnings.length} warning(s)` : ""}</span>
                  ) : (
                    <span className="text-red-700">{r.error}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {lastResult && (
        <div className={`mt-3 p-3 rounded-xl border text-xs ${lastResult.ok ? "bg-green-50 border-green-200 text-green-800" : "bg-red-50 border-red-200 text-red-800"}`}>
          <p className="font-semibold">
            {lastResult.section}: {lastResult.ok ? `${lastResult.updated ?? 0} questions updated` : `Failed — ${lastResult.error}`}
          </p>
          {lastResult.ok && lastResult.warnings && lastResult.warnings.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-amber-700">{lastResult.warnings.length} warning(s)</summary>
              <ul className="mt-1 space-y-0.5 pl-3">
                {lastResult.warnings.map((w, i) => <li key={i} className="text-[11px] text-amber-700">• {w}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
