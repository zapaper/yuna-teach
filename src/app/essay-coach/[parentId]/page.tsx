"use client";

// Parent-facing Essay Coach — upload + history for the selected child.
//
// Same upload pipeline as /admin/compo, but: scoped to the parent's
// linked students, no question-file upload (user scans the prompt
// page with the essay; OCR auto-detects), label auto-fills with the
// student's name + date. Main-app font + colour scheme.

import { useState, useEffect, useCallback, Suspense } from "react";
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
  status: "uploaded" | "analysing" | "ready" | "failed";
  errorMessage: string | null;
  analysedAt: string | null;
  createdAt: string;
  studentId: string | null;
  critique: { overallScore?: number } | null;
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

        {/* History */}
        <div>
          <h2 className="font-semibold text-[#001e40] mb-2">
            Past attempts {selectedName ? `for ${selectedName}` : ""}
          </h2>
          {loadingHistory ? (
            <p className="text-sm text-[#43474f]">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-[#43474f]">No essays yet — upload one above to get started.</p>
          ) : (
            <div className="space-y-2">
              {rows.map((r) => (
                <Link
                  key={r.id}
                  href={`/essay-coach/${parentId}/${r.id}?student=${studentId}`}
                  className="block bg-white border border-slate-200 rounded-xl p-4 hover:border-[#0040a0]/60 hover:shadow-sm transition"
                >
                  <div className="flex justify-between items-start gap-3">
                    <div className="min-w-0">
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
                      {r.critique?.overallScore !== undefined && (
                        <div className="text-sm font-bold text-[#001e40] mt-1">
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
