"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SpellingTestSummary, ExamPaperSummary, User } from "@/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function initials(name: string) {
  return name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

function relativeDate(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return `Today, ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return d.toLocaleDateString();
}

function scorePct(paper: ExamPaperSummary): number | null {
  if (paper.score === null || !paper.totalMarks || parseFloat(paper.totalMarks) === 0) return null;
  return Math.round((paper.score / parseFloat(paper.totalMarks)) * 100);
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function StudentDashboard({ userId, user }: { userId: string; user: User }) {
  const router = useRouter();

  const [tests, setTests] = useState<SpellingTestSummary[]>([]);
  const [examPapers, setExamPapers] = useState<ExamPaperSummary[]>([]);
  const [quizBadge, setQuizBadge] = useState<{ badge: string; image: string; count: number; streak: number } | null>(null);
  const [aiTip, setAiTip] = useState<string | null>(null);
  const [showQuizSetup, setShowQuizSetup] = useState(false);
  const [quizSubject, setQuizSubject] = useState<"math" | "science">("math");
  const [quizType, setQuizType] = useState<"mcq" | "mcq-oeq">("mcq");
  const [creatingQuiz, setCreatingQuiz] = useState(false);
  const [badgeToast, setBadgeToast] = useState(false);
  const [connectCode, setConnectCode] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState("");
  const [connectSuccess, setConnectSuccess] = useState("");
  const [showConnect, setShowConnect] = useState(false);
  const [activeNav, setActiveNav] = useState<"home" | "scan" | "quiz">("home");

  const fetchData = useRef<() => void>(undefined);
  fetchData.current = () => {
    fetch(`/api/tests?userId=${userId}`).then(r => r.json()).then(d => setTests(d.tests ?? [])).catch(() => {});
    fetch(`/api/exam?userId=${userId}`).then(r => r.json()).then(d => setExamPapers(d.papers ?? [])).catch(() => {});
  };

  useEffect(() => {
    fetchData.current?.();
    function onVisible() { if (document.visibilityState === "visible") fetchData.current?.(); }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [userId]);

  useEffect(() => {
    fetch(`/api/user/${userId}/quiz-badge`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.badge) setQuizBadge({ badge: d.badge, image: d.badgeImage, count: d.completedQuizzes, streak: d.streak ?? 0 }); })
      .catch(() => {});
  }, [userId]);

  // Generate a simple AI tip from available data
  useEffect(() => {
    if (tests.length === 0 && examPapers.length === 0) return;
    const name = user.name.split(" ")[0];
    if (tests.length > 0) {
      setAiTip(`${name}, you've completed ${tests.length} spelling test${tests.length !== 1 ? "s" : ""}. Keep scanning to track your progress!`);
    } else {
      setAiTip(`${name}, start by scanning your spelling list — AI will correct it in seconds!`);
    }
  }, [tests, examPapers, user.name]);

  async function handleConnect() {
    if (connectCode.length < 6) return;
    setConnecting(true); setConnectError(""); setConnectSuccess("");
    try {
      const res = await fetch("/api/link-student", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ studentId: userId, code: connectCode }),
      });
      const data = await res.json();
      if (!res.ok) { setConnectError(data.error || "Invalid code"); return; }
      setConnectSuccess("Linked successfully!"); setShowConnect(false);
    } catch { setConnectError("Something went wrong"); }
    finally { setConnecting(false); }
  }

  async function startQuiz() {
    setCreatingQuiz(true);
    try {
      const res = await fetch("/api/daily-quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, quizType, subject: quizSubject }),
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error || "Failed to create quiz"); return; }
      router.push(`/quiz/${data.id}?userId=${userId}`);
    } catch { alert("Something went wrong"); }
    finally { setCreatingQuiz(false); }
  }

  // Derived
  const studentPapers = examPapers;
  const todoPapers = studentPapers.filter(p => !p.completedAt && p.markingStatus !== "released");
  const completedPapers = studentPapers.filter(p => p.completedAt || p.markingStatus === "released");
  const recentTests = tests.slice(0, 6);

  const hasParent = (user.linkedParents?.length ?? 0) > 0;

  return (
    <div className="bg-[#f8f9ff] font-body text-[#0b1c30] antialiased min-h-screen">

      {/* ════════════════════════════════════════════════
          DESKTOP LAYOUT (lg+)
      ════════════════════════════════════════════════ */}
      <div className="hidden lg:flex min-h-screen">

        {/* ── Sidebar ──────────────────────────────────────────────────────── */}
        <aside className="fixed left-0 top-0 h-full w-64 bg-[#eff4ff] flex flex-col z-40 border-r border-[#003366]/10">
          {/* Logo */}
          <div className="px-6 pt-6 pb-4 flex items-center gap-2">
            <img src="/logo.png" alt="Owl" className="w-8 h-8 object-contain" />
            <img src="/markforyou2.png" alt="Markforyou" className="h-5 object-contain" />
          </div>

          {/* Streak + Badge pills */}
          <div className="px-4 flex flex-col gap-2 mb-4">
            {quizBadge && quizBadge.streak > 0 && (
              <div className="flex items-center gap-2 bg-amber-50 border border-amber-100 px-3 py-2 rounded-xl">
                <span className="material-symbols-outlined text-amber-500 text-base" style={{ fontVariationSettings: "'FILL' 1" }}>local_fire_department</span>
                <span className="text-xs font-bold text-amber-800">{quizBadge.streak}-Day Streak</span>
              </div>
            )}
            {quizBadge && (
              <div className="flex items-center gap-2 bg-yellow-400/10 border border-yellow-300/30 px-3 py-2 rounded-xl">
                <img src={quizBadge.image} alt={quizBadge.badge} className="w-4 h-4 object-contain" />
                <span className="text-xs font-bold text-yellow-700">{quizBadge.badge}</span>
              </div>
            )}
          </div>

          {/* Nav links */}
          <nav className="flex-1 px-3 space-y-1">
            <button onClick={() => setActiveNav("home")}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-sm font-semibold ${activeNav === "home" ? "bg-[#003366] text-white shadow-sm" : "text-[#003366] hover:bg-[#003366]/10"}`}>
              <span className="material-symbols-outlined text-xl" style={{ fontVariationSettings: activeNav === "home" ? "'FILL' 1" : "'FILL' 0" }}>home</span>
              Home
            </button>
            <button onClick={() => { setActiveNav("scan"); router.push(`/scan?userId=${userId}`); }}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-sm font-semibold ${activeNav === "scan" ? "bg-[#003366] text-white shadow-sm" : "text-[#003366] hover:bg-[#003366]/10"}`}>
              <span className="material-symbols-outlined text-xl" style={{ fontVariationSettings: activeNav === "scan" ? "'FILL' 1" : "'FILL' 0" }}>document_scanner</span>
              听写 Spelling
            </button>
            <button onClick={() => { setActiveNav("quiz"); setShowQuizSetup(true); }}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-sm font-semibold ${activeNav === "quiz" ? "bg-[#003366] text-white shadow-sm" : "text-[#003366] hover:bg-[#003366]/10"}`}>
              <span className="material-symbols-outlined text-xl" style={{ fontVariationSettings: activeNav === "quiz" ? "'FILL' 1" : "'FILL' 0" }}>history_edu</span>
              Daily Quiz
            </button>
          </nav>

          {/* Footer CTA */}
          <div className="p-4">
            <button onClick={() => setShowQuizSetup(true)}
              className="w-full py-3 rounded-xl bg-[#003366] text-white text-sm font-bold flex items-center justify-center gap-2 hover:bg-[#003366]/90 transition-colors shadow-sm">
              <span className="material-symbols-outlined text-base">play_circle</span>
              Start Learning
            </button>
            {!hasParent && (
              <button onClick={() => setShowConnect(!showConnect)}
                className="w-full mt-2 py-2.5 rounded-xl border-2 border-[#003366]/20 text-[#003366] text-xs font-bold hover:bg-[#003366]/5 transition-colors">
                Connect to Parent
              </button>
            )}
          </div>
        </aside>

        {/* ── Main Content ─────────────────────────────────────────────────── */}
        <main className="ml-64 flex-1 px-8 py-6 max-w-screen-xl">

          {/* Top Header */}
          <header className="flex items-center justify-between mb-6">
            <div>
              <h2 className="font-headline font-extrabold text-2xl text-[#003366] leading-tight">
                Good morning, {user.name.split(" ")[0]}!
              </h2>
              <p className="text-sm text-slate-500 font-medium">
                {user.level ? `Primary ${user.level} Student` : "Student"} · Let&apos;s improve your score today.
              </p>
            </div>
            <div className="flex items-center gap-4">
              <button onClick={() => router.push("/")} className="text-slate-400 hover:text-slate-600 transition-colors">
                <span className="material-symbols-outlined text-xl">logout</span>
              </button>
              <div className="w-11 h-11 rounded-2xl bg-[#d3e4fe] border-2 border-white shadow-md flex items-center justify-center cursor-default">
                <span className="font-headline font-extrabold text-[#003366] text-base">{initials(user.name)}</span>
              </div>
            </div>
          </header>

          {/* Connect to parent panel */}
          {showConnect && (
            <div className="mb-6 bg-white rounded-2xl border border-slate-100 p-4 shadow-sm max-w-md">
              <p className="text-xs text-slate-400 mb-2">Enter the code from your parent</p>
              <div className="flex gap-2">
                <input type="text" value={connectCode}
                  onChange={e => { setConnectCode(e.target.value.toUpperCase()); setConnectError(""); }}
                  placeholder="Enter code" maxLength={6}
                  className="flex-1 px-4 py-2.5 rounded-xl border-2 border-slate-200 focus:border-[#003366] focus:outline-none text-center font-mono text-lg tracking-widest uppercase" />
                <button onClick={handleConnect} disabled={connecting || connectCode.length < 6}
                  className="px-5 py-2.5 rounded-xl bg-[#003366] text-white font-semibold disabled:opacity-50">
                  {connecting ? "..." : "Link"}
                </button>
              </div>
              {connectError && <p className="text-xs text-red-500 mt-2">{connectError}</p>}
              {connectSuccess && <p className="text-xs text-green-600 mt-2">{connectSuccess}</p>}
            </div>
          )}

          {/* Bento Grid */}
          <div className="grid grid-cols-12 gap-6">

            {/* Left column (8 cols) */}
            <div className="col-span-8 space-y-6">

              {/* Hero action cards */}
              <div className="grid grid-cols-2 gap-4">
                {/* Daily Quiz */}
                <button onClick={() => setShowQuizSetup(true)}
                  className="relative overflow-hidden bg-gradient-to-br from-[#006c49] to-[#004d35] p-6 rounded-2xl text-left shadow-md hover:shadow-lg transition-all hover:scale-[1.02] active:scale-[0.99]">
                  <div className="flex items-start justify-between mb-4">
                    <div className="bg-white/20 p-2.5 rounded-xl">
                      <span className="material-symbols-outlined text-white text-2xl" style={{ fontVariationSettings: "'FILL' 1" }}>history_edu</span>
                    </div>
                    <span className="bg-white/20 text-white text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider">Recommended</span>
                  </div>
                  <h3 className="text-white font-headline font-extrabold text-xl mb-1">Daily 20min Quiz</h3>
                  <p className="text-white/70 text-sm">Master exam topics daily</p>
                  <div className="mt-4 flex items-center gap-2">
                    <div className="flex-1 bg-white/20 rounded-full h-1.5">
                      <div className="bg-white rounded-full h-1.5 transition-all"
                        style={{ width: studentPapers.length > 0 ? `${Math.round(completedPapers.length / studentPapers.length * 100)}%` : "30%" }} />
                    </div>
                    <span className="text-white/70 text-xs font-medium">
                      {studentPapers.length > 0 ? `${Math.round(completedPapers.length / studentPapers.length * 100)}%` : "Start"}
                    </span>
                  </div>
                </button>

                {/* Scan Spelling */}
                <button onClick={() => router.push(`/scan?userId=${userId}`)}
                  className="relative overflow-hidden bg-gradient-to-br from-[#003366] to-[#001f40] p-6 rounded-2xl text-left shadow-md hover:shadow-lg transition-all hover:scale-[1.02] active:scale-[0.99]">
                  <div className="flex items-start justify-between mb-4">
                    <div className="bg-white/20 p-2.5 rounded-xl">
                      <span className="material-symbols-outlined text-white text-2xl" style={{ fontVariationSettings: "'FILL' 1" }}>document_scanner</span>
                    </div>
                    <span className="material-symbols-outlined text-white/40 text-xl">arrow_forward</span>
                  </div>
                  <h3 className="text-white font-headline font-extrabold text-xl mb-1">Scan 听写 Spelling</h3>
                  <p className="text-white/70 text-sm">AI-powered correction in seconds</p>
                </button>
              </div>

              {/* Recent Spelling */}
              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
                <h4 className="font-headline font-bold text-base text-[#003366] mb-4">Recent Spelling / 听写</h4>
                {recentTests.length === 0 ? (
                  <div className="text-center py-6">
                    <span className="material-symbols-outlined text-3xl text-slate-300 block mb-2">spellcheck</span>
                    <p className="text-sm text-slate-400">No spelling tests yet</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {recentTests.map(test => {
                      return (
                        <div key={test.id} onClick={() => router.push(`/spelling/${test.id}?userId=${userId}`)}
                          className="flex items-center gap-4 p-3 rounded-xl hover:bg-slate-50 transition-colors cursor-pointer group">
                          <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 bg-[#003366]/5">
                            <span className="material-symbols-outlined text-base text-[#003366]">spellcheck</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-semibold text-sm text-[#003366] truncate">{test.title || "Spelling Test"}</p>
                            <p className="text-xs text-slate-400">{relativeDate(test.createdAt)}</p>
                          </div>
                          <div className="shrink-0">
                            <span className="text-xs text-slate-400">{test.wordCount} words</span>
                          </div>
                          {false && (
                            <div className="flex items-center gap-3 shrink-0">
                              <div className="w-20 bg-slate-100 rounded-full h-1.5">
                                <div className="rounded-full h-1.5 bg-[#003366]" style={{ width: "0%" }} />
                              </div>
                              <span className="text-xs font-bold w-8 text-right text-slate-400">-</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* AI Study Tip */}
              {aiTip && (
                <div className="bg-amber-50 border border-amber-100 rounded-2xl p-4 flex items-start gap-3">
                  <div className="bg-amber-100 p-2 rounded-xl shrink-0">
                    <span className="material-symbols-outlined text-amber-700 text-base" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
                  </div>
                  <div>
                    <p className="text-xs font-bold text-amber-800 mb-0.5">AI Study Tip</p>
                    <p className="text-xs text-[#003366] font-medium leading-relaxed">{aiTip}</p>
                  </div>
                </div>
              )}
            </div>

            {/* Right column (4 cols) — Exam Papers */}
            <div className="col-span-4">
              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 sticky top-6">
                <h4 className="font-headline font-bold text-base text-[#003366] mb-4">Exam Papers</h4>

                {todoPapers.length === 0 && completedPapers.length === 0 ? (
                  <div className="text-center py-6">
                    <span className="material-symbols-outlined text-3xl text-slate-300 block mb-2">description</span>
                    <p className="text-sm text-slate-400">No papers yet</p>
                    <p className="text-xs text-slate-300 mt-1">Your parent will assign papers here</p>
                  </div>
                ) : (
                  <div className="space-y-5">
                    {todoPapers.length > 0 && (
                      <div>
                        <div className="flex items-center gap-2 mb-3">
                          <div className="w-1.5 h-1.5 rounded-full bg-[#ba1a1a]" />
                          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">To Do</span>
                        </div>
                        <div className="space-y-2">
                          {todoPapers.map(paper => (
                            <div key={paper.id}
                              onClick={() => {
                                const isQuizOrFocused = paper.paperType === "quiz" || paper.paperType === "focused";
                                router.push(isQuizOrFocused ? `/quiz/${paper.id}?userId=${userId}` : `/exam/${paper.id}?userId=${userId}`);
                              }}
                              className="flex items-center gap-3 p-3 rounded-xl bg-slate-50 cursor-pointer hover:bg-[#003366]/5 transition-colors">
                              <div className="bg-white p-1.5 rounded-lg shadow-sm shrink-0">
                                <span className="material-symbols-outlined text-[#003366] text-base">
                                  {paper.paperType === "quiz" ? "history_edu" : paper.paperType === "focused" ? "psychology" : "description"}
                                </span>
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="font-semibold text-xs text-[#003366] truncate">{paper.title}</p>
                                <p className="text-[10px] text-slate-400">
                                  {paper.paperType === "quiz" ? "Daily Quiz" : paper.paperType === "focused" ? "Focused Practice" : "Exam Paper"}
                                </p>
                              </div>
                              <span className="material-symbols-outlined text-slate-300 text-base">chevron_right</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {completedPapers.length > 0 && (
                      <div>
                        <div className="flex items-center gap-2 mb-3">
                          <div className="w-1.5 h-1.5 rounded-full bg-[#006c49]" />
                          <span className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Completed</span>
                        </div>
                        <div className="space-y-2">
                          {completedPapers.slice(0, 5).map(paper => {
                            const pct = scorePct(paper);
                            return (
                              <div key={paper.id}
                                onClick={() => {
                                  const isQuizOrFocused = paper.paperType === "quiz" || paper.paperType === "focused";
                                  router.push(isQuizOrFocused ? `/exam/${paper.id}/review?userId=${userId}` : `/exam/${paper.id}/overview?userId=${userId}`);
                                }}
                                className="flex items-center gap-3 p-3 rounded-xl bg-[#006c49]/5 cursor-pointer hover:bg-[#006c49]/10 transition-colors">
                                <div className="bg-white p-1.5 rounded-lg shadow-sm shrink-0">
                                  <span className="material-symbols-outlined text-[#006c49] text-base" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="font-semibold text-xs text-[#003366] truncate">{paper.title}</p>
                                  {pct !== null && (
                                    <p className={`text-[10px] font-bold ${pct >= 75 ? "text-[#006c49]" : pct >= 50 ? "text-amber-600" : "text-[#ba1a1a]"}`}>{pct}%</p>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>

      {/* ════════════════════════════════════════════════
          MOBILE LAYOUT (< lg)
      ════════════════════════════════════════════════ */}
      <div className="lg:hidden pb-32">

      {/* ── Top Nav ─────────────────────────────────────────────────────────── */}
      <nav className="fixed top-0 w-full z-50 bg-white/90 backdrop-blur-md shadow-sm border-b border-slate-100">
        <div className="flex items-center justify-between px-6 w-full py-3 max-w-lg mx-auto">
          <div className="flex items-center gap-2">
            <img src="/logo.png" alt="Owl" className="w-7 h-7 object-contain" />
            <img src="/markforyou2.png" alt="Markforyou" className="h-5 object-contain" />
          </div>
          <div className="flex items-center gap-2">
            {!hasParent && (
              <button
                onClick={() => setShowConnect(!showConnect)}
                className="text-xs font-bold text-[#003366] bg-[#eff4ff] px-3 py-1.5 rounded-full"
              >
                Connect to Parent
              </button>
            )}
            <button onClick={() => router.push("/")} className="text-slate-400 p-1 text-xs">
              <span className="material-symbols-outlined text-xl">logout</span>
            </button>
          </div>
        </div>
      </nav>

      {/* ── Main Content ─────────────────────────────────────────────────────── */}
      <main className="mt-20 px-6 max-w-lg mx-auto">

        {/* Connect to parent panel */}
        {showConnect && (
          <div className="mb-4 bg-white rounded-2xl border border-slate-100 p-4 shadow-sm">
            <p className="text-xs text-slate-400 mb-2">Enter the code from your parent</p>
            <div className="flex gap-2">
              <input
                type="text" value={connectCode}
                onChange={e => { setConnectCode(e.target.value.toUpperCase()); setConnectError(""); }}
                placeholder="Enter code" maxLength={6}
                className="flex-1 px-4 py-2.5 rounded-xl border-2 border-slate-200 focus:border-[#003366] focus:outline-none text-center font-mono text-lg tracking-widest uppercase"
              />
              <button
                onClick={handleConnect} disabled={connecting || connectCode.length < 6}
                className="px-5 py-2.5 rounded-xl bg-[#003366] text-white font-semibold disabled:opacity-50"
              >
                {connecting ? "..." : "Link"}
              </button>
            </div>
            {connectError && <p className="text-xs text-red-500 mt-2">{connectError}</p>}
            {connectSuccess && <p className="text-xs text-green-600 mt-2">{connectSuccess}</p>}
          </div>
        )}

        {/* ── Student Profile Header ──────────────────────────────────────── */}
        <header className="mb-8 pt-4">
          <div className="flex items-center gap-4 mb-3">
            <div className="relative">
              <div className="w-16 h-16 rounded-2xl bg-[#d3e4fe] border-2 border-white shadow-md flex items-center justify-center">
                <span className="font-headline font-extrabold text-[#003366] text-xl">{initials(user.name)}</span>
              </div>
              {hasParent && (
                <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-[#006c49] rounded-full border-2 border-white flex items-center justify-center">
                  <span className="material-symbols-outlined text-white text-[12px]" style={{ fontVariationSettings: "'FILL' 1" }}>check</span>
                </div>
              )}
            </div>
            <div>
              <h1 className="text-2xl font-headline font-extrabold text-[#003366] tracking-tight leading-tight">{user.name}</h1>
              <p className="text-sm text-slate-500 font-medium uppercase tracking-widest">
                {user.level ? `Primary ${user.level} Student` : "Student"}
              </p>
            </div>
          </div>

          {/* Badges */}
          <div className="flex items-center gap-3 mb-6 flex-wrap">
            {quizBadge && quizBadge.streak > 0 && (
              <button
                onClick={() => { setBadgeToast(true); setTimeout(() => setBadgeToast(false), 2500); }}
                className="flex items-center gap-1.5 bg-amber-50 text-amber-800 border border-amber-100 px-3 py-1.5 rounded-full text-xs font-bold shadow-sm"
              >
                <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>local_fire_department</span>
                {quizBadge.streak}-Day Streak
              </button>
            )}
            {quizBadge && (
              <button
                onClick={() => { setBadgeToast(true); setTimeout(() => setBadgeToast(false), 2500); }}
                className="flex items-center gap-1.5 bg-yellow-400 text-white px-3 py-1.5 rounded-full text-xs font-bold shadow-sm"
              >
                <img src={quizBadge.image} alt={quizBadge.badge} className="w-4 h-4 object-contain" />
                {quizBadge.badge}
              </button>
            )}
            {badgeToast && quizBadge && (
              <span className="text-xs font-medium text-[#003366] animate-fade-in-up">
                {quizBadge.badge}: completed {quizBadge.count} quizzes
              </span>
            )}
          </div>

          <h2 className="text-3xl font-headline font-extrabold text-[#003366] tracking-tight leading-tight">Ready for today&apos;s goals?</h2>
          <p className="text-[#43474f] mt-2 text-sm">Let&apos;s improve your score together.</p>
        </header>

        {/* ── Primary Action Buttons ──────────────────────────────────────── */}
        <section className="space-y-4 mb-10">
          {/* Daily Quiz */}
          <button
            onClick={() => setShowQuizSetup(true)}
            className="w-full relative overflow-hidden bg-[#006c49]/5 border border-[#006c49]/10 p-6 rounded-2xl text-left shadow-sm active:scale-[0.98] transition-all"
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[#006c49] bg-white p-2 rounded-xl shadow-sm">
                    <span className="material-symbols-outlined text-2xl" style={{ fontVariationSettings: "'FILL' 1" }}>history_edu</span>
                  </span>
                  <span className="bg-[#006c49] text-white text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider">Recommended</span>
                </div>
                <h3 className="text-[#003366] font-headline font-bold text-xl">Daily 20min Quiz</h3>
                <p className="text-[#43474f] text-sm mt-1">Master exam topics daily</p>
              </div>
              <div className="w-14 h-14 relative shrink-0">
                <svg className="w-full h-full -rotate-90" viewBox="0 0 56 56">
                  <circle className="text-[#006c49]/10" cx="28" cy="28" r="24" fill="transparent" stroke="currentColor" strokeWidth="4" />
                  <circle className="text-[#006c49]" cx="28" cy="28" r="24" fill="transparent" stroke="currentColor" strokeWidth="4"
                    strokeDasharray="150.7"
                    strokeDashoffset={completedPapers.length > 0 && studentPapers.length > 0 ? 150.7 * (1 - completedPapers.length / Math.max(studentPapers.length, 1)) : 150.7 * 0.7}
                  />
                </svg>
                <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-[#006c49]">
                  {completedPapers.length > 0 && studentPapers.length > 0
                    ? `${Math.round(completedPapers.length / studentPapers.length * 100)}%`
                    : "Go!"}
                </span>
              </div>
            </div>
          </button>

          {/* Scan Spelling */}
          <button
            onClick={() => router.push(`/scan?userId=${userId}`)}
            className="w-full relative overflow-hidden bg-[#003366]/5 border border-[#003366]/10 p-6 rounded-2xl text-left shadow-sm active:scale-[0.98] transition-all group"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-[#003366] bg-white p-2 rounded-xl shadow-sm">
                <span className="material-symbols-outlined text-2xl" style={{ fontVariationSettings: "'FILL' 1" }}>document_scanner</span>
              </span>
              <span className="text-[#003366]/40 group-hover:translate-x-1 transition-transform">
                <span className="material-symbols-outlined">arrow_forward</span>
              </span>
            </div>
            <h3 className="text-[#003366] font-headline font-bold text-xl">Scan Spelling / 听写</h3>
            <p className="text-[#43474f] text-sm mt-1">AI-powered correction in seconds</p>
          </button>
        </section>

        {/* ── Recent Spelling ─────────────────────────────────────────────── */}
        <section className="mb-10">
          <div className="flex items-center justify-between mb-6">
            <h4 className="font-headline font-bold text-lg text-[#003366]">Recent Spelling / 听写</h4>
          </div>
          {recentTests.length === 0 ? (
            <div className="text-center py-8 rounded-2xl bg-white border border-slate-100 shadow-sm">
              <span className="material-symbols-outlined text-3xl text-slate-300 mb-2 block">spellcheck</span>
              <p className="text-sm text-slate-400">No spelling tests yet</p>
              <p className="text-xs text-slate-300 mt-1">Scan your spelling list to get started</p>
            </div>
          ) : (
            <>
              <div className="flex gap-4 overflow-x-auto pb-4 -mx-6 px-6 no-scrollbar" style={{ scrollbarWidth: "none" }}>
                {recentTests.map(test => (
                  <div
                    key={test.id}
                    onClick={() => router.push(`/spelling/${test.id}?userId=${userId}`)}
                    className="min-w-[200px] bg-white p-5 rounded-2xl shadow-sm border border-slate-100 cursor-pointer hover:border-[#003366]/20 transition-colors"
                  >
                    <div className="flex justify-between items-start mb-4">
                      <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-[#003366]/5 text-[#003366]">
                        <span className="material-symbols-outlined">spellcheck</span>
                      </div>
                      <span className="text-xs font-bold px-2 py-0.5 rounded-md text-[#003366] bg-[#003366]/10">
                        {test.wordCount} words
                      </span>
                    </div>
                    <h5 className="font-bold text-sm text-[#0b1c30] mb-1 truncate">{test.title || "Spelling Test"}</h5>
                    <p className="text-[10px] text-[#43474f] mb-3">{relativeDate(test.createdAt)}</p>
                    <div className="flex items-center gap-2">
                      <div className="w-5 h-5 rounded-full bg-[#006c49] text-[8px] flex items-center justify-center text-white font-bold">AI</div>
                      <span className="text-[10px] font-medium text-[#43474f]">View results</span>
                    </div>
                  </div>
                ))}
              </div>
              {tests.length > 6 && (
                <div className="mt-2 text-right">
                  <Link href={`/home/${userId}?t=${Date.now()}`} className="text-[#003366] font-bold text-xs inline-flex items-center gap-1">
                    View All <span className="material-symbols-outlined text-xs">arrow_forward</span>
                  </Link>
                </div>
              )}
            </>
          )}
        </section>

        {/* ── Exam Papers ─────────────────────────────────────────────────── */}
        <section className="mb-10">
          <h4 className="font-headline font-bold text-lg text-[#003366] mb-6">Exam Papers</h4>
          <div className="space-y-8">
            {/* To Do */}
            {todoPapers.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#ba1a1a]" />
                  <h5 className="text-xs font-bold text-[#43474f] tracking-wider uppercase">To Do</h5>
                </div>
                <div className="space-y-3">
                  {todoPapers.map(paper => (
                    <div
                      key={paper.id}
                      onClick={() => {
                        const isQuizOrFocused = paper.paperType === "quiz" || paper.paperType === "focused";
                        router.push(isQuizOrFocused ? `/quiz/${paper.id}?userId=${userId}` : `/exam/${paper.id}?userId=${userId}`);
                      }}
                      className="flex items-center justify-between p-4 rounded-2xl bg-white border border-slate-100 shadow-sm cursor-pointer hover:border-[#003366]/20 transition-colors"
                    >
                      <div className="flex items-center gap-4">
                        <div className="bg-[#003366]/5 p-2.5 rounded-xl">
                          <span className="material-symbols-outlined text-[#003366]">
                            {paper.paperType === "quiz" ? "history_edu" : paper.paperType === "focused" ? "psychology" : "description"}
                          </span>
                        </div>
                        <div>
                          <p className="font-bold text-sm text-[#003366]">{paper.title}</p>
                          <p className="text-[10px] text-[#43474f]">
                            {paper.paperType === "quiz" ? "Daily Quiz" : paper.paperType === "focused" ? "Focused Practice" : "Exam Paper"}
                          </p>
                        </div>
                      </div>
                      <span className="material-symbols-outlined text-[#43474f]/40">chevron_right</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Completed */}
            {completedPapers.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-4">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#006c49]" />
                  <h5 className="text-xs font-bold text-[#43474f] tracking-wider uppercase">Completed</h5>
                </div>
                <div className="space-y-3">
                  {completedPapers.slice(0, 5).map(paper => {
                    const pct = scorePct(paper);
                    return (
                      <div
                        key={paper.id}
                        onClick={() => {
                          const isQuizOrFocused = paper.paperType === "quiz" || paper.paperType === "focused";
                          router.push(isQuizOrFocused ? `/exam/${paper.id}/review?userId=${userId}` : `/exam/${paper.id}/overview?userId=${userId}`);
                        }}
                        className="flex items-center justify-between p-4 rounded-2xl bg-[#006c49]/5 cursor-pointer hover:bg-[#006c49]/10 transition-colors"
                      >
                        <div className="flex items-center gap-4">
                          <div className="bg-white p-2.5 rounded-xl shadow-sm">
                            <span className="material-symbols-outlined text-[#006c49]" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                          </div>
                          <div>
                            <p className="font-bold text-sm text-[#003366]">{paper.title}</p>
                            <p className="text-[10px] text-[#43474f]">
                              {pct !== null ? `Score: ${pct}% · ` : ""}{paper.completedAt ? relativeDate(paper.completedAt) : ""}
                            </p>
                          </div>
                        </div>
                        {pct !== null && (
                          <span className={`text-xs font-extrabold shrink-0 ${pct >= 75 ? "text-[#006c49]" : pct >= 50 ? "text-amber-600" : "text-[#ba1a1a]"}`}>
                            {pct}%
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {todoPapers.length === 0 && completedPapers.length === 0 && (
              <div className="text-center py-8 rounded-2xl bg-white border border-slate-100 shadow-sm">
                <span className="material-symbols-outlined text-3xl text-slate-300 mb-2 block">description</span>
                <p className="text-sm text-slate-400">No exam papers yet</p>
                <p className="text-xs text-slate-300 mt-1">Your parent will assign papers here</p>
              </div>
            )}
          </div>
        </section>

        {/* ── AI Study Tip ─────────────────────────────────────────────────── */}
        {aiTip && (
          <div className="bg-amber-50/70 p-4 rounded-2xl border border-amber-100 shadow-sm mb-6 backdrop-blur-sm">
            <div className="flex items-center gap-2 mb-2">
              <div className="bg-amber-100 p-1.5 rounded-lg inline-flex">
                <span className="material-symbols-outlined text-amber-700 text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
              </div>
              <span className="text-xs font-bold text-amber-800">AI Study Tip</span>
            </div>
            <p className="text-[11px] text-[#003366] font-medium leading-relaxed">{aiTip}</p>
          </div>
        )}
      </main>

      </div>{/* end lg:hidden mobile wrapper */}

      {/* ── Quiz Setup Modal ─────────────────────────────────────────────── */}
      {showQuizSetup && (
        <div className="fixed inset-0 bg-black/40 flex items-end justify-center z-50 p-4" onClick={() => setShowQuizSetup(false)}>
          <div className="bg-white rounded-t-3xl w-full max-w-lg p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="font-headline font-extrabold text-lg text-[#003366] mb-4">Daily 20min Quiz</h3>
            <p className="text-xs font-extrabold text-[#43474f] uppercase tracking-wider mb-2">Subject</p>
            <div className="flex gap-2 mb-4">
              {(["math", "science"] as const).map(s => (
                <button key={s} onClick={() => setQuizSubject(s)}
                  className={`flex-1 py-2.5 rounded-xl border-2 text-sm font-medium transition-all ${quizSubject === s ? "border-[#006c49] bg-[#006c49]/5 text-[#006c49]" : "border-slate-200 text-slate-600"}`}>
                  {s === "math" ? "Mathematics" : "Science"}
                </button>
              ))}
            </div>
            <p className="text-xs font-extrabold text-[#43474f] uppercase tracking-wider mb-2">Type</p>
            <div className="space-y-2 mb-6">
              {([["mcq", "MCQ Only", "20 multiple choice questions"], ["mcq-oeq", "MCQ + Written", "10 MCQ + 5 open-ended questions"]] as const).map(([val, label, desc]) => (
                <button key={val} onClick={() => setQuizType(val)}
                  className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all text-left ${quizType === val ? "border-[#006c49] bg-[#006c49]/5" : "border-slate-100"}`}>
                  <span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${quizType === val ? "border-[#006c49]" : "border-slate-300"}`}>
                    {quizType === val && <span className="w-2.5 h-2.5 rounded-full bg-[#006c49]" />}
                  </span>
                  <div>
                    <p className={`text-sm font-medium ${quizType === val ? "text-[#006c49]" : "text-slate-700"}`}>{label}</p>
                    <p className="text-xs text-slate-400">{desc}</p>
                  </div>
                </button>
              ))}
            </div>
            <div className="flex gap-3">
              <button onClick={() => setShowQuizSetup(false)} className="flex-1 py-3 rounded-xl border-2 border-slate-200 text-slate-600 font-medium">Cancel</button>
              <button onClick={startQuiz} disabled={creatingQuiz}
                className="flex-1 py-3 rounded-xl bg-[#006c49] text-white font-bold disabled:opacity-50">
                {creatingQuiz ? "Creating..." : "Start Quiz"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Bottom Nav (mobile only) ──────────────────────────────────────── */}
      <nav className="lg:hidden fixed bottom-0 left-0 w-full z-50 flex justify-around items-center px-4 pb-6 pt-3 bg-white/95 backdrop-blur-xl rounded-t-3xl shadow-[0_-10px_40px_rgba(0,51,102,0.08)] border-t border-slate-100">
        <button
          onClick={() => setActiveNav("home")}
          className={`flex flex-col items-center gap-0.5 transition-all ${activeNav === "home" ? "text-[#006c49]" : "text-slate-400"}`}
        >
          <span className="material-symbols-outlined text-2xl" style={{ fontVariationSettings: activeNav === "home" ? "'FILL' 1" : "'FILL' 0" }}>home</span>
          <span className="text-[10px] font-bold">Home</span>
        </button>
        <button
          onClick={() => { setActiveNav("scan"); router.push(`/scan?userId=${userId}`); }}
          className={`flex flex-col items-center gap-0.5 transition-all ${activeNav === "scan" ? "text-[#006c49]" : "text-slate-400"}`}
        >
          <span className="material-symbols-outlined text-2xl" style={{ fontVariationSettings: activeNav === "scan" ? "'FILL' 1" : "'FILL' 0" }}>document_scanner</span>
          <span className="text-[10px] font-medium">听写</span>
        </button>
        <button
          onClick={() => { setActiveNav("quiz"); setShowQuizSetup(true); }}
          className={`flex flex-col items-center gap-0.5 transition-all ${activeNav === "quiz" ? "text-[#006c49]" : "text-slate-400"}`}
        >
          <span className="material-symbols-outlined text-2xl" style={{ fontVariationSettings: activeNav === "quiz" ? "'FILL' 1" : "'FILL' 0" }}>history_edu</span>
          <span className="text-[10px] font-medium">Quiz</span>
        </button>
      </nav>
    </div>
  );
}
