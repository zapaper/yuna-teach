"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import AdminNav from "@/components/AdminNav";
import { loadOralSession, clearOralSession, type OralSession } from "@/lib/oral-session";

// 华文口试练习成绩单.
//
// Mirrors the English results page. Combined score is 朗读 (/10) +
// 会话 (/30) = /40. If Reading Aloud was skipped, the summary shows
// just the 会话 /30 without pretending the student got 0 on the
// skipped section.

export default function ChineseOralResultsPage() {
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
  const [expanded, setExpanded] = useState<"reading" | "sbc" | null>(null);

  useEffect(() => { setSession(loadOralSession()); }, []);

  if (!session) {
    return (
      <div className="min-h-screen bg-slate-50">
        <AdminNav userId={userId} />
        <div className="lg:ml-56 pb-24 lg:pb-0">
          <div className="max-w-3xl mx-auto px-4 py-10 text-center">
            <p className="text-sm text-slate-500">没有进行中的练习。请从主页开始新的一次。</p>
            <Link href={`/admin/chinese-oral-coach?userId=${userId}`} className="text-xs text-indigo-600 hover:underline mt-3 inline-block">← 返回主页</Link>
          </div>
        </div>
      </div>
    );
  }

  const reading = session.reading;
  const sbc = session.sbc;
  // Chinese Reading Aloud stores percent scores in the session's
  // pronunciation / fluencyRhythm / expressiveness fields (see the
  // Chinese Read page's ContinueToSbcButton). Total is /10 here.
  const readingTotal = reading?.total ?? 0;
  const sbcTotal = sbc?.overallSeabScore ?? 0;
  const readingSkipped = !reading;
  const grandOutOf = readingSkipped ? 30 : 40;
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
          <Link href={`/admin/chinese-oral-coach?userId=${userId}`} className="text-slate-400 hover:text-slate-600 text-xs">← 主页</Link>
          <h1 className="text-lg font-bold text-slate-800">口试成绩单 · Practice Results</h1>
          <span className="text-xs text-slate-500 hidden sm:inline">主题:{session.themeLabel}</span>
        </div>

        <div className="max-w-3xl mx-auto px-4 py-4 space-y-3">
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-5">
            <p className="text-[10px] uppercase tracking-wide text-slate-500 font-semibold">
              {readingSkipped ? "会话得分" : "口试总分"}
            </p>
            <div className="flex items-end gap-2 mt-1">
              <span className="text-5xl font-bold text-slate-800 leading-none">{grandTotal}</span>
              <span className="text-lg text-slate-500 pb-1">/ {grandOutOf}</span>
              {readingSkipped && (
                <span className="text-[10px] uppercase tracking-wide bg-slate-100 text-slate-500 px-2 py-0.5 rounded-full pb-1">跳过朗读</span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 mt-3">
              <button
                type="button"
                disabled={readingSkipped}
                onClick={() => setExpanded(expanded === "reading" ? null : "reading")}
                className={`text-left rounded-xl border p-3 transition ${
                  readingSkipped
                    ? "bg-slate-50 border-slate-200 cursor-not-allowed"
                    : expanded === "reading"
                    ? "bg-indigo-100 border-indigo-300 ring-2 ring-indigo-300"
                    : "bg-indigo-50 border-indigo-100 hover:bg-indigo-100 hover:border-indigo-200 cursor-pointer"
                }`}
              >
                <div className="flex items-center justify-between">
                  <p className={`text-[10px] uppercase tracking-wide font-semibold ${readingSkipped ? "text-slate-400" : "text-indigo-600"}`}>朗读 · Reading Aloud</p>
                  {!readingSkipped && (
                    <span className="text-[10px] text-indigo-500">{expanded === "reading" ? "▲ 收起" : "▼ 详细"}</span>
                  )}
                </div>
                {readingSkipped ? (
                  <p className="text-sm text-slate-400 mt-1 italic">已跳过 —— 未评分。</p>
                ) : (
                  <>
                    <p className="text-2xl font-bold text-indigo-800">{readingTotal.toFixed(1)} <span className="text-xs text-indigo-500">/ 10</span></p>
                    <div className="flex gap-3 mt-1 text-[11px] text-indigo-700/80">
                      <span>发音 {Math.round(reading!.pronunciation)}%</span>
                      <span>流利 {Math.round(reading!.fluencyRhythm)}%</span>
                      <span>语调 {Math.round(reading!.expressiveness)}%</span>
                    </div>
                  </>
                )}
              </button>
              <button
                type="button"
                disabled={!sbc}
                onClick={() => setExpanded(expanded === "sbc" ? null : "sbc")}
                className={`text-left rounded-xl border p-3 transition ${
                  !sbc
                    ? "bg-slate-50 border-slate-200 cursor-not-allowed"
                    : expanded === "sbc"
                    ? "bg-emerald-100 border-emerald-300 ring-2 ring-emerald-300"
                    : "bg-emerald-50 border-emerald-100 hover:bg-emerald-100 hover:border-emerald-200 cursor-pointer"
                }`}
              >
                <div className="flex items-center justify-between">
                  <p className="text-[10px] uppercase tracking-wide text-emerald-600 font-semibold">会话 · Conversation</p>
                  {sbc && (
                    <span className="text-[10px] text-emerald-600">{expanded === "sbc" ? "▲ 收起" : "▼ 详细"}</span>
                  )}
                </div>
                <p className="text-2xl font-bold text-emerald-800">{sbcTotal} <span className="text-xs text-emerald-500">/ 30</span></p>
                {sbc && (
                  <div className="flex gap-3 mt-1 text-[11px] text-emerald-700/80">
                    <span>描述 {sbc.q1Percent}%</span>
                    <span>意见 {sbc.q2Percent}%</span>
                    <span>经历 {sbc.q3Percent}%</span>
                  </div>
                )}
              </button>
            </div>
            {sbc?.overallVerdict && (
              <p className="text-xs text-slate-600 mt-3 leading-snug italic">&ldquo;{sbc.overallVerdict}&rdquo;</p>
            )}

            {expanded === "reading" && reading && (
              <div className="mt-3 rounded-xl border border-indigo-200 bg-white p-3">
                <p className="text-xs font-semibold text-indigo-700 uppercase tracking-wide mb-2">朗读详细</p>
                <div className="grid grid-cols-3 gap-2 mb-3">
                  <div className="rounded-lg bg-indigo-50 border border-indigo-100 p-2 text-center">
                    <p className="text-[10px] text-indigo-600 uppercase tracking-wide font-semibold">发音与声调</p>
                    <p className="text-lg font-bold text-indigo-800">{Math.round(reading.pronunciation)}<span className="text-[10px] text-indigo-500 ml-0.5">%</span></p>
                  </div>
                  <div className="rounded-lg bg-indigo-50 border border-indigo-100 p-2 text-center">
                    <p className="text-[10px] text-indigo-600 uppercase tracking-wide font-semibold">流利度</p>
                    <p className="text-lg font-bold text-indigo-800">{Math.round(reading.fluencyRhythm)}<span className="text-[10px] text-indigo-500 ml-0.5">%</span></p>
                  </div>
                  <div className="rounded-lg bg-indigo-50 border border-indigo-100 p-2 text-center">
                    <p className="text-[10px] text-indigo-600 uppercase tracking-wide font-semibold">语调</p>
                    <p className="text-lg font-bold text-indigo-800">{Math.round(reading.expressiveness)}<span className="text-[10px] text-indigo-500 ml-0.5">%</span></p>
                  </div>
                </div>
                <p className="text-[10px] text-slate-500 uppercase tracking-wide font-semibold mb-1">建议</p>
                <ul className="space-y-1">
                  {reading.topTips.map((t, i) => (
                    <li key={i} className="text-xs text-slate-700 leading-snug">• {t}</li>
                  ))}
                </ul>
                <Link
                  href={`/admin/chinese-oral-coach/read/${reading.year}?userId=${userId}`}
                  className="mt-3 inline-block text-[11px] text-indigo-600 hover:underline"
                >
                  再读一次 →
                </Link>
              </div>
            )}

            {expanded === "sbc" && sbc && (
              <div className="mt-3 rounded-xl border border-emerald-200 bg-white p-3">
                <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wide mb-2">会话详细</p>
                <div className="grid grid-cols-3 gap-2 mb-3">
                  <div className="rounded-lg bg-emerald-50 border border-emerald-100 p-2 text-center">
                    <p className="text-[10px] text-emerald-600 uppercase tracking-wide font-semibold">Q1 · 描述</p>
                    <p className="text-lg font-bold text-emerald-800">{sbc.q1Percent}<span className="text-[10px] text-emerald-500 ml-0.5">%</span></p>
                  </div>
                  <div className="rounded-lg bg-emerald-50 border border-emerald-100 p-2 text-center">
                    <p className="text-[10px] text-emerald-600 uppercase tracking-wide font-semibold">Q2 · 意见</p>
                    <p className="text-lg font-bold text-emerald-800">{sbc.q2Percent}<span className="text-[10px] text-emerald-500 ml-0.5">%</span></p>
                  </div>
                  <div className="rounded-lg bg-emerald-50 border border-emerald-100 p-2 text-center">
                    <p className="text-[10px] text-emerald-600 uppercase tracking-wide font-semibold">Q3 · 经历</p>
                    <p className="text-lg font-bold text-emerald-800">{sbc.q3Percent}<span className="text-[10px] text-emerald-500 ml-0.5">%</span></p>
                  </div>
                </div>
                <p className="text-[10px] text-slate-500 uppercase tracking-wide font-semibold mb-1">建议</p>
                <ul className="space-y-1">
                  {sbc.topTips.map((t, i) => (
                    <li key={i} className="text-xs text-slate-700 leading-snug">• {t}</li>
                  ))}
                </ul>
                <Link
                  href={`/admin/chinese-oral-coach/sbc/${sbc.year}?userId=${userId}`}
                  className="mt-3 inline-block text-[11px] text-emerald-700 hover:underline"
                >
                  再练一次会话 →
                </Link>
              </div>
            )}
          </div>

          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
            <h2 className="text-sm font-bold text-slate-800 mb-2">下次可以改进的地方</h2>
            <div className="space-y-2">
              {(reading?.topTips ?? []).map((t, i) => (
                <TipRow key={`r${i}`} tone="indigo" segment="朗读" text={t} />
              ))}
              {(sbc?.topTips ?? []).map((t, i) => (
                <TipRow key={`s${i}`} tone="emerald" segment="会话" text={t} />
              ))}
              {(reading?.topTips ?? []).length === 0 && (sbc?.topTips ?? []).length === 0 && (
                <p className="text-xs text-slate-500 italic">全线满分 —— 换一个主题继续挑战。</p>
              )}
            </div>
          </div>

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
              {savingState === "saving" ? "保存中…" : savingState === "saved" ? "✓ 已保存" : "保存这次练习"}
            </button>
            <Link
              href={`/admin/chinese-oral-coach?userId=${userId}`}
              onClick={() => clearOralSession()}
              className="text-sm px-4 py-2 rounded-lg font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200"
            >
              再练一次
            </Link>
            {saveError && <span className="text-xs text-rose-600 truncate">保存失败:{saveError}</span>}
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
