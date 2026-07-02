"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import AdminNav from "@/components/AdminNav";
import { loadOralSession, clearOralSession, type OralSession } from "@/lib/oral-session";

// GET /admin/english-oral-coach/results
//
// End of a practice session: shows Reading Aloud (/15) + SBC (/25) =
// Total (/40), the top actionable tip from each segment, and a Save
// button. Session data is pulled from localStorage (populated by the
// Reading Aloud and SBC pages during the flow); nothing loads from
// the server on this screen — save is opt-in.

export default function OralResultsPage() {
  return (
    <Suspense>
      <PageInner />
    </Suspense>
  );
}

function PageInner() {
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";
  const [session, setSession] = useState<OralSession | null>(null);
  const [savingState, setSavingState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    setSession(loadOralSession());
  }, []);

  if (!session) {
    return (
      <div className="min-h-screen bg-slate-50">
        <AdminNav userId={userId} />
        <div className="lg:ml-56 pb-24 lg:pb-0">
          <div className="max-w-3xl mx-auto px-4 py-10 text-center">
            <p className="text-sm text-slate-500">No practice session in progress. Start one from the Oral Coach homepage.</p>
            <Link href={`/admin/english-oral-coach?userId=${userId}`} className="text-xs text-indigo-600 hover:underline mt-3 inline-block">← Oral Coach</Link>
          </div>
        </div>
      </div>
    );
  }

  const reading = session.reading;
  const sbc = session.sbc;
  const readingTotal = reading?.total ?? 0;
  const sbcTotal = sbc?.overallSeabScore ?? 0;
  const grandTotal = Math.round((readingTotal + sbcTotal) * 10) / 10;

  async function handleSave() {
    if (!session) return;
    setSavingState("saving");
    setSaveError(null);
    try {
      const resp = await fetch("/api/oral-coach/save-session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      setSavingState("saved");
    } catch (e) {
      setSaveError((e as Error).message);
      setSavingState("error");
    }
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24 lg:pb-0">
        <div className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3">
          <Link href={`/admin/english-oral-coach?userId=${userId}`} className="text-slate-400 hover:text-slate-600 text-xs">← Oral Coach</Link>
          <h1 className="text-lg font-bold text-slate-800">Practice Results</h1>
          <span className="text-xs text-slate-500 hidden sm:inline">Theme · {session.themeLabel}</span>
        </div>

        <div className="max-w-3xl mx-auto px-4 py-4 space-y-3">
          {/* Aggregate total */}
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5">
            <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">Combined Oral Score</p>
            <div className="flex items-end gap-2 mt-1">
              <span className="text-5xl font-bold text-slate-800 leading-none">{grandTotal}</span>
              <span className="text-lg text-slate-500 pb-1">/ 40</span>
            </div>
            <div className="grid grid-cols-2 gap-3 mt-3">
              <div className="rounded-xl bg-indigo-50 border border-indigo-100 p-3">
                <p className="text-[10px] uppercase tracking-wide text-indigo-600 font-semibold">Reading Aloud</p>
                <p className="text-2xl font-bold text-indigo-800">{readingTotal.toFixed(1)} <span className="text-xs text-indigo-500">/ 15</span></p>
                {reading && (
                  <div className="flex gap-3 mt-1 text-[11px] text-indigo-700/80">
                    <span>Pron {reading.pronunciation.toFixed(1)}</span>
                    <span>Flu {reading.fluencyRhythm.toFixed(1)}</span>
                    <span>Expr {reading.expressiveness.toFixed(1)}</span>
                  </div>
                )}
              </div>
              <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-3">
                <p className="text-[10px] uppercase tracking-wide text-emerald-600 font-semibold">Stimulus Conversation</p>
                <p className="text-2xl font-bold text-emerald-800">{sbcTotal} <span className="text-xs text-emerald-500">/ 25</span></p>
                {sbc && (
                  <div className="flex gap-3 mt-1 text-[11px] text-emerald-700/80">
                    <span>Q1 {sbc.q1Percent}%</span>
                    <span>Q2 {sbc.q2Percent}%</span>
                    <span>Q3 {sbc.q3Percent}%</span>
                  </div>
                )}
              </div>
            </div>
            {sbc?.overallVerdict && (
              <p className="text-xs text-slate-600 mt-3 leading-snug italic">&ldquo;{sbc.overallVerdict}&rdquo;</p>
            )}
          </div>

          {/* Top tips — one line per non-perfect segment */}
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
            <h2 className="text-sm font-bold text-slate-800 mb-2">Top things to work on next</h2>
            <div className="space-y-2">
              {(reading?.topTips ?? []).map((t, i) => (
                <TipRow key={`r${i}`} tone="indigo" segment="Reading" text={t} />
              ))}
              {(sbc?.topTips ?? []).map((t, i) => (
                <TipRow key={`s${i}`} tone="emerald" segment="Conversation" text={t} />
              ))}
              {(reading?.topTips ?? []).length === 0 && (sbc?.topTips ?? []).length === 0 && (
                <p className="text-xs text-slate-500 italic">No tips — top marks across the board. Try another theme.</p>
              )}
            </div>
          </div>

          {/* Save / retry actions */}
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={handleSave}
              disabled={savingState === "saving" || savingState === "saved"}
              className={`text-sm px-4 py-2 rounded-lg font-semibold ${
                savingState === "saved"
                  ? "bg-slate-200 text-slate-500"
                  : savingState === "saving"
                  ? "bg-slate-300 text-slate-600"
                  : "bg-indigo-600 text-white hover:bg-indigo-700"
              }`}
            >
              {savingState === "saving" ? "Saving…" : savingState === "saved" ? "✓ Saved" : "Save this session"}
            </button>
            <Link
              href={`/admin/english-oral-coach?userId=${userId}`}
              onClick={() => clearOralSession()}
              className="text-sm px-4 py-2 rounded-lg font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200"
            >
              Try another theme
            </Link>
            {saveError && <span className="text-xs text-rose-600 truncate">Save failed: {saveError}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function TipRow({ tone, segment, text }: { tone: "indigo" | "emerald"; segment: string; text: string }) {
  const bg = tone === "indigo" ? "bg-indigo-50 text-indigo-800 border-indigo-100" : "bg-emerald-50 text-emerald-800 border-emerald-100";
  const chip = tone === "indigo" ? "bg-indigo-600" : "bg-emerald-600";
  return (
    <div className={`rounded-lg border ${bg} p-2 flex gap-2 items-start`}>
      <span className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded ${chip} text-white flex-shrink-0`}>{segment}</span>
      <p className="text-xs leading-snug">{text}</p>
    </div>
  );
}
