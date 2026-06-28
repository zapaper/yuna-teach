"use client";

// Parent-facing Essay Coach — upload + history for the selected child.
//
// Same upload pipeline as /admin/compo, but: scoped to the parent's
// linked students, no question-file upload (user scans the prompt
// page with the essay; OCR auto-detects), label auto-fills with the
// student's name + date. Main-app font + colour scheme.

import { useState, useEffect, useCallback, useRef, Suspense } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import { fetchJsonSafe } from "@/lib/client-fetch";

const DocumentScanner = dynamic(() => import("@/components/DocumentScanner"), { ssr: false });

type AttemptRow = {
  id: string;
  label: string | null;
  studentTopic: string | null;
  optionType: "option1" | "option2" | null;
  language: "chinese" | "english" | null;
  englishComponent: "continuous" | "situational" | null;
  status: "uploaded" | "analysing" | "ready" | "failed";
  errorMessage: string | null;
  analysedAt: string | null;
  createdAt: string;
  studentId: string | null;
  critique: { overallScore?: number; component?: string } | null;
};

type StagedFile = {
  file: File;
  previewUrl: string;
  kind: "image" | "pdf" | "doc" | "text";
};

type LinkedStudent = {
  id: string;
  name: string;
  displayName: string | null;
};

// ─── Batch Analyse types — admin-only feature (gated below) ───────────
type BatchAdvice = {
  tip: string;
  tipEn?: string;
  why: string;
  whyEn?: string;
  examples: Array<{ from: string; before: string; after: string }>;
};
type BatchBucket = {
  title: string;
  titleEn?: string;
  color: "blue" | "emerald" | "amber" | "rose" | "violet" | "sky";
  advice: BatchAdvice[];
};
type BatchAnalyseResult = {
  buckets: BatchBucket[];
  overview: string;
  overviewEn?: string;
  essaysAnalysed: number;
  language: "chinese" | "english" | "mixed";
};
const BUCKET_PALETTE: Record<BatchBucket["color"], { border: string; headerBg: string; headerText: string; chip: string }> = {
  blue:    { border: "border-blue-200",    headerBg: "bg-blue-50",    headerText: "text-blue-900",    chip: "bg-blue-100 text-blue-800" },
  emerald: { border: "border-emerald-200", headerBg: "bg-emerald-50", headerText: "text-emerald-900", chip: "bg-emerald-100 text-emerald-800" },
  amber:   { border: "border-amber-200",   headerBg: "bg-amber-50",   headerText: "text-amber-900",   chip: "bg-amber-100 text-amber-800" },
  rose:    { border: "border-rose-200",    headerBg: "bg-rose-50",    headerText: "text-rose-900",    chip: "bg-rose-100 text-rose-800" },
  violet:  { border: "border-violet-200",  headerBg: "bg-violet-50",  headerText: "text-violet-900",  chip: "bg-violet-100 text-violet-800" },
  sky:     { border: "border-sky-200",     headerBg: "bg-sky-50",     headerText: "text-sky-900",     chip: "bg-sky-100 text-sky-800" },
};

function stagedFromFile(f: File): StagedFile {
  const name = f.name.toLowerCase();
  const isImg = f.type.startsWith("image/") || /\.(jpe?g|png|webp)$/.test(name);
  const isPdf = f.type === "application/pdf" || name.endsWith(".pdf");
  const isDoc = name.endsWith(".docx");
  const kind: StagedFile["kind"] = isImg ? "image" : isPdf ? "pdf" : isDoc ? "doc" : "text";
  const previewable = isImg || isPdf;
  return {
    file: f,
    previewUrl: previewable ? URL.createObjectURL(f) : "",
    kind,
  };
}

function todayLabel(name: string | null): string {
  const d = new Date();
  const dateStr = d.toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" });
  const safeName = (name ?? "").trim() || "Student";
  return `${safeName} — ${dateStr}`;
}

export default function EssayCoachPage() {
  return (
    <Suspense>
      <EssayCoachContent />
    </Suspense>
  );
}

function EssayCoachContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const parentId = params.parentId as string;
  const studentIdFromUrl = searchParams.get("student") ?? "";

  const [linkedStudents, setLinkedStudents] = useState<LinkedStudent[]>([]);
  const [studentId, setStudentId] = useState(studentIdFromUrl);
  const [loadingUser, setLoadingUser] = useState(true);
  const [accessError, setAccessError] = useState<string | null>(null);

  const [rows, setRows] = useState<AttemptRow[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [label, setLabel] = useState("");
  const [studentTopic, setStudentTopic] = useState("");
  const [optionType, setOptionType] = useState<"option1" | "option2" | "">("");
  const [language, setLanguage] = useState<"chinese" | "english">("chinese");
  const [englishComponent, setEnglishComponent] = useState<"continuous" | "situational" | "">("");
  const [compareToMarkings, setCompareToMarkings] = useState(false);
  const [pageFiles, setPageFiles] = useState<StagedFile[]>([]);
  const [scannerOpen, setScannerOpen] = useState(false);

  // ─── Admin-only: Batch Analyse on the parent page ─────────────────
  // The same cross-essay coach the admin compo page ships, gated
  // behind a signed-session admin check so plain parents don't see
  // the toggle. Will open up to all parents once the cost / UX is
  // validated.
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    fetch("/api/admin/check").then(r => setIsAdmin(r.ok)).catch(() => setIsAdmin(false));
  }, []);
  const [batchMode, setBatchMode] = useState(false);
  const [batchSelected, setBatchSelected] = useState<Set<string>>(new Set());
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchResult, setBatchResult] = useState<BatchAnalyseResult | null>(null);
  const [batchSavedTipId, setBatchSavedTipId] = useState<string | null>(null);
  const [batchSaving, setBatchSaving] = useState(false);
  const [listLanguage, setListLanguage] = useState<"english" | "chinese">("chinese");
  const BATCH_CAP = 10;
  const batchPanelRef = useRef<HTMLDivElement | null>(null);
  const toggleBatchPick = (id: string) => {
    setBatchSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < BATCH_CAP) next.add(id);
      return next;
    });
  };
  const runBatchAnalyse = async () => {
    if (batchSelected.size < 2) return;
    setBatchLoading(true);
    setBatchError(null);
    setBatchResult(null);
    setBatchSavedTipId(null);
    try {
      const res = await fetch("/api/admin/compo/batch-analyse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attemptIds: [...batchSelected] }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
      setBatchResult(j as BatchAnalyseResult);
      setTimeout(() => batchPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } catch (e) {
      setBatchError(e instanceof Error ? e.message : String(e));
    } finally {
      setBatchLoading(false);
    }
  };
  const saveBatchTip = async () => {
    if (!batchResult || batchSaving) return;
    setBatchSaving(true);
    try {
      const res = await fetch("/api/admin/compo/batch-analyse/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attemptIds: [...batchSelected], analysis: batchResult }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
      setBatchSavedTipId((j as { id: string }).id);
    } catch (e) {
      setBatchError(e instanceof Error ? e.message : String(e));
    } finally {
      setBatchSaving(false);
    }
  };

  // Load parent + linked students on mount.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/users?userId=${parentId}`)
      .then(async r => {
        if (!r.ok) throw new Error(r.status === 403 ? "Access denied" : `Failed to load (HTTP ${r.status})`);
        return r.json();
      })
      .then((data: { user: { linkedStudents?: LinkedStudent[] } | null }) => {
        if (cancelled) return;
        const students = data.user?.linkedStudents ?? [];
        setLinkedStudents(students);
        // If no student in URL, fall back to the first linked student.
        setStudentId(prev => prev || students[0]?.id || "");
      })
      .catch(err => { if (!cancelled) setAccessError((err as Error).message); })
      .finally(() => { if (!cancelled) setLoadingUser(false); });
    return () => { cancelled = true; };
  }, [parentId]);

  // Selected student object — used for label auto-fill and history scope.
  const selectedStudent = linkedStudents.find(s => s.id === studentId) ?? null;
  const selectedName = selectedStudent
    ? (selectedStudent.displayName ?? selectedStudent.name)
    : "";

  // Auto-fill the label when the picked student changes — but only if
  // the field is empty OR still matches the previous auto-fill (so
  // the parent's typed override never gets stomped).
  useEffect(() => {
    setLabel(prev => {
      const t = todayLabel(selectedName);
      // Always overwrite if empty; never overwrite if user has typed
      // something that doesn't look like our autofill format.
      if (!prev.trim()) return t;
      // Looks like our autofill ("<name> — <date>") → refresh.
      if (/—\s+\d/.test(prev)) return t;
      return prev;
    });
  }, [selectedName]);

  // Pull history when the student changes.
  const refresh = useCallback(async () => {
    if (!studentId) { setRows([]); setLoadingHistory(false); return; }
    const result = await fetchJsonSafe<{ rows: AttemptRow[] }>(`/api/essay-coach?studentId=${studentId}`);
    if (result.ok) {
      setRows(result.data.rows ?? []);
      setError(prev => prev && prev.includes("restarting") ? null : prev);
    } else if (!result.transient) {
      setError(result.error);
    }
    setLoadingHistory(false);
  }, [studentId]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Sync the ?student query param so refresh keeps the selection.
  useEffect(() => {
    if (!studentId) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("student") !== studentId) {
      url.searchParams.set("student", studentId);
      window.history.replaceState({}, "", url.toString());
    }
  }, [studentId]);

  useEffect(() => () => {
    pageFiles.forEach(p => p.previewUrl && URL.revokeObjectURL(p.previewUrl));
  }, [pageFiles]);

  const onUploadPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []).map(stagedFromFile);
    if (picked.length > 0) setPageFiles(prev => [...prev, ...picked]);
    e.target.value = "";
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
    if (!studentId) { setError("Pick a child first"); return; }
    if (pageFiles.length === 0) { setError("Add or scan at least one composition page first"); return; }
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("studentId", studentId);
      if (label) fd.append("label", label);
      if (studentTopic) fd.append("studentTopic", studentTopic);
      fd.append("language", language);
      if (language === "english") {
        if (englishComponent) fd.append("englishComponent", englishComponent);
      } else if (optionType) {
        fd.append("optionType", optionType);
      }
      if (compareToMarkings) fd.append("compareToMarkings", "true");
      for (const p of pageFiles) fd.append("pages", p.file);

      const uploadRes = await fetchJsonSafe<{ row: { id: string } }>(
        "/api/essay-coach", { method: "POST", body: fd },
      );
      if (!uploadRes.ok) throw new Error(uploadRes.error);
      const row = uploadRes.data.row;
      const analyseRes = await fetchJsonSafe(`/api/essay-coach/${row.id}/analyse`, { method: "POST" });
      if (!analyseRes.ok && !analyseRes.transient) {
        throw new Error(analyseRes.error);
      }
      pageFiles.forEach(p => p.previewUrl && URL.revokeObjectURL(p.previewUrl));
      setStudentTopic(""); setOptionType(""); setEnglishComponent("");
      setCompareToMarkings(false);
      setPageFiles([]);
      router.push(`/essay-coach/${parentId}/${row.id}?student=${studentId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  if (accessError) {
    return (
      <div className="min-h-screen bg-[#f8f9ff] flex items-center justify-center">
        <p className="text-sm text-[#43474f]">{accessError}</p>
      </div>
    );
  }

  if (loadingUser) {
    return (
      <div className="min-h-screen bg-[#f8f9ff] flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-[#0040a0]" />
      </div>
    );
  }

  if (linkedStudents.length === 0) {
    return (
      <div className="min-h-screen bg-[#f8f9ff]">
        <div className="max-w-3xl mx-auto p-6">
          <Link href={`/home/${parentId}`} className="text-sm text-[#0040a0] hover:underline">← Back</Link>
          <h1 className="text-2xl font-extrabold text-[#001e40] mt-2 mb-2">Essay Coach</h1>
          <p className="text-sm text-[#43474f]">No linked students. Link a child from your homepage first.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f8f9ff]">
      <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-6">
        {/* Header — back to parent home + title with Beta badge. */}
        <div className="flex items-center justify-between">
          <Link
            href={`/home/${parentId}`}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-[#0040a0] bg-[#eff4ff] hover:bg-[#dfe9ff] px-3 py-1.5 rounded-lg transition-colors"
          >
            <span className="material-symbols-outlined text-base">arrow_back</span>
            <span>Back</span>
          </Link>
          {linkedStudents.length > 1 && (
            <select
              value={studentId}
              onChange={(e) => setStudentId(e.target.value)}
              title={linkedStudents.find(s => s.id === studentId)?.displayName ?? linkedStudents.find(s => s.id === studentId)?.name ?? ""}
              className="text-base font-semibold px-3 py-2 max-w-[10rem] truncate border border-slate-300 rounded-lg bg-white text-[#001e40] focus:outline-none focus:border-[#0040a0]"
            >
              {linkedStudents.map(s => (
                <option key={s.id} value={s.id}>{s.displayName ?? s.name}</option>
              ))}
            </select>
          )}
        </div>

        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-[#001e40] flex items-baseline gap-2">
            Essay Coach
            <span className="text-[10px] uppercase tracking-wide font-bold text-white bg-[#0040a0] rounded-md px-1.5 py-0.5 align-middle">Beta</span>
          </h1>
          <p className="text-sm text-[#43474f] mt-1">
            Upload {selectedName ? `${selectedName}'s` : "your child's"} Chinese composition and we&rsquo;ll mark it, suggest upgrades, and rewrite a 35-40 level draft.
          </p>
        </div>

        {/* New composition card. */}
        <div className="bg-white border border-slate-200 rounded-2xl p-5 space-y-4 shadow-sm">
          <h2 className="font-semibold text-[#001e40]">New composition</h2>

          {/* Language toggle — segmented pill at the top, before any
              labels. Picking flips the picker below from Option type
              (Chinese) to Component (English). */}
          <div className="inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1 text-sm font-semibold">
            <button
              type="button"
              onClick={() => setLanguage("chinese")}
              className={`px-4 py-1.5 rounded-lg transition-colors ${language === "chinese" ? "bg-white text-[#001e40] shadow-sm" : "text-[#737780] hover:text-[#001e40]"}`}
            >
              Chinese 华文
            </button>
            <button
              type="button"
              onClick={() => setLanguage("english")}
              className={`px-4 py-1.5 rounded-lg transition-colors ${language === "english" ? "bg-white text-[#001e40] shadow-sm" : "text-[#737780] hover:text-[#001e40]"}`}
            >
              English
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-medium text-[#43474f]">Label</span>
              <input
                className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-[#0040a0]"
                placeholder={selectedName ? `${selectedName} — today` : "Composition label"}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="text-xs font-medium text-[#43474f]">Composition topic (optional)</span>
              <input
                className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-[#0040a0]"
                placeholder="e.g. 一个珍贵的礼物"
                value={studentTopic}
                onChange={(e) => setStudentTopic(e.target.value)}
              />
            </label>
          </div>

          {language === "english" ? (
            <label className="block">
              <span className="text-xs font-medium text-[#43474f]">Component</span>
              <select
                className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-[#0040a0]"
                value={englishComponent}
                onChange={(e) => setEnglishComponent(e.target.value as "continuous" | "situational" | "")}
              >
                <option value="">Unknown / not sure</option>
                <option value="continuous">Continuous Writing (36)</option>
                <option value="situational">Situational Writing (14)</option>
              </select>
            </label>
          ) : (
            <label className="block">
              <span className="text-xs font-medium text-[#43474f]">Option type</span>
              <select
                className="mt-1 w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:border-[#0040a0]"
                value={optionType}
                onChange={(e) => setOptionType(e.target.value as "option1" | "option2" | "")}
              >
                <option value="">Unknown / not sure</option>
                <option value="option1">Option 1 (topic only)</option>
                <option value="option2">Option 2 (picture series)</option>
              </select>
            </label>
          )}

          <label className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-200 bg-amber-50 cursor-pointer hover:bg-amber-100/60">
            <input
              type="checkbox"
              checked={compareToMarkings}
              onChange={(e) => setCompareToMarkings(e.target.checked)}
              className="mt-0.5 accent-amber-700"
            />
            <span className="text-xs text-amber-900">
              <span className="font-semibold">Teacher already marked it (compare)</span>
              <br />
              <span className="text-amber-700">
                Removes red/green teacher marks before analysis, and shows the teacher&rsquo;s edits side-by-side so you can compare what the teacher caught vs the AI.
              </span>
            </span>
          </label>

          {/* Upload | Scan | Analyse */}
          <div className="flex flex-wrap gap-2 pt-3 border-t border-slate-100">
            <label className="px-4 py-2 rounded-lg text-sm font-semibold bg-[#eff4ff] text-[#0040a0] hover:bg-[#dfe9ff] cursor-pointer inline-flex items-center gap-1.5">
              <span className="material-symbols-outlined text-base">upload_file</span>
              Upload
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
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-[#eff4ff] text-[#0040a0] hover:bg-[#dfe9ff] inline-flex items-center gap-1.5"
            >
              <span className="material-symbols-outlined text-base">photo_camera</span>
              Scan
            </button>
            <button
              type="button"
              onClick={onAnalyse}
              disabled={uploading || pageFiles.length === 0}
              className="ml-auto px-4 py-2 rounded-lg text-sm font-semibold bg-[#0040a0] text-white hover:bg-[#003080] disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
            >
              {uploading ? "Sending…" : (
                <>
                  <span className="material-symbols-outlined text-base">auto_awesome</span>
                  Analyse
                </>
              )}
            </button>
          </div>

          {/* Staged thumbnails */}
          {pageFiles.length > 0 && (
            <div>
              <p className="text-xs font-medium text-[#43474f] mb-2">Staged pages ({pageFiles.length}):</p>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                {pageFiles.map((p, i) => (
                  <div key={i} className="relative bg-slate-50 border border-slate-200 rounded-lg overflow-hidden group">
                    {p.kind === "image" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.previewUrl} alt={`page ${i + 1}`} className="w-full h-40 object-cover" />
                    ) : p.kind === "pdf" ? (
                      <div className="relative w-full h-40 bg-white overflow-hidden">
                        <embed
                          src={`${p.previewUrl}#toolbar=0&navpanes=0&page=1&view=FitH`}
                          type="application/pdf"
                          className="w-full h-40 pointer-events-none"
                        />
                        <div className="absolute top-1 left-1 bg-rose-100 text-rose-700 text-[10px] font-bold px-1.5 py-0.5 rounded">PDF</div>
                      </div>
                    ) : (
                      <div className="w-full h-40 flex flex-col items-center justify-center text-slate-500 text-xs gap-1">
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
            <p className="text-xs text-[#43474f]">
              No pages yet — tap <strong>Upload</strong> for a file or <strong>Scan</strong> to capture pages with your camera. You can stage multiple pages before analysing.
            </p>
          )}

          {error && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
          )}
        </div>

        {/* Batch Analyse result — admin-only, lands right above the
            history list so the freshly-generated tip is the FIRST
            thing the admin sees post-Gemini. */}
        {isAdmin && batchResult && (
          <div ref={batchPanelRef}>
            <BatchResultPanel
              result={batchResult}
              savedTipId={batchSavedTipId}
              saving={batchSaving}
              onSave={saveBatchTip}
              onClose={() => { setBatchResult(null); setBatchSelected(new Set()); setBatchSavedTipId(null); }}
            />
          </div>
        )}

        {/* History */}
        <div>
          <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
            <div className="flex items-center gap-3 flex-wrap">
              <h2 className="font-semibold text-[#001e40]">
                Past attempts {selectedName ? `for ${selectedName}` : ""}
              </h2>
              {isAdmin && (
                <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 text-xs font-semibold">
                  <button
                    type="button"
                    onClick={() => { setListLanguage("english"); setBatchSelected(new Set()); }}
                    className={`px-2.5 py-1 rounded ${listLanguage === "english" ? "bg-white text-[#001e40] shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                  >
                    English
                  </button>
                  <button
                    type="button"
                    onClick={() => { setListLanguage("chinese"); setBatchSelected(new Set()); }}
                    className={`px-2.5 py-1 rounded ${listLanguage === "chinese" ? "bg-white text-[#001e40] shadow-sm" : "text-slate-500 hover:text-slate-700"}`}
                  >
                    Chinese 华文
                  </button>
                </div>
              )}
            </div>
            {isAdmin && (
              <div className="flex gap-2">
                {batchMode && batchSelected.size >= 2 && !batchResult && (
                  <button
                    type="button"
                    onClick={runBatchAnalyse}
                    disabled={batchLoading}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-60"
                  >
                    {batchLoading ? "Analysing…" : `🪄 Run on ${batchSelected.size} essays`}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setBatchMode(v => !v);
                    setBatchSelected(new Set());
                    setBatchResult(null);
                    setBatchError(null);
                  }}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors ${
                    batchMode
                      ? "bg-violet-600 text-white border-violet-600 hover:bg-violet-700"
                      : "bg-white text-[#0040a0] border-slate-300 hover:border-violet-400"
                  }`}
                  title="Pick 2-10 essays for a cross-essay coaching summary"
                >
                  <span className="material-symbols-outlined text-base">{batchMode ? "checklist" : "library_add_check"}</span>
                  Batch Analyse {batchMode && `(${batchSelected.size}/${BATCH_CAP})`}
                </button>
              </div>
            )}
          </div>
          {isAdmin && batchError && (
            <div className="mb-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              Batch analyse failed: {batchError}
            </div>
          )}
          {(() => {
            const visibleRows = isAdmin
              ? rows.filter(r => (r.language ?? "chinese") === listLanguage)
              : rows;
            if (loadingHistory) return <p className="text-sm text-[#43474f]">Loading…</p>;
            if (visibleRows.length === 0) return (
              <p className="text-sm text-[#43474f]">
                No {isAdmin ? (listLanguage === "english" ? "English" : "Chinese") : ""} essays yet — upload one above to get started.
              </p>
            );
            return (
            <div className="space-y-2">
              {visibleRows.map((r) => {
                const isReady = r.status === "ready";
                const isPicked = batchSelected.has(r.id);
                const capReached = batchSelected.size >= BATCH_CAP && !isPicked;
                const inBatchMode = isAdmin && batchMode;
                const cardCls = `block bg-white border rounded-xl p-4 transition ${
                  inBatchMode && isPicked
                    ? "border-violet-400 ring-2 ring-violet-200"
                    : "border-slate-200 hover:border-[#0040a0]/60 hover:shadow-sm"
                }`;
                const inner = (
                  <div className="flex justify-between items-start gap-3">
                    {inBatchMode && (
                      <div className="pt-0.5">
                        {isReady ? (
                          <input
                            type="checkbox"
                            checked={isPicked}
                            disabled={capReached}
                            onChange={() => toggleBatchPick(r.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="w-5 h-5 accent-violet-600 cursor-pointer disabled:cursor-not-allowed disabled:opacity-30"
                            title={capReached ? `Max ${BATCH_CAP} essays per batch` : ""}
                          />
                        ) : (
                          <div className="w-5 h-5" />
                        )}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-[#001e40] truncate">
                        {r.label ?? "(no label)"}
                        {r.studentTopic && <span className="ml-2 text-[#43474f] text-sm font-normal">— {r.studentTopic}</span>}
                      </div>
                      <div className="text-xs text-[#737780] mt-1">
                        {new Date(r.createdAt).toLocaleString("en-SG", { dateStyle: "medium", timeStyle: "short" })}
                        {r.optionType && <> · {r.optionType}</>}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <StatusBadge status={r.status} />
                      {r.critique?.overallScore !== undefined && (() => {
                        const max = r.language === "english"
                          ? (r.englishComponent === "situational" ? 14 : 36)
                          : 40;
                        return (
                          <div className="text-sm font-bold text-[#001e40] mt-1">
                            {r.critique.overallScore}/{max} <span className="font-normal text-[#737780]">({Math.round((r.critique.overallScore / max) * 100)}%)</span>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                );
                const errorBlock = r.errorMessage ? (
                  <div className="text-xs text-red-600 mt-2 line-clamp-2">{r.errorMessage}</div>
                ) : null;
                if (inBatchMode) {
                  // Batch mode: clicking the row toggles selection
                  // instead of navigating. Ready rows only — non-ready
                  // ones stay inert.
                  return (
                    <div
                      key={r.id}
                      onClick={() => isReady && !capReached && toggleBatchPick(r.id)}
                      className={cardCls + (isReady ? " cursor-pointer" : " cursor-default opacity-70")}
                    >
                      {inner}
                      {errorBlock}
                    </div>
                  );
                }
                return (
                  <Link
                    key={r.id}
                    href={`/essay-coach/${parentId}/${r.id}?student=${studentId}`}
                    className={cardCls}
                  >
                    {inner}
                    {errorBlock}
                  </Link>
                );
              })}
            </div>
            );
          })()}
        </div>
      </div>

      {/* Scanner overlay */}
      {scannerOpen && (
        <DocumentScanner
          parentId="essay-coach"
          masterPaperId="essay-coach"
          studentId="essay-coach"
          paperTitle="Essay Coach — scan composition"
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

// Admin-only Batch Analyse result panel. Mirrors the one on
// /admin/compo — Save persists to BatchCoachTip, Print opens the
// dedicated print route. Once saved, the button row swaps from a
// pending Save → a Print link + success banner.
function BatchResultPanel({
  result,
  savedTipId,
  saving,
  onSave,
  onClose,
}: {
  result: BatchAnalyseResult;
  savedTipId: string | null;
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
}) {
  const isChinese = result.language === "chinese";
  const isSaved = savedTipId !== null;
  return (
    <div className="bg-white border-2 border-violet-300 rounded-2xl p-5 space-y-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wide font-bold text-violet-700">
            {isChinese ? "跨篇作文教练总结" : "Cross-essay coaching summary"}
          </div>
          <h3 className="text-lg font-bold text-[#001e40] mt-0.5">
            {isChinese ? `${result.essaysAnalysed} 篇作文的共同模式` : `Patterns across ${result.essaysAnalysed} essays`}
          </h3>
          {result.overview && (
            <p className="text-sm text-slate-700 mt-1.5 italic" style={isChinese ? { fontFamily: "'Noto Serif SC', 'PingFang SC', 'Microsoft YaHei', serif" } : undefined}>
              {result.overview}
            </p>
          )}
          {result.overviewEn && result.overviewEn !== result.overview && (
            <p className="text-xs text-slate-500 mt-1 italic">{result.overviewEn}</p>
          )}
        </div>
        <div className="flex gap-2 shrink-0">
          {!isSaved ? (
            <button
              type="button"
              onClick={onSave}
              disabled={saving}
              className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-60"
            >
              {saving ? "Saving…" : "💾 Save this"}
            </button>
          ) : (
            <a
              href={`/print/batch-tip/${savedTipId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700"
            >
              🖨 Print this
            </a>
          )}
          <button
            type="button"
            onClick={onClose}
            className="px-2.5 py-1 rounded-lg text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200"
          >
            Close
          </button>
        </div>
      </div>
      {isSaved && (
        <div className="text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-1.5">
          Saved to the covered essays. Open any of them to see this tip under &quot;Lumi&rsquo;s tip&quot;.
        </div>
      )}
      {result.buckets.length === 0 && (
        <p className="text-sm text-slate-500 italic">No patterns surfaced — try picking more essays.</p>
      )}
      <div className="space-y-3">
        {result.buckets.map((b, bi) => {
          const palette = BUCKET_PALETTE[b.color] ?? BUCKET_PALETTE.blue;
          return (
            <div key={bi} className={`border ${palette.border} rounded-xl overflow-hidden`}>
              <div className={`${palette.headerBg} px-4 py-2 flex items-center justify-between gap-2`}>
                <div className="min-w-0">
                  <h4 className={`font-bold text-sm ${palette.headerText}`}>{b.title}</h4>
                  {b.titleEn && b.titleEn !== b.title && (
                    <div className="text-[10px] text-slate-500 font-medium mt-0.5">{b.titleEn}</div>
                  )}
                </div>
                <span className={`text-[10px] font-semibold uppercase tracking-wide ${palette.chip} px-2 py-0.5 rounded shrink-0`}>
                  {b.advice.length} tip{b.advice.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="px-4 py-3 space-y-3 bg-white">
                {b.advice.map((a, ai) => (
                  <div key={ai}>
                    <div className="text-sm font-bold text-[#001e40]">{a.tip}</div>
                    {a.tipEn && a.tipEn !== a.tip && (
                      <div className="text-xs text-slate-500 mt-0.5">{a.tipEn}</div>
                    )}
                    {a.why && <p className="text-xs text-slate-600 mt-1">{a.why}</p>}
                    {a.whyEn && a.whyEn !== a.why && (
                      <p className="text-[11px] text-slate-400 italic mt-0.5">{a.whyEn}</p>
                    )}
                    {a.examples.length > 0 && (
                      <div className="mt-2 space-y-1.5">
                        {a.examples.map((e, ei) => (
                          <div key={ei} className="text-xs bg-slate-50 rounded-md px-2.5 py-2 space-y-1">
                            {e.from && <div className="text-[10px] text-slate-500 uppercase tracking-wide">{e.from}</div>}
                            <div className="flex items-start gap-1.5">
                              <span className="text-rose-500 font-bold shrink-0">−</span>
                              <span className="text-slate-700 italic">&ldquo;{e.before}&rdquo;</span>
                            </div>
                            <div className="flex items-start gap-1.5">
                              <span className="text-emerald-600 font-bold shrink-0">+</span>
                              <span className="text-slate-800 font-medium">&ldquo;{e.after}&rdquo;</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
