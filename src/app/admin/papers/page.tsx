"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import AdminNav from "@/components/AdminNav";

interface Paper {
  id: string;
  title: string;
  subject: string | null;
  level: string | null;
  school: string | null;
  year: string | null;
  examType: string | null;
  visible: boolean;
  extractionStatus: string | null;
  questionCount: number;
  assignmentCount: number;
  createdAt: string;
}

export default function AdminPapersPage() {
  return (
    <Suspense>
      <AdminPapersContent />
    </Suspense>
  );
}

function AdminPapersContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const userId = searchParams.get("userId") ?? "";

  const [papers, setPapers] = useState<Paper[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [subjectFilter, setSubjectFilter] = useState<string | null>(null);
  const [yearFilter, setYearFilter] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    fetch(`/api/admin/papers?userId=${userId}`)
      .then(r => r.ok ? r.json() : { papers: [] })
      .then(d => setPapers(d.papers ?? []))
      .finally(() => setLoading(false));
  }, [userId]);

  async function toggleVisible(paper: Paper) {
    setToggling(paper.id);
    try {
      const res = await fetch(`/api/exam/${paper.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visible: !paper.visible }),
      });
      if (res.ok) {
        setPapers(prev => prev.map(p => p.id === paper.id ? { ...p, visible: !paper.visible } : p));
      }
    } finally {
      setToggling(null);
    }
  }

  async function deletePaper(id: string) {
    setDeleting(id);
    try {
      const res = await fetch(`/api/exam/${id}?userId=${userId}`, { method: "DELETE" });
      if (res.ok) {
        setPapers(prev => prev.filter(p => p.id !== id));
      }
    } finally {
      setDeleting(null);
      setConfirmDelete(null);
    }
  }

  const subjects = Array.from(new Set(papers.map(p => p.subject).filter(Boolean))).sort() as string[];
  const years = Array.from(new Set(papers.map(p => p.year).filter(Boolean))).sort((a, b) => b!.localeCompare(a!)) as string[];
  const examTypes = Array.from(new Set(papers.map(p => p.examType).filter(Boolean))).sort() as string[];

  const filtered = papers.filter(p => {
    if (subjectFilter && p.subject !== subjectFilter) return false;
    if (yearFilter && p.year !== yearFilter) return false;
    if (typeFilter && p.examType !== typeFilter) return false;
    if (search.trim()) {
      const s = search.toLowerCase();
      return (
        p.title.toLowerCase().includes(s) ||
        (p.school ?? "").toLowerCase().includes(s) ||
        (p.level ?? "").toLowerCase().includes(s) ||
        (p.year ?? "").includes(s)
      );
    }
    return true;
  });

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />

      {/* Content — offset for desktop sidebar, padding-bottom for mobile nav */}
      <div className="lg:ml-56 pb-24 lg:pb-0">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3 sticky top-0 z-10">
        <div className="flex-1">
          <h1 className="text-base font-bold text-slate-800">Exam Papers</h1>
          <p className="text-xs text-slate-400">{papers.length} master papers</p>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-5 space-y-3">
        {/* Search */}
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search title, school…"
          className="w-full px-4 py-2 rounded-xl border border-slate-200 bg-white text-sm focus:outline-none focus:border-slate-400"
        />

        {/* Subject filter */}
        {subjects.length > 0 && (
          <div className="flex gap-2 flex-wrap items-center">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider w-14 shrink-0">Subject</span>
            {subjects.map(s => (
              <button key={s} onClick={() => setSubjectFilter(subjectFilter === s ? null : s)}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-colors ${subjectFilter === s ? "bg-slate-800 text-white border-slate-800" : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"}`}>
                {s}
              </button>
            ))}
          </div>
        )}

        {/* Year filter */}
        {years.length > 0 && (
          <div className="flex gap-2 flex-wrap items-center">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider w-14 shrink-0">Year</span>
            {years.map(y => (
              <button key={y} onClick={() => setYearFilter(yearFilter === y ? null : y)}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-colors ${yearFilter === y ? "bg-blue-600 text-white border-blue-600" : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"}`}>
                {y}
              </button>
            ))}
          </div>
        )}

        {/* Exam type filter */}
        {examTypes.length > 0 && (
          <div className="flex gap-2 flex-wrap items-center">
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider w-14 shrink-0">Type</span>
            {examTypes.map(t => (
              <button key={t} onClick={() => setTypeFilter(typeFilter === t ? null : t)}
                className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-colors ${typeFilter === t ? "bg-violet-600 text-white border-violet-600" : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"}`}>
                {t}
              </button>
            ))}
          </div>
        )}

        {/* Active filter chips + clear */}
        {(subjectFilter || yearFilter || typeFilter) && (
          <button onClick={() => { setSubjectFilter(null); setYearFilter(null); setTypeFilter(null); }}
            className="text-xs text-slate-400 hover:text-slate-600 underline">
            Clear all filters
          </button>
        )}

        {/* Stats row */}
        <div className="flex gap-3 text-xs text-slate-500">
          <span>{filtered.length} shown</span>
          <span>·</span>
          <span className="text-green-600 font-semibold">{papers.filter(p => p.visible).length} visible</span>
          <span>·</span>
          <span className="text-slate-400">{papers.filter(p => !p.visible).length} hidden</span>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-600" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-center text-slate-400 text-sm py-16">No papers found.</p>
        ) : (
          <div className="space-y-2">
            {filtered.map(paper => (
              <div key={paper.id} className="bg-white rounded-2xl border border-slate-100 shadow-sm px-4 py-3 flex items-center gap-3">
                {/* Visibility indicator */}
                <div className={`w-2 h-2 rounded-full shrink-0 ${paper.visible ? "bg-green-500" : "bg-slate-300"}`} />

                {/* Info — clickable to paper overview */}
                <div className="flex-1 min-w-0 cursor-pointer" onClick={() => router.push(`/exam/${paper.id}/overview?userId=${userId}`)}>
                  <p className="text-sm font-semibold text-slate-800 truncate">{paper.title}</p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {[paper.level, paper.subject, paper.school, paper.year, paper.examType].filter(Boolean).join(" · ")}
                    {" · "}
                    <span>{paper.questionCount}q</span>
                    {paper.assignmentCount > 0 && <span className="text-blue-500"> · {paper.assignmentCount} assigned</span>}
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${
                      paper.extractionStatus === "ready" ? "bg-green-50 text-green-700" :
                      paper.extractionStatus === "processing" ? "bg-amber-50 text-amber-700" :
                      paper.extractionStatus === "failed" ? "bg-red-50 text-red-700" :
                      "bg-slate-50 text-slate-500"
                    }`}>
                      {paper.extractionStatus ?? "—"}
                    </span>
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${
                      paper.visible ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-500"
                    }`}>
                      {paper.visible ? "Visible" : "Hidden"}
                    </span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 shrink-0">
                  {/* Edit */}
                  <button
                    onClick={() => router.push(`/exam/${paper.id}/edit?userId=${userId}`)}
                    title="Edit paper"
                    className="w-9 h-9 rounded-xl flex items-center justify-center bg-blue-50 text-blue-500 hover:bg-blue-100 transition-colors"
                  >
                    <span className="material-symbols-outlined text-base">edit</span>
                  </button>

                  {/* Toggle visible */}
                  <button
                    onClick={() => toggleVisible(paper)}
                    disabled={toggling === paper.id}
                    title={paper.visible ? "Hide paper" : "Make visible"}
                    className={`w-9 h-9 rounded-xl flex items-center justify-center transition-colors ${
                      paper.visible ? "bg-green-50 text-green-600 hover:bg-green-100" : "bg-slate-100 text-slate-400 hover:bg-slate-200"
                    }`}
                  >
                    {toggling === paper.id ? (
                      <div className="animate-spin rounded-full h-4 w-4 border-2 border-current border-t-transparent" />
                    ) : (
                      <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: paper.visible ? "'FILL' 1" : "'FILL' 0" }}>
                        {paper.visible ? "visibility" : "visibility_off"}
                      </span>
                    )}
                  </button>

                  {/* Delete */}
                  {confirmDelete === paper.id ? (
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => deletePaper(paper.id)}
                        disabled={deleting === paper.id}
                        className="px-3 py-1.5 rounded-lg bg-red-500 text-white text-xs font-bold hover:bg-red-600 disabled:opacity-50"
                      >
                        {deleting === paper.id ? "…" : "Delete"}
                      </button>
                      <button
                        onClick={() => setConfirmDelete(null)}
                        className="px-3 py-1.5 rounded-lg bg-slate-100 text-slate-600 text-xs font-medium"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(paper.id)}
                      className="w-9 h-9 rounded-xl flex items-center justify-center bg-red-50 text-red-400 hover:bg-red-100 hover:text-red-600 transition-colors"
                    >
                      <span className="material-symbols-outlined text-base">delete</span>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
