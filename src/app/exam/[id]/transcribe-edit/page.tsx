"use client";

import { Suspense, use, useEffect, useState, useCallback, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// ─── Types ────────────────────────────────────────────────────────────────────

type DiagramBounds = { top: number; left: number; bottom: number; right: number };
type DrawTarget = "diagram" | 0 | 1 | 2 | 3;

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
  subparts: { label: string; text: string }[] | null;
  diagramBounds: DiagramBounds | null;
  diagramBase64: string | null;
  imageData?: string; // original question image for drawing/cropping
  error: string | null;
};

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
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [cur, setCur] = useState<{ x: number; y: number } | null>(null);

  function toPct(e: React.MouseEvent) {
    if (!ref.current) return null;
    const r = ref.current.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)),
      y: Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100)),
    };
  }

  const live = anchor && cur ? {
    left: Math.min(anchor.x, cur.x), top: Math.min(anchor.y, cur.y),
    right: Math.max(anchor.x, cur.x), bottom: Math.max(anchor.y, cur.y),
  } : null;

  return (
    <div
      ref={ref}
      className="relative select-none cursor-crosshair rounded-xl overflow-hidden border border-slate-200 bg-slate-50"
      onMouseDown={e => {
        const p = toPct(e); if (!p) return;
        e.preventDefault();
        setAnchor(p); setCur(p);
      }}
      onMouseMove={e => { if (!anchor) return; const p = toPct(e); if (p) setCur(p); }}
      onMouseUp={e => {
        if (!anchor) return;
        const p = toPct(e);
        if (p) {
          const b: DiagramBounds = {
            left: Math.round(Math.min(anchor.x, p.x) * 10) / 10,
            top: Math.round(Math.min(anchor.y, p.y) * 10) / 10,
            right: Math.round(Math.max(anchor.x, p.x) * 10) / 10,
            bottom: Math.round(Math.max(anchor.y, p.y) * 10) / 10,
          };
          if (b.right - b.left > 2 && b.bottom - b.top > 2) onDraw(b);
        }
        setAnchor(null); setCur(null);
      }}
      onMouseLeave={() => { setAnchor(null); setCur(null); }}
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
  const [cropping, setCropping] = useState<string | null>(null); // "questionId-target"

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
        (genData.questions as EditQuestion[]).map(q => ({
          ...q,
          optionImages: null,
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
                  subparts: q.transcribedSubparts ?? null,
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
            stem: q.stem,
            options: q.optionImages ? null : q.options,
            optionImages: q.optionImages ?? null,
            subparts: q.subparts,
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
                onUpdateStem={stem => updateQuestion(q.id, { stem })}
                onUpdateOption={(i, v) => updateOption(q.id, i, v)}
                onUpdateSubpart={(i, v) => updateSubpart(q.id, i, v)}
                onDraw={(bounds, target) => handleCrop(q.id, bounds, target)}
                onRemoveDiagram={() => updateQuestion(q.id, { diagramBounds: null, diagramBase64: null })}
                onToggleOptionImages={(imageMode) => updateQuestion(q.id, {
                  optionImages: imageMode ? [null, null, null, null] : null,
                  options: imageMode ? null : q.options,
                })}
              />
            ))}
          </div>
        </>
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
  onUpdateStem,
  onUpdateOption,
  onUpdateSubpart,
  onDraw,
  onRemoveDiagram,
  onToggleOptionImages,
}: {
  question: EditQuestion;
  cropping: string | null;
  onUpdateStem: (v: string) => void;
  onUpdateOption: (i: number, v: string) => void;
  onUpdateSubpart: (i: number, v: string) => void;
  onDraw: (bounds: DiagramBounds, target: DrawTarget) => void;
  onRemoveDiagram: () => void;
  onToggleOptionImages: (imageMode: boolean) => void;
}) {
  const isMcq = q.type === "mcq";
  const imageOptionsMode = !!(q.optionImages);
  const [drawTarget, setDrawTarget] = useState<DrawTarget>("diagram");

  // Build overlay boxes for the drawable image
  const boxes: { bounds: DiagramBounds; color: string; label: string }[] = [];
  if (q.diagramBounds) boxes.push({ bounds: q.diagramBounds, color: TARGET_COLOR.diagram, label: "Diagram" });
  if (q.optionImages) {
    q.optionImages.forEach((_, i) => {
      // We don't store option bounds separately — just show the drawn area isn't tracked here
      // (option images are cropped directly, bounds aren't persisted)
    });
  }

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
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${isMcq ? "bg-slate-200 text-slate-600" : "bg-amber-200 text-amber-700"}`}>
          {isMcq ? "MCQ" : "Open"}
        </span>
        {q.syllabusTopic && (
          <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">{q.syllabusTopic}</span>
        )}
        {q.marksAvailable && (
          <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">{q.marksAvailable}m</span>
        )}
        {isMcq && (
          <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">Ans: ({q.answer})</span>
        )}
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
                {(["diagram", 0, 1, 2, 3] as DrawTarget[]).filter(t =>
                  t === "diagram" || (isMcq && imageOptionsMode)
                ).map(t => {
                  const key = String(t);
                  const active = drawTarget === t;
                  return (
                    <button
                      key={key}
                      onClick={() => setDrawTarget(t)}
                      className="text-xs px-2 py-0.5 rounded-full font-medium transition-colors"
                      style={{
                        backgroundColor: active ? TARGET_COLOR[key] : `${TARGET_COLOR[key]}22`,
                        color: active ? "white" : TARGET_COLOR[key],
                        border: `1px solid ${TARGET_COLOR[key]}`,
                      }}
                    >
                      {TARGET_LABEL[key]}
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
                liveColor={TARGET_COLOR[String(drawTarget)]}
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
                // Image options: draw boxes on the question image
                <div className="space-y-2">
                  {[0, 1, 2, 3].map(i => {
                    const imgData = q.optionImages?.[i] ?? null;
                    const optColor = TARGET_COLOR[String(i)];
                    const isThisAnswer = String(i + 1) === q.answer;
                    return (
                      <div key={i} className={`rounded-xl border p-2 ${isThisAnswer ? "border-green-300 bg-green-50" : "border-slate-200 bg-white"}`}>
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <span className="text-xs font-bold text-white px-1.5 py-0.5 rounded-md"
                            style={{ backgroundColor: optColor }}>({i + 1})</span>
                          {isThisAnswer && <span className="text-xs text-green-600 font-medium">Correct answer</span>}
                          <button
                            onClick={() => setDrawTarget(i as DrawTarget)}
                            className="ml-auto text-xs px-2 py-0.5 rounded-lg transition-colors"
                            style={{
                              backgroundColor: drawTarget === i ? optColor : `${optColor}22`,
                              color: drawTarget === i ? "white" : optColor,
                            }}
                          >
                            {isCropping(i as DrawTarget) ? "Cropping…" : drawTarget === i ? "Drawing this" : "Draw this"}
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
                  <div key={i} className={`flex items-start gap-2 rounded-xl px-3 py-2 border ${String(i + 1) === q.answer ? "border-green-300 bg-green-50" : "border-slate-200 bg-white"}`}>
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

          {/* Open-ended subparts */}
          {!isMcq && q.subparts && q.subparts.length > 0 && (
            <div className="space-y-2 mt-2">
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider">Sub-parts</label>
              {q.subparts.map((sp, i) => (
                <div key={sp.label} className="flex items-start gap-2 rounded-xl bg-white border border-amber-100 px-3 py-2">
                  <span className="font-mono text-xs text-amber-600 mt-2 shrink-0">({sp.label})</span>
                  <textarea
                    value={sp.text}
                    onChange={e => onUpdateSubpart(i, e.target.value)}
                    rows={2}
                    className="flex-1 text-sm bg-transparent focus:outline-none resize-none"
                  />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
