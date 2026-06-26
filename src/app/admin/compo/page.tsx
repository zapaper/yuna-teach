"use client";

// Admin Compo index — upload OR scan a Chinese composition, then
// hit Analyse. Three-button flow at the top: Upload (file picker for
// PDF / images / .docx / .txt), Scan (opens the camera-based scanner
// mini-app), Analyse (sends collected pages to the pipeline).
// Thumbnails of staged pages render between the buttons and Analyse.

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import { fetchJsonSafe } from "@/lib/client-fetch";

// Heavy scanner UI (OpenCV worker, getUserMedia) — lazy-load so the
// admin page boot doesn't drag in 10MB of CV runtime before the admin
// even wants it.
const DocumentScanner = dynamic(() => import("@/components/DocumentScanner"), { ssr: false });

type AttemptRow = {
  id: string;
  label: string | null;
  studentTopic: string | null;
  optionType: "option1" | "option2" | null;
  status: "uploaded" | "analysing" | "ready" | "failed";
  errorMessage: string | null;
  analysedAt: string | null;
  createdAt: string;
  critique: { overallScore?: number } | null;
};

type StagedFile = {
  file: File;
  previewUrl: string;        // object URL for img thumbnail (or null for text/pdf)
  kind: "image" | "pdf" | "doc" | "text";
};

function stagedFromFile(f: File): StagedFile {
  const name = f.name.toLowerCase();
  const isImg = f.type.startsWith("image/") || /\.(jpe?g|png|webp)$/.test(name);
  const isPdf = f.type === "application/pdf" || name.endsWith(".pdf");
  const isDoc = name.endsWith(".docx");
  const kind: StagedFile["kind"] = isImg ? "image" : isPdf ? "pdf" : isDoc ? "doc" : "text";
  // Image AND PDF both get a blob URL — PDFs render via <embed> below.
  // .docx / .txt fall back to an icon tile (no built-in browser preview).
  const previewable = isImg || isPdf;
  return {
    file: f,
    previewUrl: previewable ? URL.createObjectURL(f) : "",
    kind,
  };
}

export default function CompoIndexPage() {
  const [rows, setRows] = useState<AttemptRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const [label, setLabel] = useState("");
  const [studentTopic, setStudentTopic] = useState("");
  const [optionType, setOptionType] = useState<"option1" | "option2" | "">("");
  const [compareToMarkings, setCompareToMarkings] = useState(false);
  const [questionFile, setQuestionFile] = useState<File | null>(null);
  const [pageFiles, setPageFiles] = useState<StagedFile[]>([]);
  const [scannerOpen, setScannerOpen] = useState(false);
  // /admin requires the userId query param for session resolution —
  // landing there without it shows an error page. Read from
  // window.location after mount (rather than useSearchParams) so
  // the page can stay prerenderable.
  const [adminHref, setAdminHref] = useState("/admin");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const uid = new URLSearchParams(window.location.search).get("userId");
    if (uid) setAdminHref(`/admin?userId=${uid}`);
  }, []);

  const refresh = useCallback(async () => {
    const result = await fetchJsonSafe<{ rows: AttemptRow[] }>("/api/admin/compo");
    if (result.ok) {
      setRows(result.data.rows ?? []);
      // Clear any prior transient error once we're talking again.
      setError(prev => prev && prev.includes("restarting") ? null : prev);
    } else if (!result.transient) {
      // Suppress 502/503/504 spam in the background poll — those
      // are deploy-induced and clear themselves. Surface only
      // real errors (4xx, parse failures, network down).
      setError(result.error);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Free object URLs on unmount.
  useEffect(() => () => {
    pageFiles.forEach(p => p.previewUrl && URL.revokeObjectURL(p.previewUrl));
  }, [pageFiles]);

  const onUploadPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []).map(stagedFromFile);
    if (picked.length > 0) setPageFiles(prev => [...prev, ...picked]);
    e.target.value = ""; // allow re-picking the same file
  };

  const onScanComplete = async (pages: Array<{ blob: Blob; index: number }>) => {
    const staged = pages.map(p => stagedFromFile(
      new File([p.blob], `scan_${Date.now()}_${p.index + 1}.jpg`, { type: "image/jpeg" })
    ));
    setPageFiles(prev => [...prev, ...staged]);
  };

  const removeStaged = (idx: number) => {
    setPageFiles(prev => {
      const next = [...prev];
      const removed = next.splice(idx, 1)[0];
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
      return next;
    });
  };

  const onAnalyse = async () => {
    if (pageFiles.length === 0) { setError("Add or scan at least one composition page first"); return; }
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      if (label) fd.append("label", label);
      if (studentTopic) fd.append("studentTopic", studentTopic);
      if (optionType) fd.append("optionType", optionType);
      if (compareToMarkings) fd.append("compareToMarkings", "true");
      if (questionFile) fd.append("question", questionFile);
      for (const p of pageFiles) fd.append("pages", p.file);

      const uploadRes = await fetchJsonSafe<{ row: { id: string } }>(
        "/api/admin/compo", { method: "POST", body: fd },
      );
      if (!uploadRes.ok) throw new Error(uploadRes.error);
      const row = uploadRes.data.row;
      const analyseRes = await fetchJsonSafe(`/api/admin/compo/${row.id}/analyse`, { method: "POST" });
      // 202 from /analyse counts as ok per the safe-fetch contract.
      if (!analyseRes.ok && !analyseRes.transient) {
        throw new Error(analyseRes.error);
      }

      pageFiles.forEach(p => p.previewUrl && URL.revokeObjectURL(p.previewUrl));
      setLabel(""); setStudentTopic(""); setOptionType("");
      setQuestionFile(null); setPageFiles([]);
      router.push(`/admin/compo/${row.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-8">
      <div>
        <Link href={adminHref} className="text-sm text-slate-500 hover:underline">← Admin</Link>
        <h1 className="text-2xl font-bold text-slate-900 mt-2">作文 Helper</h1>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
        <h2 className="font-semibold text-slate-800">New composition</h2>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Label (e.g. student name + date)</span>
            <input
              className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              placeholder="e.g. 一份特别的友谊"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Composition topic (optional)</span>
            <input
              className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              placeholder="一件让我难忘的事"
              value={studentTopic}
              onChange={(e) => setStudentTopic(e.target.value)}
            />
          </label>
        </div>

        <label className="block">
          <span className="text-xs font-medium text-slate-600">Option type</span>
          <select
            className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
            value={optionType}
            onChange={(e) => setOptionType(e.target.value as "option1" | "option2" | "")}
          >
            <option value="">Unknown / not sure</option>
            <option value="option1">Option 1 (topic only)</option>
            <option value="option2">Option 2 (picture series)</option>
          </select>
        </label>

        <label className="block">
          <span className="text-xs font-medium text-slate-600">Question scan (optional — prompt or picture series, image or PDF)</span>
          <input
            type="file"
            accept="image/*,application/pdf,.docx,.txt,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="mt-1 block w-full text-sm"
            onChange={(e) => setQuestionFile(e.target.files?.[0] ?? null)}
          />
        </label>

        {/* Admin-only flag — when uploading a teacher-marked paper to
            benchmark whether the AI catches the same edits the teacher
            made. Runs OCR twice: once treating red/green strokes as
            invisible (the version the wrong-word pipeline analyses),
            once preserving them so the detail page can show what the
            teacher wrote. */}
        <label className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-200 bg-amber-50 cursor-pointer hover:bg-amber-100/60">
          <input
            type="checkbox"
            checked={compareToMarkings}
            onChange={(e) => setCompareToMarkings(e.target.checked)}
            className="mt-0.5 accent-amber-700"
          />
          <span className="text-xs text-amber-900">
            <span className="font-semibold">Remove red/green markings</span>
            <br />
            <span className="text-amber-700">
              This will remove any red/green marking on script. Enhancer will enhance the base script without the markings. It will also OCR-ed the marked version as a comparison.
            </span>
          </span>
        </label>

        {/* ── 3-button top row: Upload | Scan | Analyse ── */}
        <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-100">
          <label className="px-4 py-2 rounded-lg text-sm font-medium bg-slate-100 text-slate-800 hover:bg-slate-200 cursor-pointer">
            📂 Upload
            <input
              type="file"
              accept="image/*,application/pdf,.docx,.txt,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              multiple
              className="hidden"
              onChange={onUploadPick}
            />
          </label>
          <button
            type="button"
            onClick={() => setScannerOpen(true)}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-slate-100 text-slate-800 hover:bg-slate-200"
          >
            📷 Scan
          </button>
          <button
            type="button"
            onClick={onAnalyse}
            disabled={uploading || pageFiles.length === 0}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed ml-auto"
          >
            {uploading ? "Sending…" : "🚀 Analyse"}
          </button>
        </div>

        {/* ── Thumbnails of staged pages ── */}
        {pageFiles.length > 0 && (
          <div>
            <p className="text-xs font-medium text-slate-600 mb-2">Staged pages ({pageFiles.length}):</p>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
              {pageFiles.map((p, i) => (
                <div key={i} className="relative bg-slate-50 border border-slate-200 rounded-lg overflow-hidden group">
                  {p.kind === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={p.previewUrl} alt={`page ${i + 1}`} className="w-full h-44 object-cover" />
                  ) : p.kind === "pdf" ? (
                    // <embed> renders the PDF's first page natively in
                    // Chrome / Edge / Safari. The overflow-hidden +
                    // pointer-events-none isolate the thumbnail so the
                    // viewer's scroll / toolbar can't get in the way.
                    <div className="relative w-full h-44 bg-white overflow-hidden">
                      <embed
                        src={`${p.previewUrl}#toolbar=0&navpanes=0&page=1&view=FitH`}
                        type="application/pdf"
                        className="w-full h-44 pointer-events-none"
                      />
                      <div className="absolute top-1 left-1 bg-rose-100 text-rose-700 text-[10px] font-bold px-1.5 py-0.5 rounded">
                        PDF
                      </div>
                    </div>
                  ) : (
                    <div className="w-full h-44 flex flex-col items-center justify-center text-slate-500 text-xs gap-1">
                      <div className="text-3xl">{p.kind === "doc" ? "📝" : "📃"}</div>
                      <div className="uppercase font-medium">{p.kind}</div>
                    </div>
                  )}
                  <div className="absolute bottom-0 left-0 right-0 bg-black/50 text-white text-[10px] px-1.5 py-0.5 truncate">
                    {i + 1}. {p.file.name}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeStaged(i)}
                    className="absolute top-1 right-1 bg-white/90 hover:bg-white text-red-600 rounded-full w-6 h-6 flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition"
                    title="Remove"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {pageFiles.length === 0 && (
          <p className="text-xs text-slate-500">
            No pages staged yet — Upload a file or open Scan to capture from camera.
          </p>
        )}

        {error && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
        )}
      </div>

      <div>
        <h2 className="font-semibold text-slate-800 mb-2">Recent attempts</h2>
        {loading ? (
          <p className="text-sm text-slate-500">Loading...</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-slate-500">No uploads yet.</p>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => (
              <div
                key={r.id}
                className="relative bg-white border border-slate-200 rounded-xl p-4 hover:border-slate-400 group"
              >
                <Link href={`/admin/compo/${r.id}`} className="block">
                  <div className="flex justify-between items-start">
                    <div>
                      <div className="font-medium text-slate-800">
                        {r.label ?? "(no label)"}
                        {r.studentTopic && <span className="ml-2 text-slate-500 text-sm">— {r.studentTopic}</span>}
                      </div>
                      <div className="text-xs text-slate-500 mt-1">
                        {new Date(r.createdAt).toLocaleString("en-SG", { dateStyle: "medium", timeStyle: "short" })}
                        {r.optionType && <> · {r.optionType}</>}
                      </div>
                    </div>
                    <div className="text-right pr-16">
                      <StatusBadge status={r.status} />
                      {r.critique?.overallScore !== undefined && (
                        <div className="text-sm font-semibold text-slate-800 mt-1">
                          {r.critique.overallScore}/40
                        </div>
                      )}
                    </div>
                  </div>
                  {r.errorMessage && (
                    <div className="text-xs text-red-600 mt-2 line-clamp-2">{r.errorMessage}</div>
                  )}
                </Link>
                <button
                  type="button"
                  onClick={async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!confirm(`Delete '${r.label ?? "this analysis"}'? Removes the uploaded pages + generated output. Cannot be undone.`)) return;
                    const res = await fetchJsonSafe(`/api/admin/compo/${r.id}`, { method: "DELETE" });
                    if (res.ok) refresh();
                    else setError(res.error);
                  }}
                  className="absolute top-3 right-3 px-2 py-1 rounded text-xs font-medium bg-red-50 text-red-700 hover:bg-red-100 opacity-0 group-hover:opacity-100 transition"
                  title="Delete this analysis"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Scanner overlay ── */}
      {scannerOpen && (
        <DocumentScanner
          parentId="compo"
          masterPaperId="compo"
          studentId="compo"
          paperTitle="Compo — scan student composition"
          onClose={() => setScannerOpen(false)}
          onComplete={onScanComplete}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: AttemptRow["status"] }) {
  const styles =
    status === "ready"     ? "bg-emerald-100 text-emerald-700" :
    status === "analysing" ? "bg-amber-100 text-amber-700"     :
    status === "failed"    ? "bg-red-100 text-red-700"         :
                             "bg-slate-100 text-slate-600";
  return <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${styles}`}>{status}</span>;
}
