"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import AdminNav from "@/components/AdminNav";
import { getOralAvatarKey, setOralAvatarKey, ORAL_AVATARS, type OralAvatarKey } from "@/lib/oral-avatar";
import { OralVoiceTester } from "@/components/OralVoiceTester";

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
  const [avatarKey, setAvatarKey] = useState<OralAvatarKey>("chinese");
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);

  useEffect(() => { setAvatarKey(getOralAvatarKey()); }, []);
  const chooseAvatar = (k: OralAvatarKey) => {
    setAvatarKey(k);
    setOralAvatarKey(k);
    setAvatarPickerOpen(false);
  };
  const currentAvatar = ORAL_AVATARS.find((a) => a.key === avatarKey) ?? ORAL_AVATARS[0];

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
            PSLE grading rubric before we wire the student-facing live-voice module.
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
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Reading Aloud rubric (20)</p>
              <ul className="text-xs text-slate-600 space-y-1 list-disc ml-4">
                <li>Pronunciation &amp; articulation</li>
                <li>Fluency &amp; rhythm</li>
                <li>Expressiveness (pace, pause, tone)</li>
              </ul>
            </div>

            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Stimulus Conversation rubric (25)</p>
              <ul className="text-xs text-slate-600 space-y-1 list-disc ml-4">
                <li><b>Q1 · Picture Response</b> (10) — engage with what&apos;s in the picture</li>
                <li><b>Q2 · Personal Response</b> (10) — specific personal experience</li>
                <li><b>Q3 · Critical Thinking</b> (5) — broader opinion / reasoning</li>
              </ul>
              <p className="text-[10px] text-slate-400 mt-2">
                2026 format: exactly three questions in order — no invented follow-ups.
              </p>
              <p className="text-[10px] text-slate-400 mt-2">
                Model answers do NOT exist for Paper 4 by design — assessment is on delivery + reasoning, not correctness.
              </p>
            </div>
          </div>

          <div className="lg:col-span-3 space-y-3">
            {selected ? (
              <>
                {/* Examiner picker — sits above Reading Aloud since
                    it applies to every practice session. Click the
                    current avatar to open the chooser; selection
                    persists to localStorage. */}
                <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-3 relative">
                  <div className="flex items-center gap-3">
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Examiner</p>
                    <button
                      type="button"
                      onClick={() => setAvatarPickerOpen((v) => !v)}
                      className="flex items-center gap-2 group"
                      title="Choose your examiner"
                    >
                      <div className="relative">
                        <Image
                          src={currentAvatar.thumb}
                          alt={currentAvatar.label}
                          width={40}
                          height={40}
                          unoptimized
                          className="w-10 h-10 rounded-full object-cover ring-2 ring-indigo-200 group-hover:ring-indigo-400 transition"
                        />
                        <span className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-white rounded-full flex items-center justify-center text-[9px] text-slate-500 shadow ring-1 ring-slate-200">▾</span>
                      </div>
                      <span className="text-sm font-semibold text-slate-800">{currentAvatar.label}</span>
                    </button>
                    <span className="ml-auto text-[10px] text-slate-400">Applies to Reading + SBC</span>
                  </div>
                  {avatarPickerOpen && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setAvatarPickerOpen(false)} />
                      <div className="absolute left-24 top-14 z-20 bg-white rounded-xl shadow-lg ring-1 ring-slate-200 p-2 flex gap-2">
                        {ORAL_AVATARS.map((a) => (
                          <button
                            key={a.key}
                            type="button"
                            onClick={() => chooseAvatar(a.key)}
                            className={`flex flex-col items-center gap-1 p-1.5 rounded-lg transition ${
                              a.key === avatarKey ? "bg-indigo-50 ring-2 ring-indigo-400" : "hover:bg-slate-50 ring-2 ring-transparent"
                            }`}
                          >
                            <Image src={a.thumb} alt={a.label} width={64} height={64} unoptimized className="w-16 h-16 rounded-full object-cover" />
                            <span className="text-[10px] font-semibold text-slate-700">{a.label}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                {/* Voice tester — tucked under the examiner picker so
                    admins can audition prebuilt voices before assigning
                    them to a persona in src/lib/oral-avatar.ts. */}
                <OralVoiceTester />

                {/* Reading Aloud — just the two practice buttons, no OCR preview */}
                <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-3">
                  <div className="flex items-center justify-between">
                    <h2 className="text-sm font-bold text-slate-800">Reading Aloud — {selected.year}</h2>
                    <div className="flex gap-2">
                      <Link href={`/admin/english-oral-coach/read/${selected.year}/1?userId=${userId}`} className="text-xs bg-indigo-600 text-white px-3 py-1.5 rounded-lg font-semibold hover:bg-indigo-700">Start Reading 1 →</Link>
                      <Link href={`/admin/english-oral-coach/read/${selected.year}/2?userId=${userId}`} className="text-xs bg-indigo-600 text-white px-3 py-1.5 rounded-lg font-semibold hover:bg-indigo-700">Start Reading 2 →</Link>
                    </div>
                  </div>
                </div>

                {/* SBC Day 1 — picture + start button */}
                <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-3">
                  <div className="flex items-center justify-between mb-2">
                    <h2 className="text-sm font-bold text-slate-800">SBC Day 1 — {selected.year}</h2>
                    <Link href={`/admin/english-oral-coach/sbc/${selected.year}/1?userId=${userId}`} className="text-xs bg-emerald-600 text-white px-3 py-1.5 rounded-lg font-semibold hover:bg-emerald-700">Start SBC 1 →</Link>
                  </div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/admin/english-oral-coach/stimulus/${selected.year}/1/image?v=2`}
                    alt={`${selected.year} Day 1 stimulus`}
                    className="w-full max-h-[280px] object-contain rounded-lg bg-slate-50"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                  />
                </div>

                {/* SBC Day 2 — picture + start button */}
                <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-3">
                  <div className="flex items-center justify-between mb-2">
                    <h2 className="text-sm font-bold text-slate-800">SBC Day 2 — {selected.year}</h2>
                    <Link href={`/admin/english-oral-coach/sbc/${selected.year}/2?userId=${userId}`} className="text-xs bg-emerald-600 text-white px-3 py-1.5 rounded-lg font-semibold hover:bg-emerald-700">Start SBC 2 →</Link>
                  </div>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/admin/english-oral-coach/stimulus/${selected.year}/2/image?v=2`}
                    alt={`${selected.year} Day 2 stimulus`}
                    className="w-full max-h-[280px] object-contain rounded-lg bg-slate-50"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                  />
                </div>
              </>
            ) : (
              <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-6 text-center">
                <p className="text-sm text-slate-400">Select a year to preview.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
