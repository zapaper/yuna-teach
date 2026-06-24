"use client";

// Admin Compo index — upload a scanned Chinese composition, see the
// list of past attempts, click one to view the detailed analysis.
// Admin-only; the parent /admin layout already gates access.

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

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

export default function CompoIndexPage() {
  const [rows, setRows] = useState<AttemptRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [label, setLabel] = useState("");
  const [studentTopic, setStudentTopic] = useState("");
  const [optionType, setOptionType] = useState<"option1" | "option2" | "">("");
  const [questionFile, setQuestionFile] = useState<File | null>(null);
  const [pageFiles, setPageFiles] = useState<File[]>([]);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/compo");
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setRows(data.rows ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  const onUpload = async () => {
    if (pageFiles.length === 0) { setError("Add at least one composition page"); return; }
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      if (label) fd.append("label", label);
      if (studentTopic) fd.append("studentTopic", studentTopic);
      if (optionType) fd.append("optionType", optionType);
      if (questionFile) fd.append("question", questionFile);
      for (const f of pageFiles) fd.append("pages", f);

      const res = await fetch("/api/admin/compo", { method: "POST", body: fd });
      if (!res.ok) throw new Error(await res.text());
      const { row } = await res.json();

      // Kick off the analyse pipeline.
      await fetch(`/api/admin/compo/${row.id}/analyse`, { method: "POST" });

      setLabel(""); setStudentTopic(""); setOptionType("");
      setQuestionFile(null); setPageFiles([]);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-8">
      <div>
        <Link href="/admin" className="text-sm text-slate-500 hover:underline">← Admin</Link>
        <h1 className="text-2xl font-bold text-slate-900 mt-2">Compo — Chinese composition marker</h1>
        <p className="text-sm text-slate-600 mt-1">
          Upload a scanned student composition (and optionally the question / picture series).
          Gemini 3.1-pro will OCR, flag wrong words, score against the PSLE 40-mark rubric,
          and recommend structural + language upgrades drawn from the 10-year model-essay corpus.
        </p>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4">
        <h2 className="font-semibold text-slate-800">Upload a new composition</h2>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Label (e.g. student name + date)</span>
            <input
              className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm"
              placeholder="Mark — 2026-06-24"
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
            accept="image/*,application/pdf"
            className="mt-1 block w-full text-sm"
            onChange={(e) => setQuestionFile(e.target.files?.[0] ?? null)}
          />
        </label>

        <label className="block">
          <span className="text-xs font-medium text-slate-600">Composition pages (required — image(s) OR a single PDF)</span>
          <input
            type="file"
            accept="image/*,application/pdf"
            multiple
            className="mt-1 block w-full text-sm"
            onChange={(e) => setPageFiles(Array.from(e.target.files ?? []))}
          />
          {pageFiles.length === 0 ? (
            <p className="mt-1 text-xs text-amber-700">Select at least one file to enable the button below.</p>
          ) : (
            <p className="mt-1 text-xs text-slate-500">
              {pageFiles.length} file(s) selected: {pageFiles.map(f => f.name).join(", ")}
            </p>
          )}
        </label>

        {error && (
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
        )}

        <button
          onClick={onUpload}
          disabled={uploading || pageFiles.length === 0}
          className="px-4 py-2 rounded-lg text-sm font-medium bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {uploading ? "Uploading..." : "Upload + Analyse"}
        </button>
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
              <Link
                key={r.id}
                href={`/admin/compo/${r.id}`}
                className="block bg-white border border-slate-200 rounded-xl p-4 hover:border-slate-400"
              >
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
                  <div className="text-right">
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
            ))}
          </div>
        )}
      </div>
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
