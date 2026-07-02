"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import AdminNav from "@/components/AdminNav";
import { getOralAvatarKey, setOralAvatarKey, ORAL_AVATARS, type OralAvatarKey } from "@/lib/oral-avatar";
import { ORAL_THEMES_ZH, CATEGORY_STYLES_ZH, type OralThemeZh } from "@/lib/oral-themes-zh";
import { saveOralSession, clearOralSession } from "@/lib/oral-session";

// Chinese Oral Coach — sibling of /admin/english-oral-coach. Same
// flow (theme -> Reading Aloud -> Continue -> SBC -> Aggregate) but
// PSLE 华文 rubric: 朗读 /20 + 会话 /30 = 50 marks total.
//
// No PSLE Chinese oral corpus in the DB — themes + passages come
// from src/lib/oral-themes-zh.ts. Stimulus pictures are reused from
// the English module's R2 uploads (visuals are language-agnostic).

export default function ChineseOralCoachPage() {
  return (
    <Suspense>
      <PageInner />
    </Suspense>
  );
}

function PageInner() {
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [selectedThemeId, setSelectedThemeId] = useState<string>(ORAL_THEMES_ZH[0].id);
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

  const selectedTheme: OralThemeZh = ORAL_THEMES_ZH.find((t) => t.id === selectedThemeId) ?? ORAL_THEMES_ZH[0];

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24 lg:pb-0">
        <div className="bg-white border-b border-slate-200 px-4 py-3">
          <div className="flex items-center gap-3">
            <Link href={`/admin?userId=${userId}`} className="text-slate-400 hover:text-slate-600 text-xs">← Admin</Link>
            <h1 className="text-lg font-bold text-slate-800">华文口试练习 · Oral Coach (Chinese) — v0</h1>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            Chinese PSLE Paper 3 Oral: 朗读 (10 marks) + 会话 (30 marks) = 40 marks total.
          </p>
        </div>

        <div className="max-w-5xl mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-4 gap-4">
          <div className="lg:col-span-1 space-y-3">
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">主题 · Themes</p>
              <ul className="space-y-1.5">
                {ORAL_THEMES_ZH.map((t) => {
                  const cat = CATEGORY_STYLES_ZH[t.category] ?? CATEGORY_STYLES_ZH["社区"];
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
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">朗读 · Reading Aloud (10)</p>
              <ul className="text-xs text-slate-700 space-y-2">
                <li>
                  <b className="text-indigo-700">发音与声调</b>
                  <p className="text-[11px] text-slate-500 mt-0.5">读准每一个字,尤其是二三声和 得/的/地。不加字、不漏字、不换字。</p>
                </li>
                <li>
                  <b className="text-purple-700">流利度</b>
                  <p className="text-[11px] text-slate-500 mt-0.5">按词语和标点断句,不要一字一字地读。声音要连贯自然。</p>
                </li>
                <li>
                  <b className="text-amber-700">语调 / 表情达意</b>
                  <p className="text-[11px] text-slate-500 mt-0.5">问号要上扬,句号要下降;重点词要加强。让声音带出感情。</p>
                </li>
              </ul>
            </div>

            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4">
              <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">会话 · Stimulus Conversation (30)</p>
              <ul className="text-xs text-slate-700 space-y-2">
                <li>
                  <b className="text-blue-700">Q1 · 描述</b>
                  <p className="text-[11px] text-slate-500 mt-0.5">仔细看图,说出图片里的人、事、物,并给出你的看法。</p>
                </li>
                <li>
                  <b className="text-purple-700">Q2 · 表达意见</b>
                  <p className="text-[11px] text-slate-500 mt-0.5">表明立场,说明理由。用「我觉得…因为…」的句型,内容要有深度。</p>
                </li>
                <li>
                  <b className="text-amber-700">Q3 · 分享经历</b>
                  <p className="text-[11px] text-slate-500 mt-0.5">分享一次亲身经历。要有具体的地点、人物、事件,不要只说「很好」。</p>
                </li>
              </ul>
              <p className="text-[10px] text-slate-400 mt-3">
                2026 格式:三道必答题,考官会追问。
              </p>
            </div>
          </div>

          <div className="lg:col-span-3 space-y-3">
            {/* Examiner picker */}
            <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-3 relative">
              <div className="flex items-center gap-3">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">考官 · Examiner</p>
                <button
                  type="button"
                  onClick={() => setAvatarPickerOpen((v) => !v)}
                  className="flex items-center gap-2 group"
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
                <span className="ml-auto text-[10px] text-slate-400">同时用于朗读和会话</span>
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

            {/* Theme header + Start Practice CTA */}
            <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-4">
              <div className="flex items-center gap-2 mb-1">
                <h2 className="text-base font-bold text-slate-800">{selectedTheme.theme}</h2>
                {(() => {
                  const cat = CATEGORY_STYLES_ZH[selectedTheme.category] ?? CATEGORY_STYLES_ZH["社区"];
                  return <span className={`text-[10px] px-2 py-0.5 rounded-full ${cat.bg} ${cat.text} ring-1 ${cat.ring}`}>{selectedTheme.category}</span>;
                })()}
              </div>
              <p className="text-xs text-slate-600 leading-snug mb-3">{selectedTheme.blurb}</p>
              <div className="flex items-center gap-4 flex-wrap mt-1">
                <button
                  type="button"
                  onClick={() => {
                    // Reuse the same session store as the English flow —
                    // the shape doesn't care what language it is; the
                    // downstream Reading/SBC pages tell each other
                    // through the URL that this is the Chinese module.
                    clearOralSession();
                    saveOralSession({
                      themeId: selectedTheme.id,
                      themeLabel: selectedTheme.theme,
                      avatarKey,
                      startedAt: Date.now(),
                    });
                    window.location.href = `/admin/chinese-oral-coach/read/${selectedTheme.id}?userId=${userId}&flow=1`;
                  }}
                  className="text-base bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold shadow-md hover:bg-indigo-700 hover:shadow-lg transition"
                >
                  开始练习 · Start Practice →
                </button>
                <p className="text-xs text-slate-500 leading-snug flex-1 min-w-[200px]">
                  先朗读(10分),再会话(30分)。图片和你选择的主题相符。
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
