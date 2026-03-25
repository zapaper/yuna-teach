"use client";

import { Suspense, use, useEffect, useState, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";

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
                transcribedSubparts: { label: string; text: string }[] | null;
                diagramBounds: DiagramBounds | null;
                diagramImageData: string | null;
              }) => {
                const isMcq = !!(q.transcribedOptions) || !!(q.transcribedOptionImages);
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
            options: q.optionImages ? null : q.options,
            optionImages: q.optionImages ?? null,
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

  function updateQuestion(questionId: string, update: Partial<EditQuestion>) {
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

      // Fetch and render ALL PDF pages
      const pdfRes = await fetch(`/api/exam/${id}/pdf`);
      if (!pdfRes.ok) { alert("PDF not available for this paper"); setRecropQ(null); return; }
      const pdfBlob = await pdfRes.blob();
      const pdfFile = new File([pdfBlob], "exam.pdf", { type: "application/pdf" });

      const { renderPdfToImages } = await import("@/lib/pdf");
      const pages = await renderPdfToImages(pdfFile, 2048, 0.9);
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
                  if (!confirm(`Delete Q${q.questionNum}? This cannot be undone.`)) return;
                  await fetch(`/api/exam/questions/${q.id}`, { method: "DELETE" });
                  setQuestions(qs => qs.filter(x => x.id !== q.id));
                }}
                onUpdate={(update) => updateQuestion(q.id, update)}
                onRecrop={() => startRecrop(q.id)}
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
  isScience,
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
  isScience: boolean;
}) {
  const isMcq = q.type === "mcq";
  const imageOptionsMode = !!(q.optionImages);
  const [drawTarget, setDrawTarget] = useState<DrawTarget>("diagram");

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
    <div className={`rounded-2xl border p-4 ${cardBg}`}>
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
        <span className="text-xs text-slate-400 flex items-center gap-1">
          Ans:
          <input
            type="text"
            value={q.answer}
            onChange={e => onUpdateAnswer(e.target.value)}
            className="w-16 text-xs px-1.5 py-0.5 rounded-md border border-slate-200 bg-white focus:outline-none focus:border-primary-400 text-center"
            placeholder={isMcq ? "1-4" : "answer"}
          />
        </span>
        <button
          onClick={onRecrop}
          title="Choose question zone from PDF"
          className="ml-auto text-[10px] px-2 py-0.5 rounded-md bg-slate-100 text-slate-500 hover:bg-blue-50 hover:text-blue-600 transition-colors"
        >
          Recrop
        </button>
        <button
          onClick={onDelete}
          title="Remove question"
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
                    : typeof t === "string" && t.startsWith("subref-") ? `(${t.slice(7)}) diagram`
                    : typeof t === "string" && t.startsWith("sub-") ? `(${t.slice(4)}) draw`
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
                <button onClick={onRemoveDiagram} className="text-xs text-red-400 hover:text-red-600">Remove</button>
              </div>
              <img
                src={`data:image/jpeg;base64,${q.diagramBase64}`}
                alt="diagram"
                className="w-full rounded-lg border border-slate-100"
              />
            </div>
          )}

          {/* MCQ options */}
          {isMcq && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider">Options</label>
                <button
                  onClick={() => onToggleOptionImages(!imageOptionsMode)}
                  className={`text-xs px-2.5 py-1 rounded-lg border font-medium transition-colors ${
                    imageOptionsMode
                      ? "bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100"
                      : "bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100"
                  }`}
                >
                  {imageOptionsMode ? "Images mode" : "Text mode"} — switch
                </button>
              </div>

              {imageOptionsMode ? (
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

          {/* Open-ended subparts */}
          {!isMcq && q.subparts && q.subparts.length > 0 && (
            <div className="space-y-2 mt-2">
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider">Sub-parts</label>
              {q.subparts.map((sp, i) => (
                <div key={sp.label} className="rounded-xl bg-white border border-amber-100 px-3 py-2">
                  <div className="flex items-start gap-2">
                    <span className="font-mono text-xs text-amber-600 mt-2 shrink-0">({sp.label})</span>
                    <textarea
                      value={sp.text}
                      onChange={e => onUpdateSubpart(i, e.target.value)}
                      rows={2}
                      className="flex-1 text-sm bg-transparent focus:outline-none resize-none"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const newSubs = q.subparts!.filter((_, j) => j !== i);
                        onUpdate({ subparts: newSubs.length > 0 ? newSubs : null });
                      }}
                      className="text-red-300 hover:text-red-500 shrink-0 mt-2"
                      title={`Delete (${sp.label})`}
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
                          onClick={() => onDraw({ top: 0, left: 0, bottom: 50, right: 50 }, `subref-${sp.label}` as DrawTarget)}
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
                      onClick={() => onDraw({ top: 0, left: 0, bottom: 50, right: 50 }, `sub-${sp.label}` as DrawTarget)}
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
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
