"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import AdminNav from "@/components/AdminNav";
import { getOralAvatarKey, setOralAvatarKey, ORAL_AVATARS, type OralAvatarKey } from "@/lib/oral-avatar";
import { ORAL_THEMES, CATEGORY_STYLES } from "@/lib/oral-themes";
// Voice-tester import removed — the picker component still exists at
// src/components/OralVoiceTester.tsx if you need to audition voices;
// re-import it here to drop back onto the page.

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
  const [selectedThemeId, setSelectedThemeId] = useState<string | null>(null);
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
    // Prime a theme so the right pane isn't empty on first visit —
    // fall back to the first theme (2025 D1, "Queuing & orderliness").
    if (!selectedThemeId) setSelectedThemeId(ORAL_THEMES[0].id);
    setData(d => ({ ...d, loading: true, error: null }));
    fetch(`/api/admin/english-oral-coach/corpus?userId=${userId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
        return r.json();
      })
      .then((json: { rows: PaperRow[] }) => {
        setData({ rows: json.rows, loading: false, error: null });
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

  const selectedTheme = ORAL_THEMES.find((t) => t.id === selectedThemeId) ?? null;

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
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Themes</p>
              {data.loading && <p className="text-xs text-slate-400">Loading…</p>}
              {data.error && <p className="text-xs text-rose-600">{data.error}</p>}
              <ul className="space-y-1.5">
                {ORAL_THEMES.map((t) => {
                  const cat = CATEGORY_STYLES[t.category] ?? CATEGORY_STYLES.Community;
                  const active = selectedThemeId === t.id;
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedThemeId(t.id)}
                        className={`w-full text-left px-3 py-2.5 rounded-xl text-sm transition flex items-center justify-between gap-2 ${
                          active ? "bg-indigo-50 ring-2 ring-indigo-400" : "hover:bg-slate-50 ring-1 ring-transparent hover:ring-slate-200"
                        }`}
                      >
                        <span className={`font-semibold ${active ? "text-indigo-700" : "text-slate-800"}`}>{t.theme}</span>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full ${cat.bg} ${cat.text} ring-1 ${cat.ring} flex-shrink-0 font-medium`}>{t.category}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Reading Aloud — what to focus on</p>
              <ul className="text-xs text-slate-700 space-y-2">
                <li>
                  <b className="text-indigo-700">Pronunciation</b>
                  <p className="text-[11px] text-slate-500 mt-0.5">Sound every consonant clearly (final /t/, /d/, /s/). Don&apos;t drop endings. Watch tricky vowels: &ldquo;bed&rdquo; ≠ &ldquo;bad&rdquo;.</p>
                </li>
                <li>
                  <b className="text-purple-700">Fluency &amp; rhythm</b>
                  <p className="text-[11px] text-slate-500 mt-0.5">Aim for 120–140 words / minute. Pause at commas and full stops; don&apos;t rush or stall mid-phrase.</p>
                </li>
                <li>
                  <b className="text-amber-700">Expressiveness</b>
                  <p className="text-[11px] text-slate-500 mt-0.5">Move the pitch: up for questions, down for full stops. Stress content words (nouns, verbs); soften linkers. Feel the emotion in the passage.</p>
                </li>
              </ul>
            </div>

            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Stimulus Conversation — what to focus on</p>
              <ul className="text-xs text-slate-700 space-y-2">
                <li>
                  <b className="text-blue-700">Q1 · Picture Response</b>
                  <p className="text-[11px] text-slate-500 mt-0.5">Name one specific detail you can see. Take a clear position with &ldquo;I think…&rdquo; and back it with a &ldquo;because…&rdquo; that ties to the picture.</p>
                </li>
                <li>
                  <b className="text-purple-700">Q2 · Personal Response</b>
                  <p className="text-[11px] text-slate-500 mt-0.5">Tell a specific story from your life — name the place, the person, and roughly when. Not a textbook answer.</p>
                </li>
                <li>
                  <b className="text-amber-700">Q3 · Critical Thinking</b>
                  <p className="text-[11px] text-slate-500 mt-0.5">Go beyond &ldquo;me&rdquo; — talk about &ldquo;people&rdquo;, &ldquo;society&rdquo;, or &ldquo;the community&rdquo;. Weigh both sides, then take a stand and use a connective (&ldquo;However&rdquo;, &ldquo;Therefore&rdquo;).</p>
                </li>
              </ul>
              <p className="text-[10px] text-slate-400 mt-3">
                2026 format: exactly three questions in order — no invented follow-ups.
              </p>
            </div>
          </div>

          <div className="lg:col-span-3 space-y-3">
            {selectedTheme ? (
              <>
                {/* Examiner picker */}
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

                {/* Theme header + Start Practice CTA. Practice runs:
                    Reading Aloud (15) -> Continue -> SBC (25, day
                    randomised) -> Aggregate (/40). No manual pick of
                    Reading vs SBC — everything flows from "Start". */}
                <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-4">
                  <div className="flex items-center gap-2 mb-1">
                    <h2 className="text-base font-bold text-slate-800">{selectedTheme.theme}</h2>
                    {(() => {
                      const cat = CATEGORY_STYLES[selectedTheme.category] ?? CATEGORY_STYLES.Community;
                      return <span className={`text-[10px] px-2 py-0.5 rounded-full ${cat.bg} ${cat.text} ring-1 ${cat.ring}`}>{selectedTheme.category}</span>;
                    })()}
                    {selectedTheme.isAuthentic && (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-white">PSLE {selectedTheme.year}</span>
                    )}
                  </div>
                  <p className="text-xs text-slate-600 leading-snug mb-3">{selectedTheme.blurb}</p>
                  <div className="flex items-center gap-4 flex-wrap mt-1">
                    <Link
                      href={`/admin/english-oral-coach/read/${selectedTheme.year}/${selectedTheme.day}?userId=${userId}&flow=1`}
                      className="text-base bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold shadow-md hover:bg-indigo-700 hover:shadow-lg transition"
                    >
                      Start Practice →
                    </Link>
                    <p className="text-xs text-slate-500 leading-snug flex-1 min-w-[200px]">
                      Reading Aloud (15 marks), then Stimulus Conversation (25 marks). One picture is picked for you at the SBC stage.
                    </p>
                  </div>
                </div>
              </>
            ) : (
              <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-6 text-center">
                <p className="text-sm text-slate-400">Pick a theme on the left to start.</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
