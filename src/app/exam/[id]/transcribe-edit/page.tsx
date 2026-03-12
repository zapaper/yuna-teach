"use client";

import { Suspense, use, useEffect, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function TranscribeEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <Suspense>
      <TranscribeEditContent id={id} />
    </Suspense>
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

type DiagramBounds = { top: number; left: number; bottom: number; right: number };

type EditQuestion = {
  id: string;
  type: "mcq" | "open";
  questionNum: string;
  answer: string;
  syllabusTopic: string | null;
  marksAvailable: number | null;
  stem: string;
  options: [string, string, string, string] | null;
  subparts: { label: string; text: string }[] | null;
  diagramBounds: DiagramBounds | null;
  diagramBase64: string | null;
  /** The original question image (for re-cropping) */
  imageData?: string;
  error: string | null;
};

// ─── Main content ─────────────────────────────────────────────────────────────

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
  const [reCropping, setReCropping] = useState<string | null>(null);

  // Load saved transcription or detect if empty
  useEffect(() => {
    async function load() {
      try {
        const [savedRes, paperRes] = await Promise.all([
          fetch(`/api/exam/${id}/transcribe-mcq`),
          fetch(`/api/exam/${id}?summary=true`),
        ]);
        if (paperRes.ok) {
          const pd = await paperRes.json();
          setPaperTitle(pd.title ?? "");
        }
        if (savedRes.ok) {
          const data = await savedRes.json();
          if (data.hasSaved && data.questions.length > 0) {
            // Convert DB format → edit format
            setQuestions(
              data.questions.map((q: {
                id: string;
                questionNum: string;
                answer: string | null;
                syllabusTopic: string | null;
                marksAvailable: number | null;
                transcribedStem: string | null;
                transcribedOptions: string[] | null;
                transcribedSubparts: { label: string; text: string }[] | null;
                diagramBounds: DiagramBounds | null;
                diagramImageData: string | null;
              }) => {
                const isMcq = !!(q.transcribedOptions);
                return {
                  id: q.id,
                  type: isMcq ? "mcq" : "open",
                  questionNum: q.questionNum,
                  answer: q.answer ?? "",
                  syllabusTopic: q.syllabusTopic,
                  marksAvailable: q.marksAvailable,
                  stem: q.transcribedStem ?? "",
                  options: q.transcribedOptions as [string, string, string, string] | null,
                  subparts: q.transcribedSubparts ?? null,
                  diagramBounds: q.diagramBounds ?? null,
                  diagramBase64: q.diagramImageData ?? null,
                  error: null,
                };
              })
            );
          }
        }
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

  // Generate from AI
  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    try {
      // Fetch question imageData for re-cropping later
      const [genRes, paperRes] = await Promise.all([
        fetch(`/api/exam/${id}/transcribe-mcq`, { method: "POST" }),
        fetch(`/api/exam/${id}`),
      ]);
      const genData = await genRes.json();
      if (!genRes.ok) throw new Error(genData.error ?? "Failed");

      // Build imageData map from full paper for re-crop support
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
          imageData: imgMap[q.id],
        }))
      );
    } catch (e) {
      alert(e instanceof Error ? e.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }, [id]);

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
            options: q.options,
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

  // Re-crop a single question diagram
  async function handleReCrop(questionId: string, bounds: DiagramBounds) {
    setReCropping(questionId);
    try {
      const res = await fetch(`/api/exam/${id}/transcribe-mcq/crop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId, bounds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Crop failed");
      setQuestions(qs => qs.map(q =>
        q.id === questionId ? { ...q, diagramBase64: data.diagramBase64, diagramBounds: bounds } : q
      ));
    } catch (e) {
      alert(e instanceof Error ? e.message : "Crop failed");
    } finally {
      setReCropping(null);
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
          <p className="text-slate-500 text-sm mb-4">No clean questions saved yet. Generate them from AI first.</p>
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="px-5 py-2.5 rounded-xl bg-violet-500 text-white text-sm font-medium disabled:opacity-50"
          >
            {generating ? (
              <span className="inline-flex items-center gap-2">
                <span className="animate-spin rounded-full h-4 w-4 border-2 border-violet-200 border-t-white" />
                Generating…
              </span>
            ) : "Generate Clean Questions from AI"}
          </button>
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
                examId={id}
                reCropping={reCropping}
                onUpdateStem={stem => updateQuestion(q.id, { stem })}
                onUpdateOption={(i, v) => updateOption(q.id, i, v)}
                onUpdateSubpart={(i, v) => updateSubpart(q.id, i, v)}
                onUpdateBounds={bounds => updateQuestion(q.id, { diagramBounds: bounds })}
                onReCrop={() => q.diagramBounds && handleReCrop(q.id, q.diagramBounds)}
                onRemoveDiagram={() => updateQuestion(q.id, { diagramBounds: null, diagramBase64: null })}
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
  examId,
  reCropping,
  onUpdateStem,
  onUpdateOption,
  onUpdateSubpart,
  onUpdateBounds,
  onReCrop,
  onRemoveDiagram,
}: {
  question: EditQuestion;
  examId: string;
  reCropping: string | null;
  onUpdateStem: (v: string) => void;
  onUpdateOption: (i: number, v: string) => void;
  onUpdateSubpart: (i: number, v: string) => void;
  onUpdateBounds: (b: DiagramBounds) => void;
  onReCrop: () => void;
  onRemoveDiagram: () => void;
}) {
  const isMcq = q.type === "mcq";
  const cardBg = isMcq ? "bg-slate-50 border-slate-200" : "bg-amber-50 border-amber-200";

  function nudgeBound(key: keyof DiagramBounds, delta: number) {
    const cur = q.diagramBounds ?? { top: 10, left: 10, bottom: 90, right: 90 };
    onUpdateBounds({ ...cur, [key]: Math.max(0, Math.min(100, Math.round((cur[key] + delta) * 10) / 10)) });
  }

  return (
    <div className={`rounded-2xl border p-4 ${cardBg}`}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
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
          {/* Stem */}
          <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Question</label>
          <textarea
            value={q.stem}
            onChange={e => onUpdateStem(e.target.value)}
            rows={3}
            className="w-full text-sm rounded-xl border border-slate-200 bg-white px-3 py-2 focus:outline-none focus:border-primary-400 resize-y mb-3"
          />

          {/* Diagram section */}
          {q.diagramBounds && (
            <div className="mb-3 rounded-xl border border-slate-200 bg-white p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Diagram Crop</span>
                <button onClick={onRemoveDiagram} className="text-xs text-red-400 hover:text-red-600">Remove</button>
              </div>

              {/* Current crop preview */}
              {q.diagramBase64 && (
                <img
                  src={`data:image/jpeg;base64,${q.diagramBase64}`}
                  alt="diagram"
                  className="w-full rounded-lg border border-slate-100 mb-3"
                />
              )}

              {/* Bounds adjusters */}
              <div className="grid grid-cols-2 gap-2 mb-3">
                {(["top", "left", "bottom", "right"] as const).map(key => (
                  <div key={key} className="flex items-center gap-1.5 bg-slate-50 rounded-lg px-2 py-1.5">
                    <span className="text-xs text-slate-500 w-10 capitalize">{key}</span>
                    <button
                      onClick={() => nudgeBound(key, -1)}
                      className="w-6 h-6 flex items-center justify-center rounded-md bg-slate-200 text-slate-600 text-xs hover:bg-slate-300 font-bold"
                    >−</button>
                    <span className="text-xs font-mono text-slate-700 w-10 text-center">
                      {q.diagramBounds ? Math.round(q.diagramBounds[key]) : 0}%
                    </span>
                    <button
                      onClick={() => nudgeBound(key, 1)}
                      className="w-6 h-6 flex items-center justify-center rounded-md bg-slate-200 text-slate-600 text-xs hover:bg-slate-300 font-bold"
                    >+</button>
                  </div>
                ))}
              </div>

              <button
                onClick={onReCrop}
                disabled={reCropping === q.id}
                className="w-full py-2 rounded-xl bg-slate-700 text-white text-xs font-medium hover:bg-slate-800 disabled:opacity-50"
              >
                {reCropping === q.id ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="animate-spin rounded-full h-3 w-3 border-2 border-slate-400 border-t-white" />
                    Re-cropping…
                  </span>
                ) : "Preview Crop"}
              </button>
            </div>
          )}

          {/* MCQ options */}
          {isMcq && q.options && (
            <div className="space-y-2">
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider">Options</label>
              {q.options.map((opt, i) => (
                <div key={i} className={`flex items-start gap-2 rounded-xl px-3 py-2 border ${String(i + 1) === q.answer ? "border-green-300 bg-green-50" : "border-slate-200 bg-white"}`}>
                  <span className="font-mono text-xs text-slate-400 mt-2 shrink-0 w-5">({i + 1})</span>
                  <textarea
                    value={opt}
                    onChange={e => onUpdateOption(i, e.target.value)}
                    rows={1}
                    className="flex-1 text-sm bg-transparent focus:outline-none resize-none"
                  />
                </div>
              ))}
            </div>
          )}

          {/* Open-ended subparts */}
          {!isMcq && q.subparts && q.subparts.length > 0 && (
            <div className="space-y-2">
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
