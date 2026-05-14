"use client";

import { Suspense, use, useEffect, useState, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import DiagramEditor from "@/components/DiagramEditor";
import { formatSubpartLabel } from "@/lib/subpart-label";

// ─── Types ────────────────────────────────────────────────────────────────────

type DiagramBounds = { top: number; left: number; bottom: number; right: number };
type DrawTarget = "diagram" | "drawable" | 0 | 1 | 2 | 3 | `sub-${string}` | `subref-${string}`;

type SubpartData = { label: string; text: string; diagramBase64?: string | null; refImageBase64?: string | null };

type EditQuestion = {
  id: string;
  type: "mcq" | "open";
  questionNum: string;
  answer: string;
  syllabusTopic: string | null;
  marksAvailable: number | null;
  stem: string;
  options: [string, string, string, string] | null;   // text options
  optionImages: (string | null)[] | null;              // image options (null = not drawn yet)
  // Table-format MCQ (Science only). When set, options/optionImages
  // should be null — the four answer choices ARE the rows of this
  // table. Editing UI is read-only preview for now: admin can re-
  // extract or clear it; the source of truth is the extractor.
  optionTable: { columns: string[]; rows: string[][] } | null;
  subparts: SubpartData[] | null;
  diagramBounds: DiagramBounds | null;
  diagramBase64: string | null;
  drawableDiagramBase64: string | null; // for OEQ without subparts — canvas background in quiz
  imageData?: string; // original question image for drawing/cropping
  error: string | null;
};

/** Normalize an MCQ answer for comparison: "(2)" / "2." / " 2 " → "2" */
function normalizeAnswer(ans: string): string {
  return ans.trim().replace(/[().]/g, "").trim();
}

// Colors per draw target
const TARGET_COLOR: Record<string, string> = {
  diagram: "#7c3aed",
  "0": "#2563eb",
  "1": "#16a34a",
  "2": "#ea580c",
  "3": "#dc2626",
};
const TARGET_LABEL: Record<string, string> = {
  diagram: "Diagram",
  "0": "Opt 1", "1": "Opt 2", "2": "Opt 3", "3": "Opt 4",
};

// ─── DrawableImage ─────────────────────────────────────────────────────────────

function DrawableImage({
  src,
  boxes,
  liveColor,
  onDraw,
}: {
  src: string;
  boxes: { bounds: DiagramBounds; color: string; label: string }[];
  liveColor: string;
  onDraw: (b: DiagramBounds) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<{ x: number; y: number } | null>(null);
  const onDrawRef = useRef(onDraw);
  const [live, setLive] = useState<DiagramBounds | null>(null);

  // Keep onDrawRef current so global handlers always call the latest version
  useEffect(() => { onDrawRef.current = onDraw; }, [onDraw]);

  function toPct(clientX: number, clientY: number) {
    if (!ref.current) return null;
    const r = ref.current.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)),
      y: Math.max(0, Math.min(100, ((clientY - r.top) / r.height) * 100)),
    };
  }

  // Attach global mouse listeners so drag works even when cursor leaves the image
  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!anchorRef.current) return;
      const p = toPct(e.clientX, e.clientY);
      if (!p) return;
      const a = anchorRef.current;
      setLive({
        left: Math.min(a.x, p.x), top: Math.min(a.y, p.y),
        right: Math.max(a.x, p.x), bottom: Math.max(a.y, p.y),
      });
    }
    function onUp(e: MouseEvent) {
      if (!anchorRef.current) return;
      const a = anchorRef.current;
      anchorRef.current = null;
      setLive(null);
      const p = toPct(e.clientX, e.clientY);
      if (p) {
        const b: DiagramBounds = {
          left: Math.round(Math.min(a.x, p.x) * 10) / 10,
          top: Math.round(Math.min(a.y, p.y) * 10) / 10,
          right: Math.round(Math.max(a.x, p.x) * 10) / 10,
          bottom: Math.round(Math.max(a.y, p.y) * 10) / 10,
        };
        if (b.right - b.left > 2 && b.bottom - b.top > 2) onDrawRef.current(b);
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={ref}
      className="relative select-none cursor-crosshair rounded-xl overflow-hidden border border-slate-200 bg-slate-50"
      onMouseDown={e => {
        const p = toPct(e.clientX, e.clientY);
        if (!p) return;
        e.preventDefault();
        anchorRef.current = p;
        setLive(null);
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" className="w-full block" draggable={false} />
      {boxes.map((b, i) => (
        <div key={i} className="absolute pointer-events-none" style={{
          border: `2px solid ${b.color}`,
          backgroundColor: `${b.color}22`,
          left: `${b.bounds.left}%`, top: `${b.bounds.top}%`,
          width: `${b.bounds.right - b.bounds.left}%`,
          height: `${b.bounds.bottom - b.bounds.top}%`,
        }}>
          <span className="absolute top-0 left-0 text-white text-[10px] font-bold px-1 py-0.5 leading-none"
            style={{ backgroundColor: b.color }}>{b.label}</span>
        </div>
      ))}
      {live && (
        <div className="absolute pointer-events-none" style={{
          border: `2px dashed ${liveColor}`,
          backgroundColor: `${liveColor}18`,
          left: `${live.left}%`, top: `${live.top}%`,
          width: `${live.right - live.left}%`, height: `${live.bottom - live.top}%`,
        }} />
      )}
    </div>
  );
}

// ─── Main content ─────────────────────────────────────────────────────────────

export default function TranscribeEditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Suspense><TranscribeEditContent id={id} /></Suspense>;
}

function TranscribeEditContent({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";

  const [questions, setQuestions] = useState<EditQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [paperTitle, setPaperTitle] = useState("");
  const [paperSubject, setPaperSubject] = useState("");
  const [editingDiagramQ, setEditingDiagramQ] = useState<string | null>(null); // question ID being diagram-edited
  const [cropping, setCropping] = useState<string | null>(null); // "questionId-target"
  const [recropQ, setRecropQ] = useState<string | null>(null); // question ID being recropped
  const [recropPageImg, setRecropPageImg] = useState<string | null>(null); // rendered page image
  const [recropLoading, setRecropLoading] = useState(false);
  const [recropPages, setRecropPages] = useState<string[]>([]); // all rendered pages
  const [recropPageIdx, setRecropPageIdx] = useState(0);

  // Generate from AI
  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    try {
      const [genRes, paperRes] = await Promise.all([
        fetch(`/api/exam/${id}/transcribe-mcq`, { method: "POST" }),
        fetch(`/api/exam/${id}`),
      ]);
      const genData = await genRes.json();
      if (!genRes.ok) throw new Error(genData.error ?? "Failed");

      const imgMap: Record<string, string> = {};
      if (paperRes.ok) {
        const pd = await paperRes.json();
        for (const q of pd.questions ?? []) {
          if (q.id && q.imageData) imgMap[q.id] = q.imageData;
        }
      }

      setQuestions(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (genData.questions as any[]).map(q => ({
          ...q,
          optionImages: q.optionImages ?? null,
          drawableDiagramBase64: null,
          imageData: imgMap[q.id],
        }))
      );
    } catch (e) {
      alert(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }, [id]);

  // Load saved transcription — auto-generate if nothing saved yet
  useEffect(() => {
    async function load() {
      let shouldAutoGenerate = false;
      try {
        const [savedRes, paperRes] = await Promise.all([
          fetch(`/api/exam/${id}/transcribe-mcq`),
          fetch(`/api/exam/${id}`), // full paper for imageData + title
        ]);

        // Build imageData map
        const imgMap: Record<string, string> = {};
        if (paperRes.ok) {
          const pd = await paperRes.json();
          setPaperTitle(pd.title ?? "");
          setPaperSubject((pd.subject ?? "").toLowerCase());
          for (const q of pd.questions ?? []) {
            if (q.id && q.imageData) imgMap[q.id] = q.imageData;
          }
        }

        if (savedRes.ok) {
          const data = await savedRes.json();
          if (data.hasSaved && data.questions.length > 0) {
            setQuestions(
              data.questions.map((q: {
                id: string;
                questionNum: string;
                answer: string | null;
                syllabusTopic: string | null;
                marksAvailable: number | null;
                transcribedStem: string | null;
                transcribedOptions: string[] | null;
                transcribedOptionImages: string[] | null;
                transcribedOptionTable: { columns: string[]; rows: string[][] } | null;
                transcribedSubparts: { label: string; text: string }[] | null;
                diagramBounds: DiagramBounds | null;
                diagramImageData: string | null;
              }) => {
                const isMcq = !!(q.transcribedOptions) || !!(q.transcribedOptionImages) || !!(q.transcribedOptionTable);
                return {
                  id: q.id,
                  type: isMcq ? "mcq" as const : "open" as const,
                  questionNum: q.questionNum,
                  answer: q.answer ?? "",
                  syllabusTopic: q.syllabusTopic,
                  marksAvailable: q.marksAvailable,
                  stem: q.transcribedStem ?? "",
                  options: q.transcribedOptions as [string, string, string, string] | null,
                  optionImages: q.transcribedOptionImages ?? null,
                  optionTable: q.transcribedOptionTable ?? null,
                  subparts: (() => {
                    const subs = (q.transcribedSubparts as SubpartData[] | null) ?? null;
                    if (!subs) return null;
                    // strip sentinel entries; attach refImageBase64 back to real subparts
                    const refMap: Record<string, string> = {};
                    for (const sp of subs) {
                      if (sp.label.startsWith("_subref-")) refMap[sp.label.slice(8)] = sp.diagramBase64 ?? "";
                    }
                    const real = subs.filter(sp => !sp.label.startsWith("_") );
                    return real.length === 0 ? null : real.map(sp => ({ ...sp, refImageBase64: refMap[sp.label] ?? null }));
                  })(),
                  drawableDiagramBase64: (() => {
                    const subs = (q.transcribedSubparts as SubpartData[] | null) ?? null;
                    return subs?.find(sp => sp.label === "_drawable")?.diagramBase64 ?? null;
                  })(),
                  diagramBounds: q.diagramBounds ?? null,
                  diagramBase64: q.diagramImageData ?? null,
                  imageData: imgMap[q.id],
                  error: null,
                };
              })
            );
          } else {
            shouldAutoGenerate = true;
          }
        }
      } finally {
        setLoading(false);
      }
      if (shouldAutoGenerate) handleGenerate();
      // Scroll to hash target (e.g. #q-{questionId}) after questions load
      if (typeof window !== "undefined" && window.location.hash) {
        setTimeout(() => {
          const el = document.querySelector(window.location.hash);
          if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 300);
      }
    }
    load();
  }, [id, handleGenerate]);

  // Crop a region from the question image
  async function handleCrop(questionId: string, bounds: DiagramBounds, target: DrawTarget) {
    const key = `${questionId}-${String(target)}`;
    setCropping(key);
    try {
      const res = await fetch(`/api/exam/${id}/transcribe-mcq/crop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId, bounds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Crop failed");

      setQuestions(qs => qs.map(q => {
        if (q.id !== questionId) return q;
        if (target === "diagram") {
          return { ...q, diagramBounds: bounds, diagramBase64: data.diagramBase64 };
        } else if (target === "drawable") {
          return { ...q, drawableDiagramBase64: data.diagramBase64 };
        } else if (typeof target === "string" && target.startsWith("subref-")) {
          const label = target.slice(7);
          if (!q.subparts) return q;
          const newSubs = q.subparts.map(sp =>
            sp.label === label ? { ...sp, refImageBase64: data.diagramBase64 } : sp
          );
          return { ...q, subparts: newSubs };
        } else if (typeof target === "string" && target.startsWith("sub-")) {
          const label = target.slice(4);
          if (!q.subparts) return q;
          const newSubs = q.subparts.map(sp =>
            sp.label === label ? { ...sp, diagramBase64: data.diagramBase64 } : sp
          );
          return { ...q, subparts: newSubs };
        } else {
          const imgs = [...(q.optionImages ?? [null, null, null, null])];
          imgs[target as number] = data.diagramBase64;
          return { ...q, optionImages: imgs };
        }
      }));
    } catch (e) {
      alert(e instanceof Error ? e.message : "Crop failed");
    } finally {
      setCropping(null);
    }
  }

  // Save all to DB
  async function handleSaveAll() {
    // Pre-save validation — warn about problematic questions so admin knows what will be broken in quizzes.
    const problems: string[] = [];
    for (const q of questions) {
      const stem = (q.stem ?? "").trim();
      if (!stem) problems.push(`Q${q.questionNum}: empty stem`);
      if (q.type === "mcq") {
        const hasText = !!q.options && q.options.every(o => String(o ?? "").trim().length > 0);
        const hasImages = !!q.optionImages && q.optionImages.some(o => !!o);
        // Table-format MCQ counts as having options too — the four
        // rows ARE the options. Previously these were flagged as
        // "no text" because transcribedOptions/transcribedOptionImages
        // are intentionally null in table mode.
        const hasTable = !!q.optionTable
          && Array.isArray(q.optionTable.rows) && q.optionTable.rows.length === 4
          && Array.isArray(q.optionTable.columns) && q.optionTable.columns.length >= 1
          && q.optionTable.rows.every(r => Array.isArray(r) && r.length === q.optionTable!.columns.length);
        if (!hasText && !hasImages && !hasTable) {
          problems.push(`Q${q.questionNum}: MCQ with no options (text, image, or table)`);
        }
      }
      if (q.type === "open" && !q.answer?.trim()) problems.push(`Q${q.questionNum}: open-ended with no answer`);
    }
    if (problems.length > 0) {
      const ok = window.confirm(
        `${problems.length} question${problems.length > 1 ? "s" : ""} look${problems.length > 1 ? "" : "s"} incomplete:\n\n` +
        problems.slice(0, 20).join("\n") +
        (problems.length > 20 ? `\n…and ${problems.length - 20} more` : "") +
        `\n\nSave anyway?`
      );
      if (!ok) return;
    }

    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch(`/api/exam/${id}/transcribe-mcq`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          questions: questions.map(q => ({
            id: q.id,
            answer: q.answer || null,
            stem: q.stem,
            options: (q.optionImages || q.optionTable) ? null : q.options,
            optionImages: q.optionImages ?? null,
            optionTable: q.optionTable ?? null,
            subparts: (() => {
              const base = q.subparts ?? [];
              const sentinels: SubpartData[] = [];
              if (q.type === "open" && base.length === 0 && q.drawableDiagramBase64)
                sentinels.push({ label: "_drawable", text: "", diagramBase64: q.drawableDiagramBase64 });
              // encode per-subpart ref images as sentinels
              for (const sp of base) {
                if (sp.refImageBase64)
                  sentinels.push({ label: `_subref-${sp.label}`, text: "", diagramBase64: sp.refImageBase64 });
              }
              return base.length === 0 && sentinels.length === 0 ? null : [...base, ...sentinels];
            })(),
            diagramBounds: q.diagramBounds,
            diagramImageData: q.diagramBase64,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      setSaveMsg(`Saved ${data.saved} questions`);
    } catch (e) {
      setSaveMsg(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function updateQuestion(questionId: string, update: Partial<EditQuestion> & { _editDiagram?: boolean }) {
    if (update._editDiagram) { setEditingDiagramQ(questionId); return; }
    setQuestions(qs => qs.map(q => q.id === questionId ? { ...q, ...update } : q));
  }

  function updateOption(questionId: string, index: number, value: string) {
    setQuestions(qs => qs.map(q => {
      if (q.id !== questionId || !q.options) return q;
      const newOpts = [...q.options] as [string, string, string, string];
      newOpts[index] = value;
      return { ...q, options: newOpts };
    }));
  }

  function updateSubpart(questionId: string, index: number, value: string) {
    setQuestions(qs => qs.map(q => {
      if (q.id !== questionId || !q.subparts) return q;
      const newSubs = q.subparts.map((sp, i) => i === index ? { ...sp, text: value } : sp);
      return { ...q, subparts: newSubs };
    }));
  }

  // Recrop: fetch PDF page, render it, show overlay for user to draw crop zone
  // Per-question re-OCR. Runs the same extractor the bulk job
  // uses against a single question's already-cropped imageData,
  // pulls back the fresh stem / options / subparts, and writes
  // them into the editor's in-memory state. The user reviews and
  // hits Save (paper-wide) to persist. Useful for one-off fixes
  // like restoring (a)(i) hierarchy after a prompt change.
  const [reExtractingId, setReExtractingId] = useState<string | null>(null);
  async function reExtractQuestion(questionId: string) {
    setReExtractingId(questionId);
    try {
      const res = await fetch("/api/admin/broken-questions/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error ?? "Re-extract failed"); return; }
      // Log the raw response so future bug reports have data.
      // The user has reported "subparts added on instead of
      // replaced" and "labels reverted from a-i to i" — without
      // a visible trace of what the extractor actually returned
      // we can't tell whether the AI is ignoring the new prompt
      // or whether the editor merge logic is wrong.
      console.log("[re-extract] response for", questionId, JSON.stringify(data, null, 2));
      setQuestions(qs => qs.map(q => {
        if (q.id !== questionId) return q;
        if (data.type === "mcq") {
          // MCQ branch — drop all OEQ state.
          const optionTable = data.optionTable && typeof data.optionTable === "object"
            && Array.isArray(data.optionTable.columns)
            && Array.isArray(data.optionTable.rows)
            && data.optionTable.rows.length === 4
              ? data.optionTable as { columns: string[]; rows: string[][] }
              : null;
          return {
            ...q,
            type: "mcq",
            stem: typeof data.stem === "string" ? data.stem : q.stem,
            options: optionTable
              ? null
              : Array.isArray(data.options) && data.options.length === 4
                ? (data.options as [string, string, string, string])
                : q.options,
            optionImages: optionTable ? null : q.optionImages,
            optionTable,
            subparts: null,
          };
        }
        // OEQ branch — UNCONDITIONALLY replace subparts with the
        // extractor's output. Previously we kept the old subparts
        // when the response was empty; that hid bugs where the
        // model returned [] and the user thought re-extract was
        // a no-op while really we silently preserved stale data.
        // If the response is empty, set null — same as a fresh
        // OEQ with no parts yet.
        const newSubparts = Array.isArray(data.subparts) && data.subparts.length > 0
          ? data.subparts as SubpartData[]
          : null;
        return {
          ...q,
          type: "open",
          stem: typeof data.stem === "string" ? data.stem : q.stem,
          options: null,
          optionImages: null,
          optionTable: null,
          subparts: newSubparts,
        };
      }));
    } catch (e) {
      alert(e instanceof Error ? e.message : "Re-extract failed");
    } finally {
      setReExtractingId(null);
    }
  }

  async function startRecrop(questionId: string) {
    setRecropQ(questionId);
    setRecropLoading(true);
    setRecropPageImg(null);
    setRecropPages([]);
    try {
      // Fetch the question's pageIndex
      const paperRes = await fetch(`/api/exam/${id}`);
      const paperData = await paperRes.json();
      const question = paperData.questions?.find((q: { id: string }) => q.id === questionId);
      if (!question) { alert("Question not found"); return; }
      const pageIndex = question.pageIndex ?? 0;

      // Try PDF first; fall back to stored page images
      let pages: string[] = [];
      const pdfRes = await fetch(`/api/exam/${id}/pdf`);
      if (pdfRes.ok) {
        const pdfBlob = await pdfRes.blob();
        const pdfFile = new File([pdfBlob], "exam.pdf", { type: "application/pdf" });
        const { renderPdfToImages } = await import("@/lib/pdf");
        pages = await renderPdfToImages(pdfFile, 2048, 0.9);
      } else {
        // Fall back: load pre-rendered page JPEGs from volume
        const countRes = await fetch(`/api/exam/${id}/pages`);
        const countData = countRes.ok ? await countRes.json() : { pageCount: 0 };
        const pageCount: number = countData.pageCount ?? 0;
        if (pageCount === 0) { alert("No pages available for this paper. Please re-upload the PDF."); setRecropQ(null); return; }
        pages = await Promise.all(
          Array.from({ length: pageCount }, async (_, i) => {
            const r = await fetch(`/api/exam/${id}/pages?page=${i}`);
            const blob = await r.blob();
            return new Promise<string>((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.readAsDataURL(blob);
            });
          })
        );
      }
      if (pages.length === 0) { alert("No pages found"); setRecropQ(null); return; }
      setRecropPages(pages);
      const idx = Math.min(pageIndex, pages.length - 1);
      setRecropPageIdx(idx);
      setRecropPageImg(pages[idx]);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to load PDF page");
      setRecropQ(null);
    } finally {
      setRecropLoading(false);
    }
  }

  function handleRecropDone(bounds: DiagramBounds) {
    if (!recropQ || !recropPageImg) return;
    // Crop the selected region from the page image
    const img = new Image();
    img.onload = () => {
      const x = Math.floor((bounds.left / 100) * img.width);
      const y = Math.floor((bounds.top / 100) * img.height);
      const w = Math.ceil(((bounds.right - bounds.left) / 100) * img.width);
      const h = Math.ceil(((bounds.bottom - bounds.top) / 100) * img.height);

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
      const croppedDataUrl = canvas.toDataURL("image/jpeg", 0.85);

      // Update question imageData and persist to DB
      setQuestions(qs => qs.map(q => q.id === recropQ ? { ...q, imageData: croppedDataUrl } : q));
      // Save to DB
      fetch(`/api/exam/questions/${recropQ}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageData: croppedDataUrl }),
      }).catch(() => {});

      setRecropQ(null);
      setRecropPageImg(null);
    };
    img.src = recropPageImg;
  }

  const backPath = userId ? `/exam/${id}/overview?userId=${userId}` : `/exam/${id}/overview`;

  if (loading) {
    return (
      <div className="flex justify-center py-24">
        <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-200 border-t-primary-500" />
      </div>
    );
  }

  return (
    <div className="p-4 pb-32 max-w-2xl mx-auto">
      {/* Header */}
      <button
        onClick={() => router.push(backPath)}
        className="flex items-center gap-1 text-slate-500 mb-4 hover:text-slate-700"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m15 18-6-6 6-6" />
        </svg>
        Overview
      </button>

      <h1 className="text-xl font-bold text-slate-800 mb-1">Clean Question Editor</h1>
      {paperTitle && <p className="text-sm text-slate-400 mb-4">{paperTitle}</p>}

      {questions.length === 0 ? (
        <div className="rounded-2xl border border-slate-100 bg-white shadow-sm p-6 text-center">
          <span className="inline-flex items-center gap-2 text-slate-500 text-sm">
            <span className="animate-spin rounded-full h-4 w-4 border-2 border-slate-200 border-t-slate-500" />
            {generating ? "Extracting clean questions from AI…" : "Loading…"}
          </span>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between mb-4">
            <p className="text-xs text-slate-500">{questions.length} questions</p>
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="text-xs px-3 py-1.5 rounded-lg border border-violet-200 text-violet-600 hover:bg-violet-50 disabled:opacity-50"
            >
              {generating ? "Re-generating…" : "Re-generate from AI"}
            </button>
          </div>

          <div className="space-y-6">
            {questions.map((q) => (
              <QuestionCard
                key={q.id}
                id={`q-${q.id}`}
                question={q}
                cropping={cropping}
                onUpdateAnswer={answer => updateQuestion(q.id, { answer })}
                onUpdateStem={stem => updateQuestion(q.id, { stem })}
                onUpdateOption={(i, v) => updateOption(q.id, i, v)}
                onUpdateSubpart={(i, v) => updateSubpart(q.id, i, v)}
                onDraw={(bounds, target) => handleCrop(q.id, bounds, target)}
                onRemoveDiagram={() => updateQuestion(q.id, { diagramBounds: null, diagramBase64: null })}
                onToggleOptionImages={(imageMode) => updateQuestion(q.id, {
                  optionImages: imageMode ? [null, null, null, null] : null,
                  options: imageMode ? null : (q.options || ["", "", "", ""]),
                })}
                onToggleType={() => updateQuestion(q.id, {
                  type: q.type === "mcq" ? "open" : "mcq",
                  options: q.type === "mcq" ? null : ["", "", "", ""],
                  optionImages: null,
                  subparts: q.type === "open" ? null : q.subparts,
                })}
                onDelete={async () => {
                  if (!confirm(`Clear the clean extraction for Q${q.questionNum}?\n\nThe original scanned question and answer key will be kept — written-paper marking will still work. The question will be removed from online quizzes / focused practice.`)) return;
                  // Clear ONLY the clean-extract fields. The underlying
                  // ExamQuestion row + original imageData/answer/marks
                  // stay intact so scanned-paper marking continues to
                  // work. Quiz/focused-practice already filters out
                  // questions with null transcribedStem.
                  await fetch(`/api/exam/questions/${q.id}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      transcribedStem: null,
                      transcribedOptions: null,
                      transcribedOptionImages: null,
                      transcribedSubparts: null,
                      diagramBounds: null,
                      diagramImageData: null,
                    }),
                  });
                  setQuestions(qs => qs.filter(x => x.id !== q.id));
                }}
                onUpdate={(update) => updateQuestion(q.id, update)}
                onRecrop={() => startRecrop(q.id)}
                onReExtract={() => reExtractQuestion(q.id)}
                reExtracting={reExtractingId === q.id}
                isScience={paperSubject.includes("science")}
              />
            ))}
          </div>
        </>
      )}

      {/* Recrop modal — draw crop zone on PDF page */}
      {recropQ && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => { setRecropQ(null); setRecropPageImg(null); }}>
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto p-4 shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-slate-800">Choose question zone</h3>
              <button onClick={() => { setRecropQ(null); setRecropPageImg(null); setRecropPages([]); }} className="text-slate-400 hover:text-slate-600 text-sm">Cancel</button>
            </div>
            {recropLoading && (
              <div className="flex justify-center py-12">
                <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-200 border-t-primary-500" />
              </div>
            )}
            {recropPageImg && (
              <>
                {/* Page navigation */}
                {recropPages.length > 1 && (
                  <div className="flex items-center justify-center gap-3 mb-2">
                    <button
                      onClick={() => { const idx = Math.max(0, recropPageIdx - 1); setRecropPageIdx(idx); setRecropPageImg(recropPages[idx]); }}
                      disabled={recropPageIdx === 0}
                      className="px-2 py-1 rounded-lg bg-slate-100 text-slate-600 text-xs font-medium hover:bg-slate-200 disabled:opacity-30"
                    >
                      &larr; Prev
                    </button>
                    <span className="text-xs text-slate-500">Page {recropPageIdx + 1} / {recropPages.length}</span>
                    <button
                      onClick={() => { const idx = Math.min(recropPages.length - 1, recropPageIdx + 1); setRecropPageIdx(idx); setRecropPageImg(recropPages[idx]); }}
                      disabled={recropPageIdx === recropPages.length - 1}
                      className="px-2 py-1 rounded-lg bg-slate-100 text-slate-600 text-xs font-medium hover:bg-slate-200 disabled:opacity-30"
                    >
                      Next &rarr;
                    </button>
                  </div>
                )}
                <p className="text-xs text-slate-400 mb-2 text-center">Drag on the page to select the question area</p>
                <DrawableImage
                  src={recropPageImg}
                  boxes={[]}
                  liveColor="#3b82f6"
                  onDraw={handleRecropDone}
                />
              </>
            )}
          </div>
        </div>
      )}

      {/* Sticky save bar */}
      {questions.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-100 px-4 py-3 flex items-center gap-3">
          {saveMsg && (
            <p className={`text-xs flex-1 ${saveMsg.includes("Saved") ? "text-green-600" : "text-red-500"}`}>
              {saveMsg}
            </p>
          )}
          <button
            onClick={handleSaveAll}
            disabled={saving}
            className="ml-auto px-5 py-2.5 rounded-xl bg-primary-500 text-white text-sm font-semibold hover:bg-primary-600 disabled:opacity-50 transition-colors"
          >
            {saving ? (
              <span className="inline-flex items-center gap-2">
                <span className="animate-spin rounded-full h-4 w-4 border-2 border-primary-200 border-t-white" />
                Saving…
              </span>
            ) : "Save All"}
          </button>
        </div>
      )}

      {/* Diagram Editor Modal */}
      {editingDiagramQ && (() => {
        const eq = questions.find(q => q.id === editingDiagramQ);
        if (!eq?.diagramBase64) return null;
        return (
          <DiagramEditor
            imageBase64={eq.diagramBase64}
            onSave={(editedBase64) => {
              updateQuestion(editingDiagramQ, { diagramBase64: editedBase64 });
              setEditingDiagramQ(null);
            }}
            onClose={() => setEditingDiagramQ(null)}
          />
        );
      })()}
    </div>
  );
}

// ─── Question Card ─────────────────────────────────────────────────────────────

function QuestionCard({
  question: q,
  cropping,
  onUpdateAnswer,
  onUpdateStem,
  onUpdateOption,
  onUpdateSubpart,
  onDraw,
  onRemoveDiagram,
  onToggleOptionImages,
  onToggleType,
  onDelete,
  onUpdate,
  onRecrop,
  onReExtract,
  reExtracting,
  isScience,
  id,
}: {
  question: EditQuestion;
  cropping: string | null;
  onUpdateAnswer: (v: string) => void;
  onUpdateStem: (v: string) => void;
  onUpdateOption: (i: number, v: string) => void;
  onUpdateSubpart: (i: number, v: string) => void;
  onDraw: (bounds: DiagramBounds, target: DrawTarget) => void;
  onRemoveDiagram: () => void;
  onToggleOptionImages: (imageMode: boolean) => void;
  onToggleType: () => void;  // MCQ <-> OEQ
  onDelete: () => void;
  onUpdate: (update: Partial<EditQuestion>) => void;
  onRecrop: () => void;
  onReExtract: () => void;
  reExtracting: boolean;
  isScience: boolean;
  id?: string;
}) {
  const isMcq = q.type === "mcq";
  const imageOptionsMode = !!(q.optionImages);
  const tableMode = !!(q.optionTable);
  const [drawTarget, setDrawTarget] = useState<DrawTarget>("diagram");

  // Reset drawTarget back to "diagram" whenever the underlying
  // sub-part set changes (re-extract, "Clear all", manual delete).
  // Without this the tab could stay pointing at "sub-i" after the
  // new subparts arrive with labels like "a-i" / "a-ii" — the
  // user would see new tabs in the list but the stale label still
  // sitting in the highlighted state, which looked to them like
  // "old numbers are still there." Triggers off a label fingerprint
  // so cosmetic re-renders (typing into a text field) don't reset.
  const subpartLabelKey = (q.subparts ?? []).map((sp) => sp.label).join(",");
  useEffect(() => {
    setDrawTarget("diagram");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subpartLabelKey]);

  // Build overlay boxes for the drawable image
  const boxes: { bounds: DiagramBounds; color: string; label: string }[] = [];
  if (q.diagramBounds) boxes.push({ bounds: q.diagramBounds, color: TARGET_COLOR.diagram, label: "Diagram" });
  // Option bounds aren't stored separately; option images are cropped directly

  function isCropping(target: DrawTarget) {
    return cropping === `${q.id}-${String(target)}`;
  }
  const anyIsCropping = isCropping("diagram") || isCropping(0) || isCropping(1) || isCropping(2) || isCropping(3);

  const cardBg = isMcq ? "bg-slate-50 border-slate-200" : "bg-amber-50 border-amber-200";

  return (
    <div id={id} className={`rounded-2xl border p-4 ${cardBg}`}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <span className="text-sm font-bold text-slate-700">Q{q.questionNum}</span>
        <button
          onClick={onToggleType}
          title={isMcq ? "Switch to Open-ended" : "Switch to MCQ"}
          className={`text-xs px-2 py-0.5 rounded-full font-medium cursor-pointer hover:opacity-80 transition-opacity ${isMcq ? "bg-slate-200 text-slate-600" : "bg-amber-200 text-amber-700"}`}
        >
          {isMcq ? "MCQ" : "Open"} &harr;
        </button>
        {q.syllabusTopic && (
          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">{q.syllabusTopic}</span>
        )}
        {q.marksAvailable && (
          <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">{q.marksAvailable}m</span>
        )}
        {isMcq && (
          <span className="text-xs text-slate-400 flex items-center gap-1">
            Ans:
            <input
              type="text"
              value={q.answer}
              onChange={e => onUpdateAnswer(e.target.value)}
              className="w-16 text-xs px-1.5 py-0.5 rounded-md border border-slate-200 bg-white focus:outline-none focus:border-primary-400 text-center"
              placeholder="1-4"
            />
          </span>
        )}
        <button
          onClick={onReExtract}
          disabled={reExtracting}
          title="Re-run the OCR extractor on this question's image. Works for both MCQ and OEQ — for Science MCQ, will detect and emit table-format options if the question's choices are rows of a comparison table; for OEQ, will restore (a)(i)/(a)(ii) compound hierarchy. Review and Save to persist."
          className="ml-auto text-[10px] px-2 py-0.5 rounded-md bg-slate-100 text-slate-500 hover:bg-emerald-50 hover:text-emerald-600 transition-colors disabled:opacity-50"
        >
          {reExtracting ? "Extracting…" : "Re-extract"}
        </button>
        <button
          onClick={onRecrop}
          title="Choose question zone from PDF"
          className="text-[10px] px-2 py-0.5 rounded-md bg-slate-100 text-slate-500 hover:bg-blue-50 hover:text-blue-600 transition-colors"
        >
          Recrop
        </button>
        <button
          onClick={onDelete}
          title="Clear clean extract (keeps original scan + answer key)"
          className="p-1 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
          </svg>
        </button>
      </div>

      {q.error ? (
        <p className="text-xs text-red-500 mb-2">Error: {q.error}</p>
      ) : (
        <>
          {/* Original image with draw overlay */}
          {q.imageData && (
            <div className="mb-3">
              {/* Draw target selector */}
              <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                <span className="text-xs text-slate-400">Draw:</span>
                {(
                  (["diagram", ...(isMcq && imageOptionsMode ? [0, 1, 2, 3] : []),
                    ...(!isMcq && q.subparts && q.subparts.length > 0 ? [
                      ...q.subparts.map(sp => `sub-${sp.label}`),
                      ...(isScience ? q.subparts.map(sp => `subref-${sp.label}`) : []),
                    ] : []),
                    ...(!isMcq && (!q.subparts || q.subparts.length === 0) ? ["drawable"] : []),
                  ]) as DrawTarget[]
                ).map(t => {
                  const key = String(t);
                  const color = (t === "drawable" || (typeof t === "string" && (t.startsWith("sub-") || t.startsWith("subref-")))) ? "#7c3aed" : (TARGET_COLOR[key] ?? "#7c3aed");
                  const label = t === "drawable" ? "Drawable diagram"
                    : typeof t === "string" && t.startsWith("subref-") ? `${formatSubpartLabel(t.slice(7))} diagram`
                    : typeof t === "string" && t.startsWith("sub-") ? `${formatSubpartLabel(t.slice(4))} draw`
                    : (TARGET_LABEL[key] ?? key);
                  const active = drawTarget === t;
                  return (
                    <button
                      key={key}
                      onClick={() => setDrawTarget(t)}
                      className="text-xs px-2 py-0.5 rounded-full font-medium transition-colors"
                      style={{
                        backgroundColor: active ? color : `${color}22`,
                        color: active ? "white" : color,
                        border: `1px solid ${color}`,
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
                {anyIsCropping && (
                  <span className="text-xs text-slate-400 inline-flex items-center gap-1">
                    <span className="animate-spin rounded-full h-3 w-3 border-2 border-slate-200 border-t-slate-500" />
                    Cropping…
                  </span>
                )}
              </div>

              <DrawableImage
                src={q.imageData}
                boxes={boxes}
                liveColor={(drawTarget === "drawable" || (typeof drawTarget === "string" && (drawTarget.startsWith("sub-") || drawTarget.startsWith("subref-")))) ? "#7c3aed" : (TARGET_COLOR[String(drawTarget)] ?? "#7c3aed")}
                onDraw={bounds => onDraw(bounds, drawTarget)}
              />
              <p className="text-xs text-slate-400 mt-1 text-center">Drag on image to set crop region</p>
            </div>
          )}

          {/* Stem */}
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Question</label>
          <textarea
            value={q.stem}
            onChange={e => onUpdateStem(e.target.value)}
            rows={3}
            className="w-full text-sm rounded-xl border border-slate-200 bg-white px-3 py-2 focus:outline-none focus:border-primary-400 resize-y mb-3"
          />

          {/* Diagram crop preview */}
          {q.diagramBase64 && (
            <div className="mb-3 rounded-xl border border-slate-200 bg-white p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Diagram Preview</span>
                <div className="flex items-center gap-2">
                  <button onClick={() => onUpdate({ _editDiagram: true } as any)} className="text-xs text-violet-500 hover:text-violet-700 font-semibold">Edit</button>
                  <button onClick={onRemoveDiagram} className="text-xs text-red-400 hover:text-red-600">Remove</button>
                </div>
              </div>
              <img
                src={`data:image/jpeg;base64,${q.diagramBase64}`}
                alt="diagram"
                className="w-full rounded-lg border border-slate-100 cursor-pointer hover:opacity-80 transition-opacity"
                onClick={() => onUpdate({ _editDiagram: true } as any)}
              />
            </div>
          )}

          {/* MCQ options */}
          {isMcq && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider">Options</label>
                {/* Three-way mode selector. Picks one of:
                    text → string[] in transcribedOptions
                    images → (string|null)[] in transcribedOptionImages
                    table → { columns, rows } in transcribedOptionTable
                    Switching modes clears the other two on q. Table
                    mode starts with a 2-col / 4-row blank scaffold
                    so admins have something to type into; re-extract
                    on a Science MCQ with a table image fills it in
                    automatically. */}
                <div className="flex items-center gap-1 text-[11px]">
                  <button
                    onClick={() => onUpdate({
                      options: q.options ?? ["", "", "", ""],
                      optionImages: null,
                      optionTable: null,
                    })}
                    className={`px-2 py-1 rounded-md border font-medium transition-colors ${
                      !imageOptionsMode && !tableMode
                        ? "bg-slate-200 border-slate-300 text-slate-700"
                        : "bg-white border-slate-200 text-slate-500 hover:bg-slate-50"
                    }`}
                  >Text</button>
                  <button
                    onClick={() => onUpdate({
                      options: null,
                      optionImages: q.optionImages ?? [null, null, null, null],
                      optionTable: null,
                    })}
                    className={`px-2 py-1 rounded-md border font-medium transition-colors ${
                      imageOptionsMode
                        ? "bg-blue-100 border-blue-300 text-blue-700"
                        : "bg-white border-slate-200 text-slate-500 hover:bg-slate-50"
                    }`}
                  >Images</button>
                  <button
                    onClick={() => onUpdate({
                      options: null,
                      optionImages: null,
                      optionTable: q.optionTable ?? { columns: ["", ""], rows: [["", ""], ["", ""], ["", ""], ["", ""]] },
                    })}
                    className={`px-2 py-1 rounded-md border font-medium transition-colors ${
                      tableMode
                        ? "bg-emerald-100 border-emerald-300 text-emerald-700"
                        : "bg-white border-slate-200 text-slate-500 hover:bg-slate-50"
                    }`}
                    title="Table-format MCQ — for Science questions whose four options are rows of a comparison table"
                  >Table</button>
                </div>
              </div>

              {tableMode && q.optionTable ? (
                // Editable table. Each cell + each header is an
                // input. Columns can be added or removed; rows are
                // fixed at 4 (one per option). When a column is
                // added/removed, the existing rows are reshaped to
                // match. Re-extract on a Science MCQ overwrites
                // the whole table with whatever the AI returned.
                <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50">
                      <tr>
                        <th className="px-2 py-2 text-left font-semibold text-slate-500 border-b border-slate-200 w-10">Opt</th>
                        {q.optionTable.columns.map((c, ci) => (
                          <th key={ci} className="px-1 py-1 text-left font-semibold text-slate-500 border-b border-slate-200">
                            <div className="flex items-center gap-1">
                              <input
                                type="text"
                                value={c}
                                placeholder={`Col ${ci + 1}`}
                                onChange={(e) => {
                                  const cols = q.optionTable!.columns.slice();
                                  cols[ci] = e.target.value;
                                  onUpdate({ optionTable: { ...q.optionTable!, columns: cols } });
                                }}
                                className="flex-1 px-1.5 py-0.5 text-xs font-semibold rounded border border-transparent hover:border-slate-200 focus:border-slate-400 focus:outline-none bg-transparent"
                              />
                              {q.optionTable!.columns.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    const cols = q.optionTable!.columns.filter((_, i) => i !== ci);
                                    const rows = q.optionTable!.rows.map((r) => r.filter((_, i) => i !== ci));
                                    onUpdate({ optionTable: { columns: cols, rows } });
                                  }}
                                  className="text-red-300 hover:text-red-500"
                                  title={`Remove column ${ci + 1}`}
                                >×</button>
                              )}
                            </div>
                          </th>
                        ))}
                        <th className="px-1 py-1 w-10 border-b border-slate-200">
                          <button
                            type="button"
                            onClick={() => {
                              const cols = [...q.optionTable!.columns, ""];
                              const rows = q.optionTable!.rows.map((r) => [...r, ""]);
                              onUpdate({ optionTable: { columns: cols, rows } });
                            }}
                            className="text-emerald-500 hover:text-emerald-700"
                            title="Add column"
                          >+</button>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {q.optionTable.rows.map((row, ri) => {
                        const isAnswer = String(ri + 1) === normalizeAnswer(q.answer);
                        return (
                          <tr key={ri} className={isAnswer ? "bg-green-50" : ""}>
                            <td className="px-2 py-1 border-t border-slate-100 font-mono text-slate-500">({ri + 1}){isAnswer && " ✓"}</td>
                            {row.map((cell, ci) => (
                              <td key={ci} className="px-1 py-0.5 border-t border-slate-100">
                                <input
                                  type="text"
                                  value={cell}
                                  placeholder="—"
                                  onChange={(e) => {
                                    const rows = q.optionTable!.rows.map((r, i) => i === ri ? r.map((c, j) => j === ci ? e.target.value : c) : r);
                                    onUpdate({ optionTable: { ...q.optionTable!, rows } });
                                  }}
                                  className="w-full px-1.5 py-0.5 text-xs rounded border border-transparent hover:border-slate-200 focus:border-slate-400 focus:outline-none bg-transparent"
                                />
                              </td>
                            ))}
                            <td className="border-t border-slate-100" />
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : imageOptionsMode ? (
                // Image options: 2×2 grid (options 1&2 on row 1, 3&4 on row 2)
                <div className="grid grid-cols-2 gap-2">
                  {[0, 1, 2, 3].map(i => {
                    const imgData = q.optionImages?.[i] ?? null;
                    const optColor = TARGET_COLOR[String(i)];
                    const isThisAnswer = String(i + 1) === normalizeAnswer(q.answer);
                    return (
                      <div key={i} className={`rounded-xl border p-2 ${isThisAnswer ? "border-green-300 bg-green-50" : "border-slate-200 bg-white"}`}>
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <span className="text-xs font-bold text-white px-1.5 py-0.5 rounded-md"
                            style={{ backgroundColor: optColor }}>({i + 1})</span>
                          {isThisAnswer && <span className="text-xs text-green-600 font-medium">✓</span>}
                          <button
                            onClick={() => setDrawTarget(i as DrawTarget)}
                            className="ml-auto text-xs px-2 py-0.5 rounded-lg transition-colors"
                            style={{
                              backgroundColor: drawTarget === i ? optColor : `${optColor}22`,
                              color: drawTarget === i ? "white" : optColor,
                            }}
                          >
                            {isCropping(i as DrawTarget) ? "…" : drawTarget === i ? "Drawing" : "Draw"}
                          </button>
                        </div>
                        {imgData ? (
                          <img
                            src={`data:image/jpeg;base64,${imgData}`}
                            alt={`Option ${i + 1}`}
                            className="w-full rounded-lg border border-slate-100"
                          />
                        ) : (
                          <div className="h-10 rounded-lg border-2 border-dashed flex items-center justify-center"
                            style={{ borderColor: optColor }}>
                            <span className="text-xs" style={{ color: optColor }}>
                              Select "Draw this" then drag on image above
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                // Text options
                q.options ? q.options.map((opt, i) => (
                  <div key={i} className={`flex items-start gap-2 rounded-xl px-3 py-2 border ${String(i + 1) === normalizeAnswer(q.answer) ? "border-green-300 bg-green-50" : "border-slate-200 bg-white"}`}>
                    <span className="font-mono text-xs text-slate-400 mt-2 shrink-0 w-5">({i + 1})</span>
                    <textarea
                      value={opt}
                      onChange={e => onUpdateOption(i, e.target.value)}
                      rows={1}
                      className="flex-1 text-sm bg-transparent focus:outline-none resize-none"
                    />
                  </div>
                )) : (
                  <p className="text-xs text-slate-400 italic">No text options — switch to Images mode to draw them</p>
                )
              )}
            </div>
          )}

          {/* Drawable diagram for OEQ without subparts */}
          {!isMcq && (!q.subparts || q.subparts.length === 0) && (
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Drawable diagram</span>
              {q.drawableDiagramBase64 ? (
                <>
                  <img
                    src={`data:image/jpeg;base64,${q.drawableDiagramBase64}`}
                    alt="drawable diagram"
                    className="h-14 rounded border border-violet-200"
                  />
                  <button
                    type="button"
                    onClick={() => onUpdate({ drawableDiagramBase64: null })}
                    className="text-[10px] text-red-400 hover:text-red-600"
                  >Remove</button>
                </>
              ) : (
                <span className="text-xs text-slate-400 italic">Select "Drawable diagram" above and drag on the image</span>
              )}
            </div>
          )}

          {/* OEQ model answer — full-width textarea */}
          {!isMcq && (
            <div className="mt-3">
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Model Answer</label>
              <textarea
                value={q.answer ?? ""}
                onChange={e => onUpdateAnswer(e.target.value)}
                rows={Math.min(8, Math.max(3, ((q.answer ?? "").match(/\n/g)?.length ?? 0) + 2))}
                placeholder="Type the full model answer. Use | to separate sub-parts."
                className="w-full text-xs font-mono px-3 py-2 rounded-lg border border-slate-200 bg-white focus:outline-none focus:border-blue-400 resize-y leading-relaxed"
              />
            </div>
          )}

          {/* Open-ended subparts */}
          {!isMcq && q.subparts && q.subparts.length > 0 && (
            <div className="space-y-2 mt-2">
              <div className="flex items-center justify-between">
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider">Sub-parts</label>
                <button
                  type="button"
                  onClick={() => {
                    if (!confirm(`Clear ALL ${q.subparts!.length} sub-part(s) on Q${q.questionNum}? You can then Re-extract to repopulate, or leave it empty if this question has no sub-parts.`)) return;
                    onUpdate({ subparts: null });
                  }}
                  className="text-[10px] px-2 py-0.5 rounded-md bg-red-50 border border-red-200 text-red-600 hover:bg-red-100 transition-colors"
                  title="Wipe all sub-parts on this question — use when legacy data has duplicate labels or you want to start over before Re-extract"
                >
                  Clear all
                </button>
              </div>
              {q.subparts.map((sp, i) => {
                // Parse marks from text suffix like "[2]"
                const marksMatch = sp.text.match(/\[(\d+)\s*(?:m(?:ark)?s?)?\]\s*$/i);
                const spMarks = marksMatch ? marksMatch[1] : "";
                // Key MUST include the index. Some legacy paper data
                // has duplicate labels like ["i","ii","b","i","ii"]
                // (flattened compound (a)(i)/(a)(ii)/(b)(i)/(b)(ii)
                // without the prefix). With key={sp.label} React's
                // reconciler treats both "i" entries as the same DOM
                // node — delete on the second one is a no-op, and
                // Re-extract appears to "add on" rows because old
                // and new collide during reconciliation. Index +
                // label is stable AND unique.
                return (
                <div key={`${i}-${sp.label}`} className="rounded-xl bg-white border border-amber-100 px-3 py-2">
                  <div className="flex items-start gap-2">
                    <span className="font-mono text-xs text-amber-600 mt-2 shrink-0">{formatSubpartLabel(sp.label)}</span>
                    <textarea
                      value={sp.text}
                      onChange={e => onUpdateSubpart(i, e.target.value)}
                      rows={2}
                      className="flex-1 text-sm bg-transparent focus:outline-none resize-none"
                    />
                    <input
                      type="text"
                      value={spMarks}
                      onChange={e => {
                        const val = e.target.value.replace(/\D/g, "");
                        // Remove old marks suffix, append new in [Nmarks] format
                        const cleaned = sp.text.replace(/\s*\[\d+\s*(?:m(?:ark)?s?)?\]\s*$/i, "").trim();
                        onUpdateSubpart(i, val ? `${cleaned} [${val}marks]` : cleaned);
                      }}
                      className="w-8 text-xs text-center px-1 py-0.5 rounded-md border border-amber-200 bg-amber-50 focus:outline-none focus:border-amber-400 shrink-0 mt-2"
                      placeholder="m"
                      title="Marks for this part"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const newSubs = q.subparts!.filter((_, j) => j !== i);
                        onUpdate({ subparts: newSubs.length > 0 ? newSubs : null });
                      }}
                      className="text-red-300 hover:text-red-500 shrink-0 mt-2"
                      title={`Delete ${formatSubpartLabel(sp.label)}`}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                    </button>
                  </div>
                  {/* Per-subpart actions */}
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {/* Static reference diagram (Science only) */}
                    {isScience && (
                      <>
                        <button
                          type="button"
                          onClick={() => setDrawTarget(`subref-${sp.label}` as DrawTarget)}
                          className="text-[10px] px-2 py-0.5 rounded-md bg-sky-50 text-sky-600 hover:bg-sky-100"
                        >
                          {sp.refImageBase64 ? "Redraw diagram" : "Add diagram"}
                        </button>
                        {sp.refImageBase64 && (
                          <>
                            <img src={`data:image/jpeg;base64,${sp.refImageBase64}`} alt={`(${sp.label}) ref`} className="h-12 rounded border border-sky-200" />
                            <button type="button" onClick={() => { const n = q.subparts!.map((s,j) => j===i ? {...s, refImageBase64: null} : s); onUpdate({ subparts: n }); }} className="text-[10px] text-red-400 hover:text-red-600">Remove</button>
                          </>
                        )}
                      </>
                    )}
                    {/* Drawable diagram */}
                    <button
                      type="button"
                      onClick={() => setDrawTarget(`sub-${sp.label}` as DrawTarget)}
                      className="text-[10px] px-2 py-0.5 rounded-md bg-violet-50 text-violet-600 hover:bg-violet-100"
                    >
                      {sp.diagramBase64 ? "Redraw canvas bg" : "Add drawable diagram"}
                    </button>
                    {sp.diagramBase64 && (
                      <>
                        <img src={`data:image/jpeg;base64,${sp.diagramBase64}`} alt={`(${sp.label}) draw`} className="h-12 rounded border border-violet-200" />
                        <button type="button" onClick={() => { const n = q.subparts!.map((s,j) => j===i ? {...s, diagramBase64: null} : s); onUpdate({ subparts: n }); }} className="text-[10px] text-red-400 hover:text-red-600">Remove</button>
                      </>
                    )}
                  </div>
                </div>
              );
              })}
              {/* Subpart marks sum */}
              {(() => {
                const sum = q.subparts!.reduce((s, sp) => {
                  const m = sp.text.match(/\[(\d+)\s*(?:m(?:ark)?s?)?\]\s*$/i);
                  return s + (m ? parseInt(m[1]) : 0);
                }, 0);
                return sum > 0 ? (
                  <p className={`text-[10px] font-bold text-right ${sum === (q.marksAvailable ?? 0) ? "text-green-600" : "text-amber-600"}`}>
                    Sub-part total: {sum}{q.marksAvailable ? ` / ${q.marksAvailable}` : ""}
                    {q.marksAvailable && sum !== q.marksAvailable ? " ⚠" : " ✓"}
                  </p>
                ) : null;
              })()}
            </div>
          )}
        </>
      )}
    </div>
  );
}
