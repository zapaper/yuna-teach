"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import AdminNav from "@/components/AdminNav";

type Q = {
  id: string;
  questionNum: string;
  answer: string;
  hasImage: boolean;
  topic: string | null;
  marks: number | null;
  matchType: "exact" | "inline";
};

type P = {
  id: string;
  title: string;
  subject: string | null;
  year: string | null;
  createdAt: string;
  isPsle: boolean;
  questionCount: number;
  questions: Q[];
};

export default function SeeAnswerImagePage() {
  return (
    <Suspense>
      <Content />
    </Suspense>
  );
}

function Content() {
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";
  const [papers, setPapers] = useState<P[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalQuestions, setTotalQuestions] = useState(0);
  const [search, setSearch] = useState("");
  const [subjectFilter, setSubjectFilter] = useState<string | null>(null);
  const [hidePsle, setHidePsle] = useState(true);
  const [hideExact, setHideExact] = useState(false);
  const [hideInline, setHideInline] = useState(false);
  const [sortOrder, setSortOrder] = useState<"earliest" | "latest">("earliest");

  useEffect(() => {
    fetch(`/api/admin/see-answer-image`)
      .then(r => r.ok ? r.json() : { papers: [], totalQuestions: 0 })
      .then(d => { setPapers(d.papers ?? []); setTotalQuestions(d.totalQuestions ?? 0); })
      .finally(() => setLoading(false));
  }, []);

  const subjects = useMemo(
    () => [...new Set(papers.map(p => p.subject).filter((s): s is string => !!s))].sort(),
    [papers],
  );

  const filtered = useMemo(() => {
    const term = search.toLowerCase();
    return papers
      .filter(p => !subjectFilter || p.subject === subjectFilter)
      .filter(p => !term || p.title.toLowerCase().includes(term))
      .filter(p => !hidePsle || !p.isPsle)
      .map(p => ({
        ...p,
        questions: p.questions.filter(q => {
          if (hideExact && q.matchType === "exact") return false;
          if (hideInline && q.matchType === "inline") return false;
          return true;
        }),
      }))
      .filter(p => p.questions.length > 0)
      .slice()
      .sort((a, b) => {
        const aT = new Date(a.createdAt).getTime();
        const bT = new Date(b.createdAt).getTime();
        return sortOrder === "earliest" ? aT - bT : bT - aT;
      });
  }, [papers, search, subjectFilter, hidePsle, hideExact, hideInline, sortOrder]);

  const visibleQuestions = filtered.reduce((s, p) => s + p.questions.length, 0);

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24 lg:pb-0">
        <div className="max-w-5xl mx-auto px-5 lg:px-8 py-8">
          <h1 className="font-headline text-2xl font-extrabold text-[#001e40] mb-2">&ldquo;See answer image&rdquo; sweep</h1>
          <p className="text-sm text-slate-500 mb-6">
            Questions whose stored answer is just a pointer to a diagram (and therefore the AI marker has nothing concrete to compare against). Open the paper&apos;s /edit page and supplement the answer text with a written description.
          </p>

          <div className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100 mb-4">
            <div className="flex flex-col sm:flex-row gap-3 items-stretch">
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search by title…"
                className="flex-1 px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-blue-400"
              />
              <select
                value={subjectFilter ?? ""}
                onChange={e => setSubjectFilter(e.target.value || null)}
                className="px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-blue-400"
              >
                <option value="">All subjects</option>
                {subjects.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <select
                value={sortOrder}
                onChange={e => setSortOrder(e.target.value as "earliest" | "latest")}
                className="px-3 py-2 rounded-lg border border-slate-200 text-sm focus:outline-none focus:border-blue-400"
              >
                <option value="earliest">Earliest first</option>
                <option value="latest">Latest first</option>
              </select>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-600">
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={hidePsle} onChange={e => setHidePsle(e.target.checked)} className="w-4 h-4 accent-violet-500" />
                Hide official PSLE papers
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={hideExact} onChange={e => setHideExact(e.target.checked)} className="w-4 h-4 accent-violet-500" />
                Hide pure &ldquo;see image&rdquo;
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input type="checkbox" checked={hideInline} onChange={e => setHideInline(e.target.checked)} className="w-4 h-4 accent-violet-500" />
                Hide inline &ldquo;(a) see image&rdquo;
              </label>
            </div>
          </div>

          {loading ? (
            <p className="text-sm text-slate-400 py-8 text-center">Loading…</p>
          ) : (
            <div>
              <p className="text-xs text-slate-500 mb-3">
                Showing <span className="font-bold">{visibleQuestions}</span> questions across <span className="font-bold">{filtered.length}</span> papers (of {totalQuestions} flagged in total).
              </p>
              <div className="space-y-3">
                {filtered.map(p => (
                  <details key={p.id} className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
                    <summary className="px-4 py-3 cursor-pointer hover:bg-slate-50 flex items-center justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-slate-800 truncate">{p.title}</p>
                        <p className="text-xs text-slate-400 mt-0.5">
                          {[p.subject, p.year, new Date(p.createdAt).toLocaleDateString()].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                      <span className="text-[11px] font-bold text-rose-700 bg-rose-50 px-2 py-0.5 rounded">{p.questions.length} flagged</span>
                      <a
                        href={`/exam/${p.id}/edit${userId ? `?userId=${userId}` : ""}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={e => e.stopPropagation()}
                        className="text-xs font-bold text-violet-600 hover:underline whitespace-nowrap"
                      >Open /edit →</a>
                    </summary>
                    <div className="px-2 pb-3 overflow-x-auto">
                      <table className="min-w-full text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 text-slate-500">
                            <th className="px-3 py-2 text-left font-semibold">Q</th>
                            <th className="px-3 py-2 text-left font-semibold">Marks</th>
                            <th className="px-3 py-2 text-left font-semibold">Has image?</th>
                            <th className="px-3 py-2 text-left font-semibold">Type</th>
                            <th className="px-3 py-2 text-left font-semibold">Topic</th>
                            <th className="px-3 py-2 text-left font-semibold">Stored answer</th>
                          </tr>
                        </thead>
                        <tbody>
                          {p.questions.map(q => (
                            <tr key={q.id} className="border-b border-slate-100 align-top">
                              <td className="px-3 py-2 font-bold text-slate-700 whitespace-nowrap">Q{q.questionNum}</td>
                              <td className="px-3 py-2 text-slate-500">{q.marks ?? "—"}</td>
                              <td className="px-3 py-2">{q.hasImage ? <span className="text-emerald-600">✓</span> : <span className="text-rose-600">✗</span>}</td>
                              <td className="px-3 py-2 text-[10px] uppercase tracking-wider font-bold text-slate-400">{q.matchType}</td>
                              <td className="px-3 py-2 text-slate-500 text-[11px]">{q.topic ?? ""}</td>
                              <td className="px-3 py-2 text-slate-600 max-w-md">{q.answer.length > 200 ? q.answer.slice(0, 200) + "…" : q.answer}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                ))}
                {filtered.length === 0 && (
                  <p className="text-sm text-slate-400 py-8 text-center italic">No papers match the current filters.</p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
