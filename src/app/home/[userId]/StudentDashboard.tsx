"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SpellingTestSummary, ExamPaperSummary, User } from "@/types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface DiagramRow { label: string; units: number; value: string | null; }
interface DiagramStep { title: string | null; rows: DiagramRow[]; unitValue: string | null; }

// ─── Bar Model (Singapore model method) ───────────────────────────────────────

function splitLabel(label: string): [string, string | null] {
  if (label.length <= 11) return [label, null];
  const mid = Math.ceil(label.length / 2);
  const spaceIdx = label.lastIndexOf(" ", mid + 4);
  if (spaceIdx > 0) return [label.slice(0, spaceIdx), label.slice(spaceIdx + 1)];
  return [label.slice(0, 11), label.slice(11)];
}

function BarModel({ diagram }: { diagram: DiagramStep }) {
  const ROW_H = 44, ROW_GAP = 10, LABEL_W = 100, BAR_AREA_W = 190, VALUE_W = 62, PAD_X = 8, PAD_Y = 8;
  const TOTAL_W = PAD_X + LABEL_W + BAR_AREA_W + VALUE_W + PAD_X;
  const maxUnits = Math.max(...diagram.rows.map(r => r.units), 1);
  const unitW = BAR_AREA_W / maxUnits;
  const FOOTER_H = diagram.unitValue ? 26 : 0;
  const totalH = PAD_Y + diagram.rows.length * (ROW_H + ROW_GAP) - ROW_GAP + FOOTER_H + PAD_Y;
  const COLORS = [
    { fill: "#dbeafe", stroke: "#60a5fa", text: "#1d4ed8" },
    { fill: "#ede9fe", stroke: "#a78bfa", text: "#6d28d9" },
    { fill: "#d1fae5", stroke: "#34d399", text: "#065f46" },
    { fill: "#fef3c7", stroke: "#fbbf24", text: "#92400e" },
    { fill: "#fce7f3", stroke: "#f472b6", text: "#9d174d" },
  ];
  return (
    <svg viewBox={`0 0 ${TOTAL_W} ${totalH}`} width="100%" style={{ display: "block", maxWidth: TOTAL_W }}>
      {diagram.rows.map((row, i) => {
        const y = PAD_Y + i * (ROW_H + ROW_GAP);
        const barX = PAD_X + LABEL_W;
        const barW = row.units * unitW;
        const col = COLORS[i % COLORS.length];
        const [line1, line2] = splitLabel(row.label);
        const labelX = PAD_X + LABEL_W - 6;
        return (
          <g key={i}>
            {line2 ? (
              <text x={labelX} textAnchor="end" fontSize="11" fontFamily="system-ui,sans-serif" fontWeight="500" fill="#475569">
                <tspan x={labelX} y={y + ROW_H / 2 - 3}>{line1}</tspan>
                <tspan x={labelX} dy="14">{line2}</tspan>
              </text>
            ) : (
              <text x={labelX} y={y + ROW_H / 2 + 4} textAnchor="end" fontSize="12" fontFamily="system-ui,sans-serif" fontWeight="500" fill="#475569">{line1}</text>
            )}
            <rect x={barX} y={y} width={BAR_AREA_W} height={ROW_H} rx={4} fill="#f1f5f9" stroke="#e2e8f0" strokeWidth={1} />
            <rect x={barX} y={y} width={barW} height={ROW_H} rx={4} fill={col.fill} stroke={col.stroke} strokeWidth={1.5} />
            {Array.from({ length: row.units - 1 }, (_, j) => (
              <line key={j} x1={barX + (j + 1) * unitW} y1={y + 6} x2={barX + (j + 1) * unitW} y2={y + ROW_H - 6} stroke={col.stroke} strokeWidth={1} opacity={0.6} />
            ))}
            {row.value && <text x={barX + BAR_AREA_W + 6} y={y + ROW_H / 2 + 4} fontSize="13" fontFamily="system-ui,sans-serif" fontWeight="700" fill={col.text}>{row.value}</text>}
          </g>
        );
      })}
      {diagram.unitValue && (
        <text x={PAD_X + LABEL_W} y={PAD_Y + diagram.rows.length * (ROW_H + ROW_GAP) - ROW_GAP + 20} fontSize="11" fontFamily="system-ui,sans-serif" fill="#64748b">
          1 unit = {diagram.unitValue}
        </text>
      )}
    </svg>
  );
}

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

function greeting() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return "Good morning";
  if (h >= 12 && h < 17) return "Good afternoon";
  return "Good evening";
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
  const [activeNav, setActiveNav] = useState<"home" | "scan" | "quiz" | "solver">("home");
  const [showProfileMenu, setShowProfileMenu] = useState(false);

  // AI Solver
  const [showAiSolver, setShowAiSolver] = useState(false);
  const [solverStep, setSolverStep] = useState<"capture" | "solving" | "result">("capture");
  const [solverImageData, setSolverImageData] = useState<string | null>(null);
  const [solverContext, setSolverContext] = useState("");
  const [solverResult, setSolverResult] = useState<{ subject: string; topic: string | null; solution: string; diagrams: DiagramStep[] } | null>(null);
  const [solverError, setSolverError] = useState<string | null>(null);
  const solverFileInputRef = useRef<HTMLInputElement>(null);
  const solverCameraRef = useRef<HTMLInputElement>(null);

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

  function openSolver() {
    setShowAiSolver(true); setSolverStep("capture");
    setSolverImageData(null); setSolverContext(""); setSolverResult(null); setSolverError(null);
  }

  function compressSolverImage(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          const maxDim = 2048;
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            if (width > height) { height = (height / width) * maxDim; width = maxDim; }
            else { width = (width / height) * maxDim; height = maxDim; }
          }
          canvas.width = width; canvas.height = height;
          canvas.getContext("2d")!.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", 0.85));
        };
        img.onerror = reject;
        img.src = e.target?.result as string;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function handleSolverFile(file: File) {
    setSolverError(null);
    setSolverStep("solving");
    try {
      const dataUrl = await compressSolverImage(file);
      setSolverImageData(dataUrl);
      const res = await fetch("/api/solver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: dataUrl, hint: solverContext.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setSolverError(data.error || "Failed to solve"); setSolverStep("capture"); return; }
      setSolverResult({ subject: data.subject, topic: data.topic ?? null, solution: data.solution, diagrams: data.diagrams ?? [] });
      setSolverStep("result");
    } catch {
      setSolverError("Something went wrong. Please try again.");
      setSolverStep("capture");
    }
  }

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
            <button onClick={openSolver}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all text-sm font-semibold ${showAiSolver ? "bg-[#003366] text-white shadow-sm" : "text-[#003366] hover:bg-[#003366]/10"}`}>
              <span className="material-symbols-outlined text-xl" style={{ fontVariationSettings: showAiSolver ? "'FILL' 1" : "'FILL' 0" }}>psychology</span>
              AI Solver
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
                {greeting()}, {user.name.split(" ")[0]}!
              </h2>
              <p className="text-sm text-slate-500 font-medium mb-3">
                {user.level ? `Primary ${user.level} Student` : "Student"} · Let&apos;s improve your score today.
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                {quizBadge && quizBadge.streak > 0 && (
                  <span className="flex items-center gap-1.5 bg-amber-50 text-amber-800 border border-amber-100 px-3 py-1 rounded-full text-xs font-bold">
                    <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>local_fire_department</span>
                    {quizBadge.streak}-Day Streak
                  </span>
                )}
                {quizBadge && (
                  <span className="flex items-center gap-1.5 bg-yellow-400 text-white px-3 py-1 rounded-full text-xs font-bold">
                    <img src={quizBadge.image} alt={quizBadge.badge} className="w-3.5 h-3.5 object-contain" />
                    {quizBadge.badge}
                  </span>
                )}
              </div>
            </div>
            <div className="relative">
              <button
                onClick={() => setShowProfileMenu(v => !v)}
                className="w-11 h-11 rounded-2xl bg-[#d3e4fe] border-2 border-white shadow-md flex items-center justify-center hover:bg-[#c3d9fe] transition-colors"
              >
                <span className="font-headline font-extrabold text-[#003366] text-base">{initials(user.name)}</span>
              </button>
              {showProfileMenu && (
                <div className="absolute right-0 top-13 bg-white rounded-xl shadow-lg border border-slate-100 py-1 w-36 z-50">
                  <button
                    onClick={() => { setShowProfileMenu(false); router.push("/"); }}
                    className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-[#ba1a1a] hover:bg-slate-50 transition-colors"
                  >
                    <span className="material-symbols-outlined text-base">logout</span>
                    Sign out
                  </button>
                </div>
              )}
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

              {/* Exam Papers */}
              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6">
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

            {/* Right column (4 cols) — Recent Spelling */}
            <div className="col-span-4">
              <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 sticky top-6">
                <h4 className="font-headline font-bold text-base text-[#003366] mb-4">Recent Spelling / 听写</h4>
                {recentTests.length === 0 ? (
                  <div className="text-center py-6">
                    <span className="material-symbols-outlined text-3xl text-slate-300 block mb-2">spellcheck</span>
                    <p className="text-sm text-slate-400">No spelling tests yet</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {recentTests.map(test => (
                      <div key={test.id} onClick={() => router.push(`/test/${test.id}?userId=${userId}`)}
                        className="flex items-center gap-3 p-3 rounded-xl hover:bg-slate-50 transition-colors cursor-pointer">
                        <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 bg-[#003366]/5">
                          <span className="material-symbols-outlined text-base text-[#003366]">spellcheck</span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-sm text-[#003366] truncate">{test.title || "Spelling Test"}</p>
                          <p className="text-xs text-slate-400">{relativeDate(test.createdAt)}</p>
                        </div>
                        <span className="text-xs text-slate-400 shrink-0">{test.wordCount}w</span>
                      </div>
                    ))}
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
            <div className="relative">
              <button
                onClick={() => setShowProfileMenu(v => !v)}
                className="w-8 h-8 rounded-full bg-[#d3e4fe] flex items-center justify-center"
              >
                <span className="font-headline font-extrabold text-[#003366] text-xs">{initials(user.name)}</span>
              </button>
              {showProfileMenu && (
                <div className="absolute right-0 top-10 bg-white rounded-xl shadow-lg border border-slate-100 py-1 w-36 z-50">
                  <button
                    onClick={() => { setShowProfileMenu(false); router.push("/"); }}
                    className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-[#ba1a1a] hover:bg-slate-50 transition-colors"
                  >
                    <span className="material-symbols-outlined text-base">logout</span>
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </nav>

      {/* ── Mobile AI Solver View ───────────────────────────────────────────── */}
      {activeNav === "solver" && (
        <main className="mt-20 px-6 pb-10 max-w-lg mx-auto">
          {/* Hero */}
          {solverStep !== "result" && (
            <section className="mb-8 text-center">
              <div className="inline-flex items-center justify-center p-4 mb-4 rounded-3xl bg-[#d3e4fe] relative">
                <span className="material-symbols-outlined text-5xl text-[#003366]" style={{ fontVariationSettings: "'FILL' 1" }}>psychology</span>
                <span className="absolute -top-2 -right-2 bg-[#006c49] text-white text-[10px] font-bold px-2 py-0.5 rounded-full">AI</span>
              </div>
              <h1 className="text-2xl font-headline font-extrabold text-[#001e40] mb-2 leading-tight">Capture &amp; Solve</h1>
              <p className="text-[#43474f] text-sm px-4 leading-relaxed">Take a photo or upload an image of a question and let AI solve it.</p>
            </section>
          )}

          {solverStep === "capture" && (
            <div className="space-y-5">
              {solverError && <div className="bg-red-50 text-red-600 text-sm px-4 py-3 rounded-xl border border-red-100">{solverError}</div>}
              <div className="grid grid-cols-2 gap-4">
                <button onClick={() => solverCameraRef.current?.click()}
                  className="flex flex-col items-center justify-center bg-[#001e40] p-8 rounded-[2rem] text-white shadow-xl hover:scale-[1.02] active:scale-95 transition-all relative overflow-hidden">
                  <div className="absolute inset-0 bg-gradient-to-br from-[#001e40] to-[#003366] opacity-50" />
                  <span className="material-symbols-outlined text-4xl mb-3 relative z-10" style={{ fontVariationSettings: "'FILL' 1" }}>photo_camera</span>
                  <span className="font-headline font-bold text-sm relative z-10">Take Photo</span>
                </button>
                <button onClick={() => solverFileInputRef.current?.click()}
                  className="flex flex-col items-center justify-center bg-[#d3e4fe] p-8 rounded-[2rem] text-[#001e40] border-2 border-transparent hover:border-[#003366]/20 transition-all hover:scale-[1.02] active:scale-95">
                  <span className="material-symbols-outlined text-4xl mb-3 text-[#799dd6]">upload_file</span>
                  <span className="font-headline font-bold text-sm">Upload Photo</span>
                </button>
              </div>
              <div className="space-y-2">
                <label className="block text-xs font-bold text-[#001e40] uppercase tracking-widest px-1">Additional context (optional)</label>
                <textarea value={solverContext} onChange={e => setSolverContext(e.target.value)}
                  className="w-full h-28 bg-white border-none rounded-2xl p-4 text-sm text-[#0b1c30] placeholder:text-[#737780] focus:ring-2 focus:ring-[#003366]/20 transition-all shadow-sm resize-none"
                  placeholder="e.g. 'Solve for x' or 'Explain this concept simply'..." />
              </div>
              <div className="bg-white/70 backdrop-blur-sm rounded-2xl p-4 flex items-start gap-3 border border-white/40 shadow-sm">
                <div className="bg-[#006c49]/10 p-2 rounded-xl shrink-0">
                  <span className="material-symbols-outlined text-[#006c49] text-base" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
                </div>
                <div>
                  <p className="text-xs font-bold text-[#4edea3] uppercase tracking-wider mb-1">AI Tip</p>
                  <p className="text-[13px] text-[#005236] leading-snug">Ensure your camera is stable and handwriting is clear for best accuracy.</p>
                </div>
              </div>
            </div>
          )}

          {solverStep === "solving" && (
            <div className="flex flex-col items-center justify-center py-16 gap-6">
              {solverImageData && <img src={solverImageData} alt="Question" className="w-full max-h-48 object-contain rounded-2xl shadow-sm border border-slate-100" />}
              <div className="flex flex-col items-center gap-3">
                <div className="animate-spin rounded-full h-10 w-10 border-4 border-[#003366]/20 border-t-[#003366]" />
                <p className="text-sm font-medium text-[#43474f]">AI is working on it…</p>
              </div>
            </div>
          )}

          {solverStep === "result" && solverResult && (
            <div className="space-y-4">
              {solverImageData && <img src={solverImageData} alt="Question" className="w-full rounded-xl border border-slate-100" />}
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`px-3 py-1 rounded-full text-xs font-semibold ${solverResult.subject === "Science" ? "bg-green-100 text-green-700" : solverResult.subject === "English" ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"}`}>
                  {solverResult.subject}
                </span>
                {solverResult.topic && <span className="px-3 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-600">{solverResult.topic}</span>}
              </div>
              {solverResult.diagrams.length > 0 && (
                <div className="rounded-2xl bg-white border border-slate-100 p-4 space-y-4">
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Model Diagram</p>
                  {solverResult.diagrams.map((step, i) => (
                    <div key={i}>
                      {step.title && <p className="text-xs font-semibold text-blue-600 mb-2">{step.title}</p>}
                      <BarModel diagram={step} />
                      {i < solverResult.diagrams.length - 1 && <div className="border-t border-slate-100 mt-4" />}
                    </div>
                  ))}
                </div>
              )}
              <div className="rounded-2xl bg-gradient-to-br from-[#eff6ff] to-[#eff4ff] border border-slate-100 p-4">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Solution</p>
                <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-line">{solverResult.solution}</p>
              </div>
              <button onClick={openSolver}
                className="w-full py-3 rounded-xl border border-slate-200 text-slate-500 text-sm font-medium hover:bg-slate-50 transition-colors">
                Solve another question
              </button>
            </div>
          )}
        </main>
      )}

      {/* ── Main Content ─────────────────────────────────────────────────────── */}
      {activeNav !== "solver" && <main className="mt-20 px-6 max-w-lg mx-auto">

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
          <div className="flex items-center gap-4 mb-4">
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

          <h2 className="text-3xl font-headline font-extrabold text-[#003366] tracking-tight leading-tight">{greeting()}, {user.name.split(" ")[0]}!</h2>
          <p className="text-[#43474f] mt-1 text-sm mb-4">Let&apos;s improve your score together.</p>

          {/* Badges */}
          <div className="flex items-center gap-2 flex-wrap">
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
              <span className="material-symbols-outlined text-[#006c49]/40 text-2xl">arrow_forward</span>
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
                    onClick={() => router.push(`/test/${test.id}?userId=${userId}`)}
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

      </main>}{/* end activeNav !== solver */}

      </div>{/* end lg:hidden mobile wrapper */}

      {/* ── Hidden file inputs (shared mobile+desktop) ───────────────────── */}
      <input ref={solverFileInputRef} type="file" accept="image/*" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) handleSolverFile(f); e.target.value = ""; }} />
      <input ref={solverCameraRef} type="file" accept="image/*" capture="environment" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) handleSolverFile(f); e.target.value = ""; }} />

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

      {/* ── Desktop AI Solver Modal ──────────────────────────────────────────── */}
      {showAiSolver && (
        <div className="hidden lg:flex fixed inset-0 z-[60] items-center justify-center p-4" onClick={() => setShowAiSolver(false)}>
          <div className="absolute inset-0 bg-[#001e40]/40 backdrop-blur-sm" />
          <div className="relative w-full max-w-xl bg-white rounded-[2.5rem] shadow-[0_20px_40px_rgba(11,28,48,0.15)] overflow-hidden" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="px-8 pt-8 pb-4 flex justify-between items-start">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 bg-gradient-to-br from-[#001e40] to-[#003366] rounded-2xl flex items-center justify-center shadow-lg">
                  <span className="material-symbols-outlined text-white text-3xl" style={{ fontVariationSettings: "'FILL' 1" }}>psychology</span>
                </div>
                <h2 className="text-2xl font-headline font-extrabold text-[#001e40] tracking-tight">AI Solver</h2>
              </div>
              <button onClick={() => setShowAiSolver(false)} className="p-2 text-slate-400 hover:text-slate-600 transition-colors">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            {/* Body */}
            <div className="px-8 py-4 max-h-[70vh] overflow-y-auto">
              {solverStep === "capture" && (
                <>
                  <p className="text-base font-medium text-[#0b1c30] leading-relaxed mb-6">
                    Take a photo or upload an image of a question and let AI solve it.
                  </p>
                  {solverError && <div className="mb-4 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">{solverError}</div>}
                  <div className="grid grid-cols-2 gap-4 mb-6">
                    <button onClick={() => solverFileInputRef.current?.click()}
                      className="group flex flex-col items-center justify-center p-6 bg-[#eff4ff] rounded-3xl border-2 border-transparent hover:border-[#003366]/20 hover:bg-[#dce9ff] transition-all">
                      <div className="w-12 h-12 rounded-full bg-white flex items-center justify-center mb-3 shadow-sm group-hover:scale-110 transition-transform">
                        <span className="material-symbols-outlined text-[#001e40] text-2xl">upload_file</span>
                      </div>
                      <span className="font-bold text-[#001e40]">Upload Photo</span>
                    </button>
                    <button onClick={() => solverCameraRef.current?.click()}
                      className="group flex flex-col items-center justify-center p-6 bg-[#001e40] text-white rounded-3xl shadow-xl hover:shadow-[#001e40]/30 transition-all hover:-translate-y-1 active:translate-y-0">
                      <div className="w-12 h-12 rounded-full bg-white/20 flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
                        <span className="material-symbols-outlined text-white text-2xl" style={{ fontVariationSettings: "'FILL' 1" }}>photo_camera</span>
                      </div>
                      <span className="font-bold">Take Photo</span>
                    </button>
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-bold text-[#43474f] uppercase tracking-widest px-1">Additional context (optional)</label>
                    <textarea value={solverContext} onChange={e => setSolverContext(e.target.value)}
                      className="w-full bg-[#eff4ff] border-none rounded-2xl p-4 text-[#0b1c30] placeholder:text-[#737780] focus:ring-2 focus:ring-[#003366]/20 transition-all resize-none"
                      placeholder="e.g. This is about area of composite shapes. The shaded region is outside the circle." rows={4} />
                  </div>
                </>
              )}

              {solverStep === "solving" && (
                <div className="flex flex-col items-center justify-center py-12 gap-5">
                  {solverImageData && <img src={solverImageData} alt="Question" className="w-full max-h-48 object-contain rounded-xl border border-slate-100" />}
                  <div className="animate-spin rounded-full h-10 w-10 border-4 border-[#003366]/20 border-t-[#003366]" />
                  <p className="text-slate-500 text-sm">Solving question…</p>
                </div>
              )}

              {solverStep === "result" && solverResult && (
                <div className="space-y-4 pb-2">
                  {solverImageData && <img src={solverImageData} alt="Question" className="w-full rounded-xl border border-slate-100" />}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`px-3 py-1 rounded-full text-xs font-semibold ${solverResult.subject === "Science" ? "bg-green-100 text-green-700" : solverResult.subject === "English" ? "bg-purple-100 text-purple-700" : "bg-blue-100 text-blue-700"}`}>
                      {solverResult.subject}
                    </span>
                    {solverResult.topic && <span className="px-3 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-600">{solverResult.topic}</span>}
                  </div>
                  {solverResult.diagrams.length > 0 && (
                    <div className="rounded-2xl bg-white border border-slate-100 p-4 space-y-4">
                      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Model Diagram</p>
                      {solverResult.diagrams.map((step, i) => (
                        <div key={i}>
                          {step.title && <p className="text-xs font-semibold text-blue-600 mb-2">{step.title}</p>}
                          <BarModel diagram={step} />
                          {i < solverResult.diagrams.length - 1 && <div className="border-t border-slate-100 mt-4" />}
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="rounded-2xl bg-gradient-to-br from-[#eff6ff] to-[#eff4ff] border border-slate-100 p-4">
                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Solution</p>
                    <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-line">{solverResult.solution}</p>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-8 pb-8 pt-4 flex gap-4">
              {solverStep === "result" ? (
                <>
                  <button onClick={openSolver}
                    className="flex-1 py-4 px-6 rounded-xl font-bold border-2 border-slate-200 text-slate-500 hover:bg-slate-50 transition-all">
                    Solve Another
                  </button>
                  <button onClick={() => setShowAiSolver(false)}
                    className="flex-1 py-4 px-6 rounded-xl font-bold bg-[#001e40] text-white shadow-lg hover:opacity-90 transition-all">
                    Done
                  </button>
                </>
              ) : solverStep === "capture" ? (
                <>
                  <button onClick={() => setShowAiSolver(false)}
                    className="flex-1 py-4 px-6 rounded-xl font-bold border-2 border-slate-200 text-[#43474f] hover:bg-slate-50 transition-all">
                    Cancel
                  </button>
                  <button onClick={() => solverFileInputRef.current?.click()}
                    className="flex-1 py-4 px-6 rounded-xl font-bold bg-[#001e40] text-white shadow-lg hover:opacity-90 active:scale-95 transition-all flex items-center justify-center gap-2">
                    Start Solving
                    <span className="material-symbols-outlined text-lg">arrow_forward</span>
                  </button>
                </>
              ) : null}
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
        <button
          onClick={() => { setActiveNav("solver"); openSolver(); }}
          className={`flex flex-col items-center gap-0.5 transition-all ${activeNav === "solver" ? "text-[#003366]" : "text-slate-400"}`}
        >
          <span className={`material-symbols-outlined text-2xl ${activeNav === "solver" ? "bg-[#d3e4fe] rounded-2xl px-3 py-1" : ""}`}
            style={{ fontVariationSettings: activeNav === "solver" ? "'FILL' 1" : "'FILL' 0" }}>psychology</span>
          <span className="text-[10px] font-medium">Solver</span>
        </button>
      </nav>
    </div>
  );
}
