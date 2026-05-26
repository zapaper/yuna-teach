"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

export default function Page() {
  return <Suspense><EnglishOralCompoAdmin /></Suspense>;
}

type Row = {
  id: string; year: string; status: string;
  errorMessage: string | null; pageCount: number | null;
  paper1Pages: number[] | null; paper3Pages: number[] | null; paper4Pages: number[] | null;
  paper1AnswerPages: number[] | null; paper3AnswerPages: number[] | null; paper4AnswerPages: number[] | null;
  createdAt: string; updatedAt: string;
};
type SituationalWriting = { picturePageNum: number | null; scenario: string; audience: string; purpose: string; requirements: string[]; wordCount: string };
type ContinuousPrompt = { optionNum: number; picturePageNum: number | null; brief: string };
type ListeningMcq = { num: number; text: string; options: Array<{ label: string; text: string }>; isImageOptions: boolean; textNum: number | null };
type ListeningText = { textNum: number; content: string; questionNumbers: number[] };
type OralDay = { day: 1 | 2; readingPassage: string; stimulusPicturePageNum: number | null; stimulusDescription: string; conversationPrompts: string[] };
type OralModelAnswer = { day: 1 | 2; q: string; answer: string };
type ListeningAnswer = { num: number; answer: string };
type RowDetail = Row & {
  paper1Text: string | null; paper3Text: string | null; paper4Text: string | null;
  paper1AnswerText: string | null; paper3AnswerText: string | null; paper4AnswerText: string | null;
  situationalWriting: SituationalWriting | null;
  continuousTheme: string | null;
  continuousPrompts: ContinuousPrompt[] | null;
  listeningMcqs: ListeningMcq[] | null;
  listeningTexts: ListeningText[] | null;
  oralDays: OralDay[] | null;
  situationalModel: string | null;
  continuousModel: string | null;
  listeningAnswers: ListeningAnswer[] | null;
  oralModelAnswers: OralModelAnswer[] | null;
};

const STATUS_LABEL: Record<string, string> = {
  uploaded: "Uploaded",
  sectioning: "Detecting sections…",
  "ocr-paper1": "OCR: Paper 1 (Writing)",
  "ocr-paper3": "OCR: Paper 3 (Listening)",
  "ocr-paper4": "OCR: Paper 4 (Oral)",
  "ocr-paper1-answer": "OCR: Paper 1 answers",
  "ocr-paper3-answer": "OCR: Paper 3 answers",
  "ocr-paper4-answer": "OCR: Paper 4 answers",
  structuring: "Structuring…",
  cropping: "Cropping pictures…",
  ready: "Ready",
  failed: "Failed",
};

type SectionKey = "paper1" | "paper3" | "paper4" | "paper1Answer" | "paper3Answer" | "paper4Answer";
const SECTION_LABELS: Record<SectionKey, string> = {
  paper1: "Paper 1 (Writing)",
  paper3: "Paper 3 (Listening)",
  paper4: "Paper 4 (Oral)",
  paper1Answer: "Paper 1 answers / models",
  paper3Answer: "Paper 3 answers",
  paper4Answer: "Paper 4 answers",
};

function EnglishOralCompoAdmin() {
  const userId = useSearchParams().get("userId") ?? "";
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [year, setYear] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RowDetail | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/english-oral-compo");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { rows: Row[] };
      setRows(data.rows);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  // Poll while extraction is in flight.
  useEffect(() => {
    const inFlight = rows.some(r => r.status !== "ready" && r.status !== "failed");
    if (!inFlight) return;
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
  }, [rows, reload]);

  async function loadDetail(id: string) {
    setOpenId(id); setDetail(null);
    const res = await fetch(`/api/admin/english-oral-compo/${id}`);
    if (res.ok) { const data = await res.json() as { row: RowDetail }; setDetail(data.row); }
  }

  async function upload() {
    if (!/^\d{4}$/.test(year)) { setUploadErr("Year must be 4 digits, e.g. 2024"); return; }
    if (!file) { setUploadErr("Pick a PDF first"); return; }
    setUploading(true); setUploadErr(null);
    try {
      const fd = new FormData(); fd.append("year", year); fd.append("pdf", file);
      const res = await fetch("/api/admin/english-oral-compo", { method: "POST", body: fd });
      const data = await res.json() as { error?: string; details?: string };
      if (!res.ok) setUploadErr(data.details || data.error || "Upload failed");
      else { setYear(""); setFile(null); await reload(); }
    } catch (e) {
      setUploadErr(e instanceof Error ? e.message : "Upload failed");
    } finally { setUploading(false); }
  }

  async function remove(id: string) {
    if (!confirm("Delete this row and its PDF?")) return;
    await fetch(`/api/admin/english-oral-compo/${id}`, { method: "DELETE" });
    if (openId === id) { setOpenId(null); setDetail(null); }
    await reload();
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6 max-w-5xl mx-auto">
      <div className="mb-6 flex items-center gap-3">
        <a href={`/admin?userId=${userId}`} className="text-sm text-slate-500 hover:text-slate-700">← Admin</a>
        <h1 className="text-2xl font-bold text-slate-800">English Oral / Compo</h1>
      </div>
      <p className="text-sm text-slate-600 mb-6">
        Upload PSLE English PDFs (Paper 1 Writing, Paper 3 Listening, Paper 4 Oral + answer keys).
        Gemini 3.1-pro auto-detects which pages belong to each section and OCRs them. Used as the
        source for trend analysis (situational topics, picture themes, oral stimulus types).
      </p>

      {/* Upload form */}
      <div className="bg-white rounded-2xl shadow-sm p-5 mb-6 border border-slate-200">
        <h2 className="font-bold text-slate-800 mb-3">Upload PDF</h2>
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Year</label>
            <input value={year} onChange={e => setYear(e.target.value)} placeholder="2024"
              className="border border-slate-300 rounded-lg px-3 py-2 w-24 text-sm" disabled={uploading} />
          </div>
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs font-medium text-slate-500 mb-1">PSLE English PDF</label>
            <label className={`inline-flex items-center gap-2 cursor-pointer border border-slate-300 rounded-lg px-3 py-2 text-sm bg-slate-50 hover:bg-slate-100 ${uploading ? "opacity-50 pointer-events-none" : ""}`}>
              <span className="material-symbols-outlined text-base">attach_file</span>
              <span>{file ? file.name : "Choose PDF…"}</span>
              <input type="file" accept="application/pdf"
                onChange={e => setFile(e.target.files?.[0] ?? null)}
                disabled={uploading} className="hidden" />
            </label>
          </div>
          <button onClick={upload} disabled={uploading || !year || !file}
            className="bg-slate-800 text-white text-sm px-4 py-2 rounded-lg hover:bg-slate-900 disabled:opacity-50">
            {uploading ? "Uploading…" : "Upload & start extraction"}
          </button>
        </div>
        {(!year || !file) && !uploading && (
          <p className="text-xs text-slate-400 mt-2">
            {!year && !file ? "Enter year and choose a PDF to enable extract." : !year ? "Enter the year." : "Choose a PDF file."}
          </p>
        )}
        {uploadErr && <p className="text-xs text-red-600 mt-2">{uploadErr}</p>}
        <p className="text-xs text-slate-400 mt-2">
          Upload returns in a few seconds; extraction runs in background (1-3 min).
          Status walks through sectioning → ocr-* → structuring → ready.
        </p>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-5 border-b border-slate-200 flex items-center justify-between">
          <h2 className="font-bold text-slate-800">Extracted papers</h2>
          {loading && <span className="text-xs text-slate-400">loading…</span>}
        </div>
        {rows.length === 0 && !loading ? (
          <p className="p-8 text-center text-sm text-slate-400">No papers extracted yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 uppercase">
              <tr>
                <th className="px-4 py-2 text-left">Year</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-left">Pages</th>
                <th className="px-4 py-2 text-left">P1 / P3 / P4 / answers</th>
                <th className="px-4 py-2 text-left">Updated</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="border-t border-slate-100">
                  <td className="px-4 py-2 font-semibold">{r.year}</td>
                  <td className="px-4 py-2">
                    <span className={`text-xs ${r.status === "ready" ? "text-green-700" : r.status === "failed" ? "text-red-700" : "text-amber-700"}`}>
                      {STATUS_LABEL[r.status] ?? r.status}
                    </span>
                    {r.errorMessage && <p className="text-[10px] text-red-500 mt-1 max-w-xs truncate" title={r.errorMessage}>{r.errorMessage}</p>}
                  </td>
                  <td className="px-4 py-2 text-slate-600">{r.pageCount ?? "—"}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">
                    {`${r.paper1Pages?.length ?? 0}p / ${r.paper3Pages?.length ?? 0}p / ${r.paper4Pages?.length ?? 0}p / ${(r.paper1AnswerPages?.length ?? 0) + (r.paper3AnswerPages?.length ?? 0) + (r.paper4AnswerPages?.length ?? 0)}p`}
                  </td>
                  <td className="px-4 py-2 text-xs text-slate-500">{new Date(r.updatedAt).toLocaleString()}</td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    <button onClick={() => loadDetail(r.id)} className="text-xs text-blue-600 hover:underline mr-3">View</button>
                    <button onClick={() => remove(r.id)} className="text-xs text-red-600 hover:underline">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Detail modal */}
      {openId && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" onClick={() => { setOpenId(null); setDetail(null); }}>
          <div className="bg-white rounded-2xl max-w-4xl w-full max-h-[90vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            {!detail ? (
              <p className="text-sm text-slate-400">Loading…</p>
            ) : (
              <>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-bold text-slate-800">PSLE English {detail.year}</h2>
                  <button onClick={() => { setOpenId(null); setDetail(null); }} className="text-slate-400 hover:text-slate-700">✕</button>
                </div>
                <p className="text-xs text-slate-500 mb-4">
                  Pages — P1: {(detail.paper1Pages ?? []).join(", ") || "—"} ·
                  P3: {(detail.paper3Pages ?? []).join(", ") || "—"} ·
                  P4: {(detail.paper4Pages ?? []).join(", ") || "—"} ·
                  P1 ans: {(detail.paper1AnswerPages ?? []).join(", ") || "—"} ·
                  P3 ans: {(detail.paper3AnswerPages ?? []).join(", ") || "—"} ·
                  P4 ans: {(detail.paper4AnswerPages ?? []).join(", ") || "—"}
                </p>

                <ReextractPanel
                  paperId={detail.id}
                  initial={{
                    paper1: detail.paper1Pages ?? [],
                    paper3: detail.paper3Pages ?? [],
                    paper4: detail.paper4Pages ?? [],
                    paper1Answer: detail.paper1AnswerPages ?? [],
                    paper3Answer: detail.paper3AnswerPages ?? [],
                    paper4Answer: detail.paper4AnswerPages ?? [],
                  }}
                  onDone={() => loadDetail(detail.id)}
                />
                <PictureReextractPanel detail={detail} onDone={() => loadDetail(detail.id)} />

                <div className="space-y-4 mb-6">
                  {/* Part 1 — Situational Writing (+ auto-cropped picture) */}
                  <div className="border border-sky-200 bg-sky-50 rounded-lg p-4">
                    <h3 className="text-sm font-bold text-sky-800 mb-2">Part 1 — Situational Writing</h3>
                    {detail.situationalWriting ? (
                      <>
                        {detail.situationalWriting.picturePageNum && (
                          <div className="mb-3 max-w-md">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={`/api/admin/english-oral-compo/${detail.id}/picture?kind=situational`}
                              alt="Situational stimulus"
                              className="rounded border border-sky-300 max-w-full"
                              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                            />
                            <p className="text-[10px] text-slate-400 mt-1">Auto-cropped from p.{detail.situationalWriting.picturePageNum}</p>
                          </div>
                        )}
                        <p className="text-xs text-slate-500 mb-1">Scenario</p>
                        <p className="text-sm text-slate-700 mb-3 whitespace-pre-wrap">{detail.situationalWriting.scenario || "—"}</p>
                        <div className="grid grid-cols-2 gap-3 mb-3">
                          <div>
                            <p className="text-xs text-slate-500 mb-1">Audience</p>
                            <p className="text-sm text-slate-700">{detail.situationalWriting.audience || "—"}</p>
                          </div>
                          <div>
                            <p className="text-xs text-slate-500 mb-1">Word count</p>
                            <p className="text-sm text-slate-700">{detail.situationalWriting.wordCount || "—"}</p>
                          </div>
                        </div>
                        <p className="text-xs text-slate-500 mb-1">Purpose</p>
                        <p className="text-sm text-slate-700 mb-3">{detail.situationalWriting.purpose || "—"}</p>
                        <p className="text-xs text-slate-500 mb-1">Must address ({detail.situationalWriting.requirements.length})</p>
                        <ul className="list-disc pl-5 text-sm text-slate-700 space-y-1">
                          {detail.situationalWriting.requirements.map((r, i) => <li key={i}>{r}</li>)}
                        </ul>
                      </>
                    ) : (
                      <p className="text-xs text-slate-400 italic">(not detected)</p>
                    )}
                  </div>

                  {/* Part 2 — Continuous Writing: theme + 3 picture prompts */}
                  <div className="border border-sky-200 bg-sky-50 rounded-lg p-4">
                    <h3 className="text-sm font-bold text-sky-800 mb-2">
                      Part 2 — Continuous Writing ({detail.continuousPrompts?.length ?? 0} picture prompts)
                    </h3>
                    {detail.continuousTheme && (
                      <div className="mb-3 px-3 py-2 bg-white rounded border border-sky-300">
                        <span className="text-[10px] uppercase text-slate-500 tracking-wider mr-2">Theme</span>
                        <span className="text-lg font-extrabold text-sky-900">{detail.continuousTheme}</span>
                      </div>
                    )}
                    {detail.continuousPrompts?.length ? (
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        {detail.continuousPrompts.map(cp => (
                          <div key={cp.optionNum} className="border border-sky-300 rounded bg-white p-2">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={`/api/admin/english-oral-compo/${detail.id}/picture?kind=continuous_${cp.optionNum}`}
                              alt={`Option ${cp.optionNum}`}
                              className="rounded max-w-full mb-2"
                              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                            />
                            <p className="text-xs font-semibold text-sky-900">Option {cp.optionNum} <span className="text-slate-400 font-normal">(p.{cp.picturePageNum ?? "?"})</span></p>
                            <p className="text-xs text-slate-700 mt-1">{cp.brief}</p>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-slate-400 italic">(not detected)</p>
                    )}
                  </div>

                  {/* Listening MCQs + Texts. MCQ options are usually
                      picture-based on PSLE Paper 3, so we show the
                      auto-cropped JPG of each question instead of
                      OCR'd option text. Falls back to text rendering
                      below if the option text was captured (some PDFs
                      have text-only listening MCQs). */}
                  <div className="border border-indigo-200 bg-indigo-50 rounded-lg p-4">
                    <h3 className="text-sm font-bold text-indigo-800 mb-2">
                      Paper 3 Listening — {detail.listeningMcqs?.length ?? 0} MCQs · {detail.listeningTexts?.length ?? 0} Texts
                    </h3>
                    {detail.listeningMcqs?.length ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-3">
                        {detail.listeningMcqs.map(mcq => (
                          <div key={mcq.num} className="border border-indigo-200 bg-white rounded p-2">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="font-semibold text-indigo-900 text-sm">Q{mcq.num}</span>
                              {mcq.textNum && <span className="text-[10px] bg-indigo-100 text-indigo-800 px-1 rounded">Text {mcq.textNum}</span>}
                            </div>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              src={`/api/admin/english-oral-compo/${detail.id}/picture?kind=listening_q${mcq.num}`}
                              alt={`Listening Q${mcq.num}`}
                              className="rounded max-w-full"
                              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                            />
                            {mcq.text && !mcq.isImageOptions && (
                              <p className="text-xs text-slate-700 mt-1">{mcq.text}</p>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : <p className="text-xs text-slate-400 italic mb-3">(no MCQs detected)</p>}
                    {detail.listeningTexts?.length ? (
                      <div className="space-y-2">
                        {detail.listeningTexts.map(t => (
                          <details key={t.textNum} className="border border-indigo-200 rounded bg-white">
                            <summary className="cursor-pointer px-3 py-1.5 text-xs font-semibold text-indigo-900">
                              Text {t.textNum} <span className="text-slate-400 font-normal">→ Q{t.questionNumbers.join(", Q")}</span>
                            </summary>
                            <p className="px-3 pb-3 pt-1 text-xs text-slate-700 whitespace-pre-wrap">{t.content}</p>
                          </details>
                        ))}
                      </div>
                    ) : <p className="text-xs text-slate-400 italic">(no texts detected)</p>}
                  </div>

                  {/* Paper 4 — Oral, per Day */}
                  <div className="border border-amber-200 bg-amber-50 rounded-lg p-4">
                    <h3 className="text-sm font-bold text-amber-800 mb-2">Paper 4 — Oral ({detail.oralDays?.length ?? 0} day{detail.oralDays?.length === 1 ? "" : "s"})</h3>
                    {detail.oralDays?.length ? (
                      <div className="space-y-4">
                        {detail.oralDays.map(day => (
                          <div key={day.day} className="border border-amber-300 rounded bg-white p-3">
                            <h4 className="text-sm font-extrabold text-amber-900 mb-2">Day {day.day}</h4>
                            <p className="text-xs text-slate-500 mb-1">Reading Aloud Passage</p>
                            <p className="text-xs text-slate-700 whitespace-pre-wrap mb-3">{day.readingPassage || "—"}</p>
                            {day.stimulusPicturePageNum && (
                              <div className="mb-3 max-w-md">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={`/api/admin/english-oral-compo/${detail.id}/picture?kind=oral_day${day.day}_stimulus`}
                                  alt={`Day ${day.day} stimulus`}
                                  className="rounded border border-amber-300 max-w-full"
                                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
                                />
                                <p className="text-[10px] text-slate-400 mt-1">Auto-cropped from p.{day.stimulusPicturePageNum} (rotated 90° CW)</p>
                              </div>
                            )}
                            <p className="text-xs text-slate-500 mb-1">Stimulus description</p>
                            <p className="text-xs text-slate-700 mb-3">{day.stimulusDescription || "—"}</p>
                            <p className="text-xs text-slate-500 mb-1">Conversation prompts ({day.conversationPrompts.length})</p>
                            <ol className="list-decimal pl-5 text-xs text-slate-700 space-y-1">
                              {day.conversationPrompts.map((q, i) => <li key={i}>{q}</li>)}
                            </ol>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-slate-400 italic">(not detected)</p>
                    )}
                  </div>

                  {/* Listening answers */}
                  <div className="border border-emerald-200 bg-emerald-50 rounded-lg p-4">
                    <h3 className="text-sm font-bold text-emerald-800 mb-2">Listening Answers</h3>
                    {detail.listeningAnswers?.length ? (
                      <div className="flex flex-wrap gap-2 text-sm">
                        {detail.listeningAnswers.map(a => (
                          <span key={a.num} className="px-2 py-0.5 bg-white border border-emerald-200 rounded font-mono text-xs">
                            Q{a.num}: {a.answer}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-slate-400 italic">(not detected)</p>
                    )}
                  </div>

                  {/* Oral model answers (per day, per question a/b/c) */}
                  {detail.oralModelAnswers?.length ? (
                    <div className="border border-emerald-200 bg-emerald-50 rounded-lg p-4">
                      <h3 className="text-sm font-bold text-emerald-800 mb-2">Oral — SBC Model Answers ({detail.oralModelAnswers.length})</h3>
                      <div className="space-y-2">
                        {[1, 2].map(day => {
                          const items = detail.oralModelAnswers!.filter(a => a.day === day);
                          if (items.length === 0) return null;
                          return (
                            <div key={day} className="border border-emerald-200 rounded bg-white p-2">
                              <p className="text-xs font-extrabold text-emerald-900 mb-1">Day {day}</p>
                              {items.map((it, i) => (
                                <div key={i} className="mb-2">
                                  <p className="text-xs font-semibold text-emerald-800">({it.q})</p>
                                  <p className="text-xs text-slate-700 whitespace-pre-wrap">{it.answer}</p>
                                </div>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}

                  {/* Model essays */}
                  {(["situationalModel", "continuousModel"] as const).map(key => {
                    const label = key === "situationalModel" ? "Situational Writing — Model Essay" : "Continuous Writing — Model Essay";
                    const text = detail[key];
                    return (
                      <details key={key} className="border border-emerald-200 bg-emerald-50 rounded-lg" open>
                        <summary className="cursor-pointer px-4 py-2 font-bold text-sm text-emerald-800">
                          {label} {text ? `(${text.length} chars)` : "(not detected)"}
                        </summary>
                        {text && <p className="px-4 pb-4 text-sm text-slate-700 whitespace-pre-wrap">{text}</p>}
                      </details>
                    );
                  })}
                </div>

                {/* Raw OCR (debug) */}
                <details className="mb-3 border border-slate-200 rounded-lg">
                  <summary className="cursor-pointer px-4 py-2 bg-slate-100 font-semibold text-sm text-slate-700">
                    🔧 Raw OCR text (debug)
                  </summary>
                  <div className="p-3 space-y-2">
                    {(["paper1Text", "paper3Text", "paper4Text", "paper1AnswerText", "paper3AnswerText", "paper4AnswerText"] as const).map(key => {
                      const label = {
                        paper1Text: "Paper 1 raw",
                        paper3Text: "Paper 3 raw",
                        paper4Text: "Paper 4 raw",
                        paper1AnswerText: "Paper 1 answer raw",
                        paper3AnswerText: "Paper 3 answer raw",
                        paper4AnswerText: "Paper 4 answer raw",
                      }[key];
                      const text = detail[key];
                      return (
                        <details key={key} className="border border-slate-200 rounded">
                          <summary className="cursor-pointer px-3 py-1 bg-slate-50 text-xs font-semibold text-slate-600">
                            {label} {text ? `(${text.length} chars)` : "(empty)"}
                          </summary>
                          <pre className="p-3 text-[10px] whitespace-pre-wrap break-words text-slate-600 max-h-72 overflow-y-auto">
                            {text || "(no text)"}
                          </pre>
                        </details>
                      );
                    })}
                  </div>
                </details>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ReextractPanel({
  paperId, initial, onDone,
}: {
  paperId: string;
  initial: Record<SectionKey, number[]>;
  onDone: () => void;
}) {
  const [inputs, setInputs] = useState<Record<SectionKey, string>>({
    paper1: initial.paper1.join(","),
    paper3: initial.paper3.join(","),
    paper4: initial.paper4.join(","),
    paper1Answer: initial.paper1Answer.join(","),
    paper3Answer: initial.paper3Answer.join(","),
    paper4Answer: initial.paper4Answer.join(","),
  });
  const [working, setWorking] = useState<SectionKey | null>(null);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  async function run(section: SectionKey) {
    const pages = inputs[section]
      .split(/[,\s]+/).map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
    if (pages.length === 0) { setMsg({ type: "err", text: "Enter at least one page number" }); return; }
    setWorking(section); setMsg(null);
    try {
      const res = await fetch(`/api/admin/english-oral-compo/${paperId}/reextract`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ section, pages }),
      });
      const data = await res.json() as { error?: string; details?: string; textLength?: number };
      if (!res.ok) setMsg({ type: "err", text: data.details || data.error || "Re-extract failed" });
      else { setMsg({ type: "ok", text: `${SECTION_LABELS[section]} re-extracted (${data.textLength} chars). Reloading…` }); onDone(); }
    } finally { setWorking(null); }
  }

  return (
    <details className="mb-4 border border-amber-300 rounded-lg bg-amber-50">
      <summary className="cursor-pointer px-3 py-2 text-xs font-bold text-amber-800">
        🛠️ Re-extract section from specific pages (override auto-detect)
      </summary>
      <div className="p-3 space-y-2">
        <p className="text-xs text-slate-600 mb-2">
          Type 1-indexed page numbers for the section (e.g. <code className="bg-white px-1 rounded">2, 3</code>) then click Re-extract.
          Only the OCR + structured fields for that section get overwritten.
        </p>
        {(["paper1", "paper3", "paper4", "paper1Answer", "paper3Answer", "paper4Answer"] as SectionKey[]).map(key => (
          <div key={key} className="flex items-center gap-2">
            <label className="text-xs font-semibold text-slate-700 w-44">{SECTION_LABELS[key]}</label>
            <input
              value={inputs[key]}
              onChange={e => setInputs({ ...inputs, [key]: e.target.value })}
              placeholder="e.g. 2, 3"
              className="flex-1 border border-slate-300 rounded px-2 py-1 text-xs font-mono"
              disabled={!!working}
            />
            <button onClick={() => run(key)} disabled={!!working}
              className="bg-amber-700 text-white text-xs px-3 py-1 rounded hover:bg-amber-800 disabled:opacity-50">
              {working === key ? "Working…" : "Re-extract"}
            </button>
          </div>
        ))}
        {msg && <p className={`text-xs ${msg.type === "ok" ? "text-emerald-700" : "text-red-600"}`}>{msg.text}</p>}
      </div>
    </details>
  );
}

// Per-picture re-extract panel. Each row: picture kind, current
// page-number override, "Re-crop (auto)" + "Crop full page" buttons.
// Calls POST /api/admin/english-oral-compo/[id]/recrop-picture which
// updates the structured field's picturePageNum (if changed) and
// regenerates the cropped JPG on disk.
function PictureReextractPanel({ detail, onDone }: { detail: RowDetail; onDone: () => void }) {
  const targets: Array<{ kind: string; label: string; defaultPage: number | null }> = [];
  if (detail.situationalWriting) {
    targets.push({ kind: "situational", label: "Situational stimulus picture", defaultPage: detail.situationalWriting.picturePageNum });
  }
  for (const cp of detail.continuousPrompts ?? []) {
    targets.push({ kind: `continuous_${cp.optionNum}`, label: `Continuous option ${cp.optionNum}`, defaultPage: cp.picturePageNum });
  }
  for (const day of detail.oralDays ?? []) {
    targets.push({ kind: `oral_day${day.day}_stimulus`, label: `Oral Day ${day.day} stimulus (rotated 90°)`, defaultPage: day.stimulusPicturePageNum });
  }
  // Listening MCQs — per-question re-extract. defaultPage is unknown
  // (we don't store a per-Q page in the schema), so the admin must
  // type the right page from the PDF.
  for (const mcq of detail.listeningMcqs ?? []) {
    targets.push({ kind: `listening_q${mcq.num}`, label: `Listening Q${mcq.num}`, defaultPage: null });
  }

  const [inputs, setInputs] = useState<Record<string, string>>(() =>
    Object.fromEntries(targets.map(t => [t.kind, t.defaultPage ? String(t.defaultPage) : ""])),
  );
  const [working, setWorking] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: string; type: "ok" | "err"; text: string } | null>(null);

  async function run(kind: string, useFullPage: boolean) {
    const raw = inputs[kind].trim();
    const pageNum = raw ? parseInt(raw, 10) : undefined;
    if (raw && (!Number.isFinite(pageNum) || (pageNum as number) <= 0)) {
      setMsg({ kind, type: "err", text: "Page number must be a positive integer" }); return;
    }
    setWorking(kind); setMsg(null);
    try {
      const res = await fetch(`/api/admin/english-oral-compo/${detail.id}/recrop-picture`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, pageNum, useFullPage }),
      });
      const data = await res.json() as { error?: string; details?: string; pageNum?: number };
      if (!res.ok) {
        setMsg({ kind, type: "err", text: data.details || data.error || "Re-crop failed" });
      } else {
        setMsg({ kind, type: "ok", text: `Cropped from p.${data.pageNum}${useFullPage ? " (full page)" : ""}.` });
        onDone();
      }
    } finally {
      setWorking(null);
    }
  }

  if (targets.length === 0) return null;
  return (
    <details className="mb-4 border border-purple-300 rounded-lg bg-purple-50">
      <summary className="cursor-pointer px-3 py-2 text-xs font-bold text-purple-800">
        🖼️ Re-extract / re-crop individual pictures
      </summary>
      <div className="p-3 space-y-2">
        <p className="text-xs text-slate-600 mb-2">
          Leave the page number unchanged to just re-crop. Change the page number to point at the right page first, then re-crop.
          &ldquo;Auto&rdquo; uses Gemini to find the picture&apos;s bounding box; &ldquo;Full page&rdquo; uses the whole page (use this when auto cuts off part of the image).
        </p>
        {targets.map(t => (
          <div key={t.kind} className="border border-purple-200 bg-white rounded p-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-semibold text-slate-700 flex-1">{t.label}</span>
              <span className="text-[10px] text-slate-400">current p.{t.defaultPage ?? "?"}</span>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[10px] text-slate-500">Page:</label>
              <input
                value={inputs[t.kind] ?? ""}
                onChange={e => setInputs(prev => ({ ...prev, [t.kind]: e.target.value }))}
                placeholder={t.defaultPage ? String(t.defaultPage) : "e.g. 3"}
                className="w-16 border border-slate-300 rounded px-2 py-1 text-xs font-mono"
                disabled={!!working}
              />
              <button onClick={() => run(t.kind, false)} disabled={!!working}
                className="bg-purple-700 text-white text-xs px-2 py-1 rounded hover:bg-purple-800 disabled:opacity-50">
                {working === t.kind ? "Cropping…" : "Re-crop (auto)"}
              </button>
              <button onClick={() => run(t.kind, true)} disabled={!!working}
                className="bg-purple-500 text-white text-xs px-2 py-1 rounded hover:bg-purple-600 disabled:opacity-50">
                Full page
              </button>
            </div>
            {msg?.kind === t.kind && (
              <p className={`text-[11px] mt-1 ${msg.type === "ok" ? "text-emerald-700" : "text-red-600"}`}>{msg.text}</p>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
