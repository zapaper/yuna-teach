"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

export default function Page() {
  return (
    <Suspense>
      <ChineseOralCompoAdmin />
    </Suspense>
  );
}

type Row = {
  id: string;
  year: string;
  status: string;
  errorMessage: string | null;
  pageCount: number | null;
  paper1Pages: number[] | null;
  paper3Pages: number[] | null;
  paper1AnswerPages: number[] | null;
  paper3AnswerPages: number[] | null;
  createdAt: string;
  updatedAt: string;
};

type CompoOption2 = {
  instructions: string;
  helpingWords: string[];
  picturePageNum: number | null;
};
type ListeningMcq = {
  num: number;
  text: string;
  options: Array<{ label: string; text: string }>;
  isImageOptions: boolean;
};
type ListeningPassage = { num: number; text: string; questionNumbers: number[] };
type ListeningAnswer = { num: number; answer: string };

type RowDetail = Row & {
  paper1Text: string | null;
  paper3Text: string | null;
  paper1AnswerText: string | null;
  paper3AnswerText: string | null;
  compoOption1Topic: string | null;
  compoOption2: CompoOption2 | null;
  listeningMcqs: ListeningMcq[] | null;
  listeningPassages: ListeningPassage[] | null;
  compoOption1Model: string | null;
  compoOption2Model: string | null;
  listeningAnswers: ListeningAnswer[] | null;
};

const STATUS_LABEL: Record<string, string> = {
  uploaded: "Uploaded",
  sectioning: "Detecting sections…",
  "ocr-paper1": "OCR: Paper 1 (作文)",
  "ocr-paper3": "OCR: Paper 3 (口试)",
  "ocr-paper1-answer": "OCR: Paper 1 answers",
  "ocr-paper3-answer": "OCR: Paper 3 answers",
  structuring: "Structuring (topics, MCQs, passages)…",
  ready: "Ready",
  failed: "Failed",
};

function ChineseOralCompoAdmin() {
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
      const res = await fetch("/api/admin/chinese-oral-compo");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { rows: Row[] };
      setRows(data.rows);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  // Poll while any row is mid-pipeline so the UI keeps up with the
  // backend's status writes (sectioning → ocr-paper1 → … → ready).
  useEffect(() => {
    const inFlight = rows.some(r => r.status !== "ready" && r.status !== "failed");
    if (!inFlight) return;
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
  }, [rows, reload]);

  async function loadDetail(id: string) {
    setOpenId(id);
    setDetail(null);
    const res = await fetch(`/api/admin/chinese-oral-compo/${id}`);
    if (res.ok) {
      const data = await res.json() as { row: RowDetail };
      setDetail(data.row);
    }
  }

  async function upload() {
    if (!/^\d{4}$/.test(year)) { setUploadErr("Year must be 4 digits, e.g. 2018"); return; }
    if (!file) { setUploadErr("Pick a PDF first"); return; }
    setUploading(true); setUploadErr(null);
    try {
      const fd = new FormData();
      fd.append("year", year);
      fd.append("pdf", file);
      const res = await fetch("/api/admin/chinese-oral-compo", { method: "POST", body: fd });
      const data = await res.json() as { error?: string; details?: string };
      if (!res.ok) {
        setUploadErr(data.details || data.error || "Upload failed");
      } else {
        setYear(""); setFile(null);
        await reload();
      }
    } catch (e) {
      setUploadErr(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function remove(id: string) {
    if (!confirm("Delete this row and its PDF?")) return;
    await fetch(`/api/admin/chinese-oral-compo/${id}`, { method: "DELETE" });
    if (openId === id) { setOpenId(null); setDetail(null); }
    await reload();
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6 max-w-5xl mx-auto">
      <div className="mb-6 flex items-center gap-3">
        <a href={`/admin?userId=${userId}`} className="text-sm text-slate-500 hover:text-slate-700">← Admin</a>
        <h1 className="text-2xl font-bold text-slate-800">Chinese Oral / Compo</h1>
      </div>
      <p className="text-sm text-slate-600 mb-6">
        Upload PSLE Chinese PDFs (containing Paper 1 作文, Paper 2, Paper 3 口试 + answer keys).
        Gemini 3.1-pro auto-detects which pages belong to Paper 1 and Paper 3, then OCRs each
        section. Used as the source for trend analysis (compo topics, oral phrases).
      </p>

      <div className="bg-white rounded-2xl shadow-sm p-5 mb-6 border border-slate-200">
        <h2 className="font-bold text-slate-800 mb-3">Upload PDF</h2>
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Year</label>
            <input value={year} onChange={e => setYear(e.target.value)} placeholder="2018"
              className="border border-slate-300 rounded-lg px-3 py-2 w-24 text-sm" disabled={uploading} />
          </div>
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs font-medium text-slate-500 mb-1">PSLE Chinese PDF</label>
            <input type="file" accept="application/pdf" onChange={e => setFile(e.target.files?.[0] ?? null)}
              className="text-sm" disabled={uploading} />
          </div>
          <button onClick={upload} disabled={uploading || !year || !file}
            className="bg-slate-800 text-white text-sm px-4 py-2 rounded-lg hover:bg-slate-900 disabled:opacity-50">
            {uploading ? "Extracting… (1-3 min)" : "Upload & extract"}
          </button>
        </div>
        {uploadErr && <p className="text-xs text-red-600 mt-2">{uploadErr}</p>}
        <p className="text-xs text-slate-400 mt-2">
          Re-uploading an existing year replaces the previous extraction.
        </p>
      </div>

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
                <th className="px-4 py-2 text-left">P1 / P3 / P1-ans / P3-ans</th>
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
                    {`${r.paper1Pages?.length ?? 0}p / ${r.paper3Pages?.length ?? 0}p / ${r.paper1AnswerPages?.length ?? 0}p / ${r.paper3AnswerPages?.length ?? 0}p`}
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

      {openId && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" onClick={() => { setOpenId(null); setDetail(null); }}>
          <div className="bg-white rounded-2xl max-w-4xl w-full max-h-[90vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
            {!detail ? (
              <p className="text-sm text-slate-400">Loading…</p>
            ) : (
              <>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-xl font-bold text-slate-800">PSLE Chinese {detail.year}</h2>
                  <button onClick={() => { setOpenId(null); setDetail(null); }} className="text-slate-400 hover:text-slate-700">✕</button>
                </div>
                <p className="text-xs text-slate-500 mb-4">
                  Pages detected — Paper 1: {(detail.paper1Pages ?? []).join(", ") || "—"} · Paper 3: {(detail.paper3Pages ?? []).join(", ") || "—"} · P1 ans: {(detail.paper1AnswerPages ?? []).join(", ") || "—"} · P3 ans: {(detail.paper3AnswerPages ?? []).join(", ") || "—"}
                </p>

                {/* === Structured extraction (Phase 2) === */}
                <div className="space-y-4 mb-6">
                  {/* Compo Option 1 — topic */}
                  <div className="border border-fuchsia-200 bg-fuchsia-50 rounded-lg p-4">
                    <h3 className="text-sm font-bold text-fuchsia-800 mb-1">第一题 (Option 1) — Composition topic</h3>
                    {detail.compoOption1Topic ? (
                      <p className="text-base text-slate-800 font-medium">{detail.compoOption1Topic}</p>
                    ) : (
                      <p className="text-xs text-slate-400 italic">(not detected)</p>
                    )}
                  </div>

                  {/* Compo Option 2 — picture + instructions + helping words */}
                  <div className="border border-fuchsia-200 bg-fuchsia-50 rounded-lg p-4">
                    <h3 className="text-sm font-bold text-fuchsia-800 mb-2">第二题 (Option 2) — Picture composition</h3>
                    {detail.compoOption2 ? (
                      <>
                        <p className="text-xs text-slate-500 mb-1">Instructions</p>
                        <p className="text-sm text-slate-700 mb-3">{detail.compoOption2.instructions || "—"}</p>
                        <p className="text-xs text-slate-500 mb-1">Picture page</p>
                        <p className="text-sm text-slate-700 mb-3">{detail.compoOption2.picturePageNum ?? "—"}</p>
                        <p className="text-xs text-slate-500 mb-1">Helping words ({detail.compoOption2.helpingWords.length})</p>
                        <div className="flex flex-wrap gap-1">
                          {detail.compoOption2.helpingWords.map((w, i) => (
                            <span key={i} className="text-xs px-2 py-0.5 bg-white border border-fuchsia-200 rounded">
                              {w}
                            </span>
                          ))}
                        </div>
                      </>
                    ) : (
                      <p className="text-xs text-slate-400 italic">(not detected)</p>
                    )}
                  </div>

                  {/* Listening MCQs */}
                  <div className="border border-indigo-200 bg-indigo-50 rounded-lg p-4">
                    <h3 className="text-sm font-bold text-indigo-800 mb-2">
                      听力 MCQs ({detail.listeningMcqs?.length ?? 0})
                    </h3>
                    {detail.listeningMcqs?.length ? (
                      <ol className="space-y-2 text-sm">
                        {detail.listeningMcqs.map(mcq => (
                          <li key={mcq.num} className="border-l-2 border-indigo-300 pl-2">
                            <span className="font-semibold text-indigo-900">Q{mcq.num}</span>
                            {mcq.text && <span className="text-slate-700 ml-1">{mcq.text}</span>}
                            {mcq.isImageOptions && <span className="text-[10px] text-indigo-500 ml-1">(image options)</span>}
                            <ul className="ml-4 mt-1 text-xs text-slate-600">
                              {mcq.options.map((opt, i) => (
                                <li key={i}><span className="font-mono">{opt.label}</span> {opt.text}</li>
                              ))}
                            </ul>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="text-xs text-slate-400 italic">(not detected)</p>
                    )}
                  </div>

                  {/* Listening Passages */}
                  <div className="border border-indigo-200 bg-indigo-50 rounded-lg p-4">
                    <h3 className="text-sm font-bold text-indigo-800 mb-2">
                      听力 Passages ({detail.listeningPassages?.length ?? 0})
                    </h3>
                    {detail.listeningPassages?.length ? (
                      <ol className="space-y-2 text-sm">
                        {detail.listeningPassages.map(p => (
                          <li key={p.num} className="border-l-2 border-indigo-300 pl-2">
                            <p className="font-semibold text-indigo-900">
                              Passage {p.num} → Q{p.questionNumbers.join(", Q")}
                            </p>
                            <p className="text-xs text-slate-700 whitespace-pre-wrap mt-1">{p.text}</p>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="text-xs text-slate-400 italic">(not detected)</p>
                    )}
                  </div>

                  {/* Listening Answers */}
                  <div className="border border-emerald-200 bg-emerald-50 rounded-lg p-4">
                    <h3 className="text-sm font-bold text-emerald-800 mb-2">听力答案 (Listening answers)</h3>
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

                  {/* Compo model essays */}
                  {(["compoOption1Model", "compoOption2Model"] as const).map(key => {
                    const label = key === "compoOption1Model" ? "第一题 范文 (Option 1 model essay)" : "第二题 范文 (Option 2 model essay)";
                    const text = detail[key];
                    return (
                      <details key={key} className="border border-emerald-200 bg-emerald-50 rounded-lg" open>
                        <summary className="cursor-pointer px-4 py-2 font-bold text-sm text-emerald-800">
                          {label} {text ? `(${text.length} chars)` : "(not detected)"}
                        </summary>
                        {text && (
                          <p className="px-4 pb-4 text-sm text-slate-700 whitespace-pre-wrap">{text}</p>
                        )}
                      </details>
                    );
                  })}
                </div>

                {/* === Raw OCR text (fallback / debug) === */}
                <details className="mb-3 border border-slate-200 rounded-lg">
                  <summary className="cursor-pointer px-4 py-2 bg-slate-100 font-semibold text-sm text-slate-700">
                    🔧 Raw OCR text (debug)
                  </summary>
                  <div className="p-3 space-y-2">
                    {(["paper1Text", "paper3Text", "paper1AnswerText", "paper3AnswerText"] as const).map(key => {
                      const label = {
                        paper1Text: "Paper 1 raw",
                        paper3Text: "Paper 3 raw",
                        paper1AnswerText: "Paper 1 answer raw",
                        paper3AnswerText: "Paper 3 answer raw",
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
