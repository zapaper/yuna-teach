"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import AdminNav from "@/components/AdminNav";

export default function EnglishOralCoachPage() {
  return (
    <Suspense>
      <PageInner />
    </Suspense>
  );
}

type PaperRow = {
  year: string;
  status: string | null;
  paper4TextChars: number;
  hasPaper4Pages: boolean;
  readingPassagePreview: string;   // first ~600 chars of the reading section
  conversationPromptsPreview: string; // first ~600 chars of the conversation prompts
};

type LoadState = { rows: PaperRow[]; loading: boolean; error: string | null };

function PageInner() {
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [data, setData] = useState<LoadState>({ rows: [], loading: false, error: null });
  const [selectedYear, setSelectedYear] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`)
      .then(r => setAllowed(r.ok))
      .catch(() => setAllowed(false));
  }, [userId]);

  useEffect(() => {
    if (!allowed) return;
    setData(d => ({ ...d, loading: true, error: null }));
    fetch(`/api/admin/english-oral-coach/corpus?userId=${userId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
        return r.json();
      })
      .then((json: { rows: PaperRow[] }) => {
        setData({ rows: json.rows, loading: false, error: null });
        if (json.rows.length > 0 && !selectedYear) setSelectedYear(json.rows[0].year);
      })
      .catch((err: Error) => setData({ rows: [], loading: false, error: err.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed, userId]);

  if (allowed === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" />
      </div>
    );
  }
  if (!allowed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <p className="text-slate-500 text-sm">Access denied.</p>
      </div>
    );
  }

  const selected = data.rows.find(r => r.year === selectedYear) ?? null;

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24 lg:pb-0">
        <div className="bg-white border-b border-slate-200 px-4 py-3">
          <div className="flex items-center gap-3">
            <Link href={`/admin?userId=${userId}`} className="text-slate-400 hover:text-slate-600 text-xs">← Admin</Link>
            <h1 className="text-lg font-bold text-slate-800">Oral Coach (English) — v0</h1>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Live AI Paper-4 oral practice. This page is the design/dev harness — inspect the 10-year corpus and the
            SEAB grading rubric before we wire the student-facing live-voice module.
          </p>
        </div>

        <div className="max-w-5xl mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-4 gap-4">
          <div className="lg:col-span-1 space-y-3">
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Corpus</p>
              {data.loading && <p className="text-xs text-slate-400">Loading…</p>}
              {data.error && <p className="text-xs text-rose-600">{data.error}</p>}
              {!data.loading && !data.error && data.rows.length === 0 && (
                <p className="text-xs text-slate-400">No papers ingested yet.</p>
              )}
              <ul className="space-y-1.5">
                {data.rows.map((r) => (
                  <li key={r.year}>
                    <button
                      type="button"
                      onClick={() => setSelectedYear(r.year)}
                      className={`w-full text-left px-3 py-2 rounded-lg text-sm transition ${
                        selectedYear === r.year
                          ? "bg-indigo-50 text-indigo-700 font-semibold"
                          : "text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span>{r.year}</span>
                        <span className="text-[10px] text-slate-400">{r.paper4TextChars}c</span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">SEAB rubric — Reading Aloud (20)</p>
              <ul className="text-xs text-slate-600 space-y-1 list-disc ml-4">
                <li>Pronunciation &amp; articulation</li>
                <li>Fluency &amp; rhythm</li>
                <li>Expressiveness (pace, pause, tone)</li>
              </ul>
            </div>

            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">SEAB rubric — Stimulus Conversation (30)</p>
              <ul className="text-xs text-slate-600 space-y-1 list-disc ml-4">
                <li>Personal response with clear reasoning</li>
                <li>Engagement — extends beyond yes/no</li>
                <li>Language use — vocabulary, grammar</li>
                <li>Ability to build on examiner prompts</li>
              </ul>
              <p className="text-[10px] text-slate-400 mt-2">
                Model answers do NOT exist for Paper 4 by design — assessment is on delivery + reasoning, not correctness.
              </p>
            </div>
          </div>

          <div className="lg:col-span-3 space-y-4">
            {selected ? (
              <>
                <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="font-bold text-slate-800">Reading Passage — {selected.year}</h2>
                    <span className="text-[10px] uppercase tracking-wide text-indigo-600 bg-indigo-50 px-2 py-1 rounded">Component 1</span>
                  </div>
                  <pre className="text-xs text-slate-700 whitespace-pre-wrap font-sans leading-relaxed">
                    {selected.readingPassagePreview || "(no reading passage extracted)"}
                  </pre>
                </div>

                <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h2 className="font-bold text-slate-800">Stimulus-based Conversation — {selected.year}</h2>
                    <span className="text-[10px] uppercase tracking-wide text-emerald-600 bg-emerald-50 px-2 py-1 rounded">Component 2</span>
                  </div>
                  <pre className="text-xs text-slate-700 whitespace-pre-wrap font-sans leading-relaxed">
                    {selected.conversationPromptsPreview || "(no conversation prompts extracted)"}
                  </pre>
                </div>

                <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-5">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Next: live practice mode</p>
                  <p className="text-xs text-slate-500 leading-relaxed">
                    v1 will use a real-time voice model (Google Live-voice / Gemini Live) with looping talking-head avatars
                    to run the two components back-to-back:
                  </p>
                  <ol className="text-xs text-slate-600 mt-2 list-decimal ml-5 space-y-1">
                    <li>Reading Aloud: student reads the passage; model scores pronunciation, fluency, expressiveness.</li>
                    <li>Stimulus Conversation: model plays examiner, asks each prompt (a/b/c), follows up naturally.</li>
                    <li>Verdict: per-component score + specific feedback (words mispronounced, prompt answers that were too short, etc.).</li>
                  </ol>
                </div>
              </>
            ) : (
              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-8 text-center">
                <p className="text-sm text-slate-400">Select a year to preview.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
