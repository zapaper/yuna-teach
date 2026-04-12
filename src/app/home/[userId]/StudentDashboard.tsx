"use client";

import { useEffect, useRef, useState } from "react";
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

// ─── Bar model diagram (Singapore model method) ───────────────────────────────

interface DiagramRow { label: string; units: number; value: string | null; }
interface DiagramStep { title: string | null; rows: DiagramRow[]; unitValue: string | null; }

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
            {row.value && (
              <text x={barX + BAR_AREA_W + 6} y={y + ROW_H / 2 + 4} fontSize="13" fontFamily="system-ui,sans-serif" fontWeight="700" fill={col.text}>{row.value}</text>
            )}
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

// ─── Component ────────────────────────────────────────────────────────────────

export default function StudentDashboard({ userId, user, firstQuiz }: { userId: string; user: User; firstQuiz?: boolean }) {
  const router = useRouter();
  const hasAvatar = user.settings?.avatar !== false; // default on for all students
  const avatarType = (user.settings as Record<string, unknown> | null)?.avatarType as string | undefined ?? "bunny";
  const [avatarSrc, setAvatarSrc] = useState(() => `/avatars/${avatarType}${Math.floor(Math.random() * 4) + 1}.mp4`);
  const [nextAvatarSrc, setNextAvatarSrc] = useState<string | null>(null);
  const avatarRef = useRef<HTMLVideoElement>(null);
  const nextAvatar = () => {
    const cur = avatarSrc;
    let next: string;
    do { next = `/avatars/${avatarType}${Math.floor(Math.random() * 4) + 1}.mp4`; } while (next === cur);
    setNextAvatarSrc(next);
  };
  const onAvatarPreloaded = () => {
    if (nextAvatarSrc) { setAvatarSrc(nextAvatarSrc); setNextAvatarSrc(null); }
  };
  useEffect(() => {
    const v = avatarRef.current;
    if (v) { v.currentTime = 0; v.play().catch(() => {}); }
    function onVisible() { if (document.visibilityState === "visible") avatarRef.current?.play().catch(() => {}); }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [avatarSrc]);

  const [tests, setTests] = useState<SpellingTestSummary[]>([]);
  const [examPapers, setExamPapers] = useState<ExamPaperSummary[]>([]);
  const [showFirstQuizPopup, setShowFirstQuizPopup] = useState(false);
  const [showPointsMilestone, setShowPointsMilestone] = useState(false);
  const [milestoneMessage, setMilestoneMessage] = useState("");
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const [selectedAvatar, setSelectedAvatar] = useState<string | null>(null);
  const [savingAvatar, setSavingAvatar] = useState(false);
  const [quizBadge, setQuizBadge] = useState<{ badge: string; image: string; count: number; streak: number } | null>(null);
  const [aiTip, setAiTip] = useState<string | null>(null);
  const [showQuizSetup, setShowQuizSetup] = useState(false);
  const [quizSubject, setQuizSubject] = useState<"math" | "science" | "english">("math");
  const [quizType, setQuizType] = useState<"mcq" | "mcq-oeq">("mcq");
  const [englishSections, setEnglishSections] = useState<Set<string>>(new Set(["grammar-mcq", "vocab-mcq", "vocab-cloze"]));
  const [creatingQuiz, setCreatingQuiz] = useState(false);
  const [badgeToast, setBadgeToast] = useState(false);
  const [adminNotifs, setAdminNotifs] = useState<Array<{ questionId: string; questionNum: string; adminReply: string; paperTitle: string }>>([]);
  const [showAdminNotifs, setShowAdminNotifs] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkTab, setLinkTab] = useState<"share" | "enter">("share");
  const [myCode, setMyCode] = useState<string | null>(null);
  const [myCodeLoading, setMyCodeLoading] = useState(false);
  const [enterCode, setEnterCode] = useState("");
  const [enterLoading, setEnterLoading] = useState(false);
  const [enterError, setEnterError] = useState("");
  const [enterSuccess, setEnterSuccess] = useState(false);
  const [activeNav, setActiveNav] = useState<"home" | "scan" | "quiz">("home");
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showPastWork, setShowPastWork] = useState(false);

  const fetchData = useRef<() => void>(undefined);
  fetchData.current = () => {
    fetch(`/api/tests?userId=${userId}`).then(r => r.json()).then(d => setTests(d.tests ?? [])).catch(() => {});
    fetch(`/api/exam?userId=${userId}`).then(r => r.json()).then(d => setExamPapers(d.papers ?? [])).catch(() => {});
  };

  useEffect(() => {
    fetchData.current?.();
    function onVisible() { if (document.visibilityState === "visible") fetchData.current?.(); }
    document.addEventListener("visibilitychange", onVisible);
    const poll = setInterval(() => fetchData.current?.(), 30000);
    return () => { document.removeEventListener("visibilitychange", onVisible); clearInterval(poll); };
  }, [userId]);

  // First-time student popup — only if student has no completed papers
  useEffect(() => {
    if (firstQuiz && examPapers.filter(p => p.completedAt).length === 0) {
      const timer = setTimeout(() => setShowFirstQuizPopup(true), 1500);
      return () => clearTimeout(timer);
    }
  }, [firstQuiz, examPapers]);

  useEffect(() => {
    fetch(`/api/user/${userId}/quiz-badge`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.badge) setQuizBadge({ badge: d.badge, image: d.badgeImage, count: d.completedQuizzes, streak: d.streak ?? 0 }); })
      .catch(() => {});
  }, [userId]);

  // Check point milestones (only if avatar toggle is on)
  useEffect(() => {
    if (!hasAvatar || examPapers.length === 0) return;
    const pts = examPapers.filter(p => p.completedAt).reduce((sum, p) => sum + (p.score ?? 0), 0);
    const milestones = [
      { points: 100, key: `points-milestone-100-${userId}`, msg: "You have scored more than 100 points. You can now select your profile avatar!" },
      { points: 500, key: `points-milestone-500-${userId}`, msg: "You have scored more than 500 points! A new Fox avatar has been unlocked!" },
      { points: 750, key: `points-milestone-750-${userId}`, msg: "You have scored more than 750 points! A new Otter avatar has been unlocked!" },
      { points: 1000, key: `points-milestone-1000-${userId}`, msg: "You have scored more than 1000 points! A new Merlion avatar has been unlocked!" },
    ];
    for (const m of milestones) {
      if (pts >= m.points && !localStorage.getItem(m.key)) {
        localStorage.setItem(m.key, "1");
        setMilestoneMessage(m.msg);
        setShowPointsMilestone(true);
        break; // show one at a time
      }
    }
  }, [hasAvatar, examPapers, userId]);

  // Fetch admin notifications
  useEffect(() => {
    fetch(`/api/notifications?userId=${userId}`)
      .then(r => r.ok ? r.json() : [])
      .then((data: Array<{ questionId: string; questionNum: string; adminReply: string; paperTitle: string }>) => {
        if (data.length > 0) { setAdminNotifs(data); setShowAdminNotifs(true); }
      })
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

  async function fetchMyCode() {
    setMyCodeLoading(true);
    try {
      let res = await fetch(`/api/invite?userId=${userId}`);
      let data = await res.json();
      if (!data.code) {
        res = await fetch("/api/invite", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId }) });
        data = await res.json();
      }
      setMyCode(data.code ?? null);
    } catch { /* silent */ }
    finally { setMyCodeLoading(false); }
  }

  function openLinkModal(tab: "share" | "enter" = "share") {
    setShowLinkModal(true);
    setLinkTab(tab);
    setEnterCode(""); setEnterError(""); setEnterSuccess(false);
    if (tab === "share" && !myCode) fetchMyCode();
  }

  async function handleEnterCode() {
    if (enterCode.length < 6) return;
    setEnterLoading(true); setEnterError("");
    try {
      const res = await fetch("/api/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: enterCode.toUpperCase(), userId }),
      });
      const data = await res.json();
      if (!res.ok) { setEnterError(data.error || "Invalid code"); return; }
      setEnterSuccess(true);
      setTimeout(() => { window.location.reload(); }, 1500);
    } catch { setEnterError("Something went wrong"); }
    finally { setEnterLoading(false); }
  }

  async function handleDeleteTest(e: React.MouseEvent, testId: string) {
    e.stopPropagation();
    try {
      await fetch(`/api/tests/${testId}`, { method: "DELETE" });
      setTests(prev => prev.filter(t => t.id !== testId));
    } catch { /* silent fail */ }
  }

  async function handleDeletePaper(e: React.MouseEvent, paperId: string) {
    e.stopPropagation();
    if (!confirm("Delete this quiz/practice?")) return;
    try {
      await fetch(`/api/exam/${paperId}?userId=${userId}`, { method: "DELETE" });
      setExamPapers(prev => prev.filter(p => p.id !== paperId));
    } catch { /* silent fail */ }
  }

  async function startQuiz() {
    setCreatingQuiz(true);
    try {
      const res = await fetch("/api/daily-quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          quizType: quizSubject === "english" ? "mcq" : quizType,
          subject: quizSubject,
          ...(quizSubject === "english" && englishSections.size > 0 ? { englishSections: [...englishSections] } : {}),
        }),
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
  const completedPapers = studentPapers
    .filter(p => p.completedAt || p.markingStatus === "released")
    .sort((a, b) => {
      const aTime = a.completedAt ? new Date(a.completedAt).getTime() : 0;
      const bTime = b.completedAt ? new Date(b.completedAt).getTime() : 0;
      return bTime - aTime;
    });
  const recentTests = tests.slice(0, 6);

  const totalPoints = completedPapers.reduce((sum, p) => sum + (p.score ?? 0), 0);
  const hasParent = (user.linkedParents?.length ?? 0) > 0;

  // ─── Derived data for new layout ───
  const now = new Date();
  const fiveDaysAgo = new Date(now.getTime() - 5 * 86400000);
  // Use local date strings to avoid UTC timezone mismatch (e.g. SGT = UTC+8)
  const localDateStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const todayStr = localDateStr(now);
  const todayActivities = studentPapers.filter(p => localDateStr(new Date(p.createdAt ?? "")) === todayStr);
  const todayTodo = todayActivities.filter(p => !p.completedAt);
  const todayDone = todayActivities.filter(p => p.completedAt);
  const weekHomework = studentPapers.filter(p => !p.completedAt && new Date(p.createdAt ?? "") >= fiveDaysAgo && localDateStr(new Date(p.createdAt ?? "")) !== todayStr);

  function goToPaper(p: ExamPaperSummary) {
    if (p.paperType === "quiz" || p.paperType === "focused") router.push(`/quiz/${p.id}?userId=${userId}`);
    else router.push(`/exam/${p.sourceExamId ?? p.id}/overview?userId=${userId}&openClone=${p.id}`);
  }
  function paperIcon(p: ExamPaperSummary) {
    if (p.paperType === "quiz") return "quiz";
    if (p.paperType === "focused") return "psychology";
    const s = (p.subject ?? "").toLowerCase();
    return s.includes("science") ? "biotech" : s.includes("english") ? "translate" : "calculate";
  }

  return (
    <div className="bg-[#f8f9ff] font-body text-[#0b1c30] antialiased min-h-screen overflow-x-hidden">

      {/* First-time student popup */}
      {showFirstQuizPopup && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[100] p-4" onClick={() => setShowFirstQuizPopup(false)}>
          <div className="bg-white rounded-3xl p-8 max-w-sm w-full shadow-2xl text-center" onClick={e => e.stopPropagation()}>
            <div className="w-16 h-16 rounded-full bg-[#6cf8bb]/30 flex items-center justify-center mx-auto mb-4">
              <span className="material-symbols-outlined text-3xl text-[#006c49]" style={{ fontVariationSettings: "'FILL' 1" }}>rocket_launch</span>
            </div>
            <h2 className="font-headline text-xl font-extrabold text-[#001e40] mb-2">Welcome!</h2>
            <p className="text-sm text-[#43474f] mb-6">Your first quiz is ready. Click on the quiz below to begin!</p>
            <button onClick={() => setShowFirstQuizPopup(false)} className="px-6 py-3 rounded-xl bg-[#003366] text-white font-bold hover:bg-[#001e40] transition-colors">Got it!</button>
          </div>
        </div>
      )}

      {/* Points milestone — avatar selection */}
      {showPointsMilestone && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[100] p-4">
          <div className="bg-white rounded-3xl p-8 max-w-sm w-full shadow-2xl text-center">
            <div className="w-16 h-16 rounded-full bg-[#ffddb4]/50 flex items-center justify-center mx-auto mb-4">
              <span className="material-symbols-outlined text-3xl text-[#d58d00]" style={{ fontVariationSettings: "'FILL' 1" }}>stars</span>
            </div>
            <h2 className="font-headline text-xl font-extrabold text-[#001e40] mb-2">Congratulations!</h2>
            <p className="text-sm text-[#43474f] mb-6">
              {milestoneMessage}
            </p>
            <div className="grid grid-cols-3 gap-3 mb-6">
              {[
                { key: "bunny", label: "Bunny", points: 0 },
                { key: "bear", label: "Bear", points: 0 },
                { key: "fox", label: "Fox", points: 500 },
                { key: "otter", label: "Otter", points: 750 },
                { key: "merlion", label: "Merlion", points: 1000 },
              ].map(animal => {
                const unlocked = totalPoints >= animal.points;
                const isSelected = (selectedAvatar ?? avatarType) === animal.key;
                return (
                  <button
                    key={animal.key}
                    onClick={() => unlocked && setSelectedAvatar(animal.key)}
                    disabled={!unlocked}
                    className={`p-3 rounded-2xl border-2 transition-all relative ${isSelected ? "border-[#006c49] bg-[#006c49]/5 scale-105" : unlocked ? "border-slate-200 hover:border-[#a7c8ff]" : "border-slate-100 opacity-40"}`}
                  >
                    <video src={`/avatars/${animal.key}1.mp4`} autoPlay loop muted playsInline className="w-16 h-16 mx-auto object-contain" style={{ mixBlendMode: "multiply" }} />
                    <p className="text-xs font-bold text-[#001e40] mt-1">{animal.label}</p>
                    {animal.points > 0 && !unlocked && (
                      <p className="text-[9px] text-[#737780]">{animal.points} pts</p>
                    )}
                  </button>
                );
              })}
            </div>
            <button
              onClick={async () => {
                if (selectedAvatar) {
                  await fetch("/api/users", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ userId, settings: { avatar: true, avatarType: selectedAvatar } }),
                  });
                }
                setShowPointsMilestone(false);
                if (selectedAvatar) window.location.reload();
              }}
              className="px-6 py-3 rounded-xl bg-[#003366] text-white font-bold hover:bg-[#001e40] transition-colors"
            >
              {selectedAvatar ? "Set Avatar" : "Maybe Later"}
            </button>
          </div>
        </div>
      )}

      {/* Avatar picker modal */}
      {showAvatarPicker && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[100] p-4" onClick={() => setShowAvatarPicker(false)}>
          <div className="bg-white rounded-3xl p-6 max-w-sm w-full shadow-2xl" onClick={e => e.stopPropagation()}>
            <h2 className="font-headline text-lg font-extrabold text-[#001e40] text-center mb-1">Choose Your Avatar</h2>
            <p className="text-xs text-[#43474f] text-center mb-5">Tap to select</p>
            <div className="grid grid-cols-3 gap-3 mb-5">
              {[
                { key: "bunny", label: "Bunny", points: 0 },
                { key: "bear", label: "Bear", points: 0 },
                { key: "fox", label: "Fox", points: 500 },
                { key: "otter", label: "Otter", points: 750 },
                { key: "merlion", label: "Merlion", points: 1000 },
              ].map(animal => {
                const unlocked = totalPoints >= animal.points;
                const isSelected = (selectedAvatar ?? avatarType) === animal.key;
                return (
                  <button
                    key={animal.key}
                    onClick={() => unlocked && setSelectedAvatar(animal.key)}
                    disabled={!unlocked}
                    className={`p-3 rounded-2xl border-2 transition-all relative ${isSelected ? "border-[#006c49] bg-[#006c49]/5 scale-105" : unlocked ? "border-slate-200 hover:border-[#a7c8ff]" : "border-slate-100 opacity-40"}`}
                  >
                    <video src={`/avatars/${animal.key}1.mp4`} autoPlay loop muted playsInline className="w-20 h-20 mx-auto object-contain" style={{ mixBlendMode: "multiply" }} />
                    <p className="text-xs font-bold text-[#001e40] mt-1">{animal.label}</p>
                    {animal.points > 0 && !unlocked && (
                      <p className="text-[10px] text-[#737780] mt-0.5">{animal.points} pts to unlock</p>
                    )}
                    {animal.points > 0 && unlocked && (
                      <span className="absolute top-1 right-1 material-symbols-outlined text-[#006c49] text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setShowAvatarPicker(false)}
                className="flex-1 py-2.5 rounded-xl border-2 border-slate-200 text-slate-600 font-bold text-sm"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  const chosen = selectedAvatar ?? avatarType;
                  if (chosen === avatarType) { setShowAvatarPicker(false); return; }
                  setSavingAvatar(true);
                  await fetch("/api/users", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ userId, settings: { avatarType: chosen } }),
                  });
                  setSavingAvatar(false);
                  setShowAvatarPicker(false);
                  window.location.reload();
                }}
                disabled={savingAvatar}
                className="flex-1 py-2.5 rounded-xl bg-[#003366] text-white font-bold text-sm disabled:opacity-50"
              >
                {savingAvatar ? "Saving..." : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Admin notification popup */}
      {showAdminNotifs && adminNotifs.length > 0 && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[100] p-4">
          <div className="bg-white rounded-3xl p-6 max-w-sm w-full shadow-2xl space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-[#003366] flex items-center justify-center">
                <span className="material-symbols-outlined text-white text-lg">chat</span>
              </div>
              <h3 className="font-headline font-extrabold text-[#001e40]">Message from Teacher</h3>
            </div>
            {adminNotifs.map(n => (
              <div key={n.questionId} className="bg-[#eff4ff] rounded-2xl px-4 py-3">
                <p className="text-xs text-[#43474f] font-medium mb-1">{n.paperTitle} · Q{n.questionNum}</p>
                <p className="text-sm text-[#001e40] whitespace-pre-wrap">{n.adminReply}</p>
              </div>
            ))}
            <button
              onClick={() => {
                setShowAdminNotifs(false);
                fetch("/api/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId, questionIds: adminNotifs.map(n => n.questionId) }) }).catch(() => {});
              }}
              className="w-full py-3 rounded-xl bg-[#003366] text-white font-bold">Got it</button>
          </div>
        </div>
      )}

      {/* ══ DESKTOP LAYOUT ══ */}
      <div className="hidden lg:flex min-h-screen">
        <aside className="fixed left-0 top-0 h-full w-64 bg-slate-50 flex flex-col z-40 py-8 px-6">
          <div className="mb-10 flex items-center gap-3">
            <img src="/logo_t.png" alt="Owl" className="w-10 h-10 object-contain" />
            <span className="text-2xl font-bold text-[#001e40] tracking-tight font-headline">MarkForYou</span>
          </div>
          <div className="mb-8 p-4 bg-[#e5eeff] rounded-xl">
            <div className="flex items-center gap-3">
              <div className="w-12 h-12 rounded-full bg-[#d3e4fe] flex items-center justify-center text-[#001e40] font-extrabold">{initials(user.name)}</div>
              <div>
                <p className="font-bold text-[#0b1c30]">{user.name}</p>
                {user.linkedParents?.length > 0 && <p className="text-xs text-[#43474f]">{user.linkedParents[0].name}</p>}
              </div>
            </div>
          </div>
          <nav className="flex flex-col gap-2 text-sm font-medium font-headline">
            <button className="flex items-center gap-3 px-4 py-3 rounded-lg text-[#001e40] font-bold border-r-4 border-[#001e40] bg-blue-50/50">
              <span className="material-symbols-outlined">home</span>Home
            </button>
            <button onClick={() => router.push(`/scan?userId=${userId}`)} className="flex items-center gap-3 px-4 py-3 rounded-lg text-slate-500 hover:bg-blue-50 transition-colors">
              <span className="material-symbols-outlined">spellcheck</span>听写
            </button>
            <button onClick={() => setShowQuizSetup(true)} className="flex items-center gap-3 px-4 py-3 rounded-lg text-slate-500 hover:bg-blue-50 transition-colors">
              <span className="material-symbols-outlined">quiz</span>Quiz
            </button>
          </nav>
          <div className="mt-auto">
            <button onClick={() => openLinkModal("share")} className="w-full py-2.5 rounded-xl border-2 border-[#003366]/20 text-[#003366] text-xs font-bold hover:bg-[#003366]/5 transition-colors">
              {hasParent ? "Link Another Parent" : "Link Parent"}
            </button>
          </div>
        </aside>
        <main className="ml-64 flex-1 min-h-screen">
          <header className="w-full h-16 sticky top-0 z-40 backdrop-blur-md flex justify-end items-center px-8">
            <div className="flex items-center gap-4 text-[#001e40]">
              <button className="relative" onClick={() => { if (adminNotifs.length > 0) setShowAdminNotifs(true); }}>
                <span className="material-symbols-outlined hover:opacity-80">notifications</span>
                {adminNotifs.length > 0 && <span className="absolute -top-1 -right-1 w-2 h-2 bg-[#ba1a1a] rounded-full" />}
              </button>
              {quizBadge && <span className="material-symbols-outlined hover:opacity-80" style={{ fontVariationSettings: "'FILL' 1" }}>workspace_premium</span>}
              <div className="relative">
                <button onClick={() => setShowProfileMenu(v => !v)} className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold bg-[#d3e4fe] text-[#001e40]">
                  {initials(user.name)}
                </button>
                {showProfileMenu && (<>
                  <div className="fixed inset-0 z-40" onClick={() => setShowProfileMenu(false)} />
                  <div className="absolute right-0 top-10 bg-white rounded-xl shadow-lg border border-[#e5eeff] py-2 w-40 z-50">
                    <div className="px-4 py-2 border-b border-[#e5eeff]">
                      <p className="text-sm font-bold text-[#001e40] truncate">{user.name}</p>
                      <p className="text-[10px] text-[#43474f]">Student</p>
                    </div>
                    <button onClick={() => router.push("/login")} className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-[#ba1a1a] hover:bg-red-50 transition-colors">
                      <span className="material-symbols-outlined text-base">logout</span>Log out
                    </button>
                  </div>
                </>)}
              </div>
            </div>
          </header>
          <div className="px-6 lg:px-10 py-8 max-w-5xl mx-auto">
            <section className="mb-12">
              <div className="flex items-center gap-4">
                {hasAvatar && (
                  <button onClick={() => setShowAvatarPicker(true)} className="w-16 h-16 rounded-full border-2 border-[#a7c8ff] overflow-hidden flex items-center justify-center bg-white shrink-0 hover:border-[#003366] hover:scale-105 transition-all cursor-pointer relative">
                    <video ref={avatarRef} src={avatarSrc} autoPlay muted playsInline onEnded={nextAvatar} className="w-full h-full object-contain pointer-events-none" style={{ mixBlendMode: "multiply" }} />
                    {nextAvatarSrc && <video src={nextAvatarSrc} muted playsInline preload="auto" onCanPlayThrough={onAvatarPreloaded} className="absolute inset-0 invisible" />}
                  </button>
                )}
                <h1 className="text-4xl font-extrabold text-[#001e40] mb-2 tracking-tight font-headline">{greeting()}, {user.name.split(" ")[0]}!</h1>
              </div>
              <p className="text-lg text-[#43474f] font-medium">Ready to learn today? You&apos;re doing great!</p>
              {quizBadge && (
                <div className="flex flex-wrap items-center gap-4 mt-6">
                  {quizBadge.streak > 0 && (
                    <div className="flex items-center gap-2 bg-[#ffddb4] text-[#291800] px-4 py-2 rounded-full">
                      <span className="material-symbols-outlined text-2xl" style={{ fontVariationSettings: "'FILL' 1" }}>local_fire_department</span>
                      <span className="text-lg font-extrabold">{quizBadge.streak}-day streak</span>
                    </div>
                  )}
                  {quizBadge.image && (
                    <div className="flex items-center gap-2 bg-[#d3e4fe] text-[#001e40] px-4 py-2 rounded-full">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={quizBadge.image} alt={quizBadge.badge} className="w-8 h-8 object-contain" />
                      <span className="text-lg font-extrabold">{quizBadge.count} {quizBadge.count === 1 ? "quiz" : "quizzes"} completed</span>
                    </div>
                  )}
                  <div className="flex items-center gap-2 bg-[#e5eeff] text-[#001e40] px-4 py-2 rounded-full">
                    <span className="material-symbols-outlined text-xl text-[#003366]" style={{ fontVariationSettings: "'FILL' 1" }}>star</span>
                    <span className="text-lg font-extrabold">{totalPoints} Points</span>
                  </div>
                </div>
              )}
            </section>
            <div className="grid grid-cols-12 gap-8 mb-12">
              <div className="col-span-12 lg:col-span-6 bg-[#eff4ff] rounded-[2rem] p-8 relative overflow-hidden">
                <div className="absolute -top-10 -right-10 w-40 h-40 bg-[#006c49]/5 rounded-full blur-3xl" />
                <h2 className="text-2xl font-bold text-[#001e40] mb-6 flex items-center gap-2 font-headline">
                  <span className="material-symbols-outlined text-[#006c49]" style={{ fontVariationSettings: "'FILL' 1" }}>task_alt</span>Today&apos;s Activities
                </h2>
                <div className="space-y-4">
                  {todayDone.map(p => (
                    <div key={p.id} onClick={() => router.push(`/exam/${p.id}/review?userId=${userId}`)} className="flex items-center gap-4 p-5 bg-[#6cf8bb]/20 border border-[#6cf8bb]/30 rounded-2xl shadow-sm hover:shadow-md transition-shadow cursor-pointer">
                      <div className="w-6 h-6 rounded border-2 border-[#006c49] bg-[#006c49] flex items-center justify-center">
                        <span className="material-symbols-outlined text-white text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>check</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="font-semibold text-[#0b1c30] truncate block">{p.title}</span>
                        <span className="text-[10px] text-[#43474f]">{relativeDate(p.createdAt)}</span>
                      </div>
                      <span className="text-[10px] font-bold px-2 py-1 bg-[#6cf8bb] text-[#006c49] rounded-full shrink-0">DONE</span>
                    </div>
                  ))}
                  {todayTodo.map(p => (
                    <div key={p.id} onClick={() => goToPaper(p)} className="flex items-center gap-4 p-5 bg-white rounded-2xl shadow-sm hover:shadow-md transition-shadow cursor-pointer">
                      <div className="w-6 h-6 rounded border-2 border-[#c3c6d1]" />
                      <div className="flex-1 min-w-0">
                        <span className="font-semibold text-[#0b1c30] truncate block">{p.title}</span>
                        <span className="text-[10px] text-[#43474f]">{relativeDate(p.createdAt)}</span>
                      </div>
                      <span className={`text-[10px] font-bold px-2 py-1 rounded-full shrink-0 ${p.timeSpentSeconds > 0 ? "bg-[#fef3c7] text-[#92400e]" : "bg-[#dce9ff] text-[#737780]"}`}>{p.timeSpentSeconds > 0 ? "IN PROGRESS" : "TODO"}</span>
                    </div>
                  ))}
                  {todayActivities.length === 0 && (
                    <div className="text-center py-6"><span className="material-symbols-outlined text-3xl text-[#c3c6d1] mb-2 block">event_available</span><p className="text-sm text-[#43474f]">No activities yet today</p></div>
                  )}
                </div>
              </div>
              <div className="col-span-12 lg:col-span-6 bg-[#d3e4fe]/40 backdrop-blur-sm rounded-[2rem] p-8 border border-white/50">
                <h2 className="text-2xl font-bold text-[#001e40] mb-6 flex items-center gap-2 font-headline">
                  <span className="material-symbols-outlined text-[#001e40]">assignment</span>This Week&apos;s Homework
                </h2>
                {weekHomework.length > 0 ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {weekHomework.map(p => (
                      <div key={p.id} onClick={() => goToPaper(p)} className="bg-white p-6 rounded-3xl group cursor-pointer hover:bg-[#001e40] hover:text-white transition-all duration-300 shadow-sm">
                        <div className="w-12 h-12 rounded-2xl bg-[#006c49]/10 group-hover:bg-white/20 flex items-center justify-center mb-4 transition-colors">
                          <span className="material-symbols-outlined text-[#006c49] group-hover:text-white">{paperIcon(p)}</span>
                        </div>
                        <h3 className="font-bold text-lg leading-tight mb-2">{p.title}</h3>
                        <p className="text-sm opacity-70">{relativeDate(p.createdAt)}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-8"><span className="material-symbols-outlined text-3xl text-[#c3c6d1] mb-2 block">celebration</span><p className="text-sm text-[#43474f]">All caught up! No pending homework.</p></div>
                )}
              </div>
            </div>
            <section className="mb-12">
              <h2 className="text-xl font-bold text-[#001e40] mb-4 font-headline">Self-learning</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                <button onClick={() => setShowQuizSetup(true)} className="relative group h-48 rounded-[2.5rem] bg-[#006c49] overflow-hidden text-left p-10 flex flex-col justify-end transition-all hover:scale-[1.02] active:scale-95 shadow-xl shadow-[#006c49]/20">
                  <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(circle_at_30%_-20%,rgba(255,255,255,0.2),transparent)]" />
                  <span className="material-symbols-outlined text-6xl text-white/20 absolute top-8 right-8">rocket_launch</span>
                  <h3 className="text-3xl font-extrabold text-white mb-2 font-headline">Daily 20min Quiz</h3>
                  <p className="text-[#6cf8bb]/90 font-medium">Power up your memory today</p>
                </button>
                <button onClick={() => router.push(`/scan?userId=${userId}`)} className="relative group h-48 rounded-[2.5rem] bg-[#001e40] overflow-hidden text-left p-10 flex flex-col justify-end transition-all hover:scale-[1.02] active:scale-95 shadow-xl shadow-[#001e40]/20">
                  <span className="material-symbols-outlined text-6xl text-white/20 absolute top-8 right-8">camera_enhance</span>
                  <h3 className="text-3xl font-extrabold text-white mb-2 font-headline">Scan Spelling / 听写</h3>
                  <p className="text-[#a7c8ff] font-medium">Scan and test your spelling</p>
                </button>
              </div>
            </section>
            {/* Recent Spelling Tests */}
            {recentTests.length > 0 && (
              <section className="mb-12">
                <h2 className="text-xl font-bold text-[#001e40] mb-4 font-headline">Recent Spelling / 听写</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {recentTests.map(t => (
                    <div key={t.id} onClick={() => router.push(`/test/${t.id}?userId=${userId}`)}
                      className="flex items-center gap-3 p-4 bg-white rounded-2xl shadow-sm hover:shadow-md transition-shadow cursor-pointer">
                      <div className="w-10 h-10 rounded-xl bg-[#eff4ff] flex items-center justify-center text-[#001e40] shrink-0">
                        <span className="material-symbols-outlined text-lg">spellcheck</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-sm text-[#001e40] truncate">{t.title}</p>
                        <p className="text-xs text-[#43474f]">{relativeDate(t.createdAt)} &middot; {t.wordCount} words</p>
                      </div>
                      <span className="material-symbols-outlined text-[#c3c6d1] text-lg shrink-0">chevron_right</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {completedPapers.length > 0 && (
              <section className="mb-12">
                <button onClick={() => setShowPastWork(!showPastWork)} className="flex items-center gap-2 text-sm font-bold text-[#43474f] hover:text-[#001e40] transition-colors mb-4">
                  <span className="material-symbols-outlined text-base">{showPastWork ? "expand_less" : "expand_more"}</span>Past Completed Work ({completedPapers.length})
                </button>
                {showPastWork && (
                  <div className="space-y-3">
                    {completedPapers.slice(0, 10).map(p => { const pct = scorePct(p); return (
                      <div key={p.id} onClick={() => router.push(`/exam/${p.id}/review?userId=${userId}`)} className="flex items-center gap-4 p-4 bg-white rounded-2xl shadow-sm hover:shadow-md transition-shadow cursor-pointer">
                        <div className="w-10 h-10 rounded-xl bg-[#eff4ff] flex items-center justify-center text-[#001e40] shrink-0"><span className="material-symbols-outlined text-lg">{paperIcon(p)}</span></div>
                        <div className="flex-1 min-w-0"><p className="font-bold text-sm text-[#001e40] truncate">{p.title}</p><p className="text-xs text-[#43474f]">{relativeDate(p.completedAt!)}</p></div>
                        {pct !== null && <span className={`font-extrabold text-sm ${pct >= 75 ? "text-[#006c49]" : pct >= 50 ? "text-[#d58d00]" : "text-[#ba1a1a]"}`}>{pct}%</span>}
                      </div>
                    ); })}
                  </div>
                )}
              </section>
            )}
          </div>
        </main>
      </div>

      {/* ══ MOBILE LAYOUT ══ */}
      <div className="lg:hidden pb-24">
        <header className="sticky top-0 z-40 bg-[#f8f9ff]/90 backdrop-blur-md px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2"><img src="/logo_t.png" alt="Owl" className="w-7 h-7 object-contain" /><img src="/markforyou2_t.png" alt="Markforyou" className="h-5 object-contain" /></div>
          <div className="flex items-center gap-2">
            <button onClick={() => openLinkModal("share")} className="text-xs font-bold text-[#003366] bg-[#eff4ff] px-3 py-1.5 rounded-full">{hasParent ? "+" : "Link"}</button>
            <div className="relative">
              <button onClick={() => setShowProfileMenu(v => !v)} className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${hasAvatar ? "border-2 border-[#a7c8ff] bg-white overflow-hidden" : "bg-[#d3e4fe] text-[#001e40]"}`}>
                {hasAvatar ? (
                  <video src="/avatars/bunny1.mp4" autoPlay loop muted playsInline className="w-full h-full object-contain" style={{ mixBlendMode: "multiply" }} />
                ) : initials(user.name)}
              </button>
              {showProfileMenu && (
                <div className="absolute right-0 top-10 bg-white rounded-xl shadow-lg border border-[#e5eeff] py-2 w-40 z-50">
                  <div className="px-4 py-2 border-b border-[#e5eeff]">
                    <p className="text-sm font-bold text-[#001e40] truncate">{user.name}</p>
                    <p className="text-[10px] text-[#43474f]">Student</p>
                  </div>
                  <button onClick={() => router.push("/login")} className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-[#ba1a1a] hover:bg-red-50 transition-colors">
                    <span className="material-symbols-outlined text-base">logout</span>Log out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        <div className="px-5">
          <section className="mb-8 mt-2">
            <div className="flex items-center gap-3">
              {hasAvatar && (
                <button onClick={() => setShowAvatarPicker(true)} className="w-12 h-12 rounded-full border-2 border-[#a7c8ff] overflow-hidden flex items-center justify-center bg-white shrink-0 hover:border-[#003366] transition-all">
                  <video src={avatarSrc} autoPlay loop muted playsInline className="w-full h-full object-contain pointer-events-none" style={{ mixBlendMode: "multiply" }} />
                </button>
              )}
              <h1 className="text-2xl font-extrabold text-[#001e40] mb-1 font-headline">{greeting()}, {user.name.split(" ")[0]}!</h1>
            </div>
            <p className="text-sm text-[#43474f]">Ready to learn today?</p>
            <div className="flex flex-wrap gap-2 mt-3">
              {quizBadge && quizBadge.streak > 0 && <div className="flex items-center gap-1.5 bg-[#ffddb4] text-[#291800] px-3 py-1.5 rounded-full text-sm font-extrabold"><span className="material-symbols-outlined text-xl" style={{ fontVariationSettings: "'FILL' 1" }}>local_fire_department</span>{quizBadge.streak}-day streak</div>}
              {quizBadge && quizBadge.image && <div className="flex items-center gap-1.5 bg-[#d3e4fe] text-[#001e40] px-3 py-1.5 rounded-full text-sm font-extrabold">{/* eslint-disable-next-line @next/next/no-img-element */}<img src={quizBadge.image} alt={quizBadge.badge} className="w-6 h-6 object-contain" />{quizBadge.count} {quizBadge.count === 1 ? "quiz" : "quizzes"}</div>}
              <div className="flex items-center gap-1.5 bg-[#e5eeff] text-[#001e40] px-3 py-1.5 rounded-full text-sm font-extrabold">
                <span className="material-symbols-outlined text-base text-[#003366]" style={{ fontVariationSettings: "'FILL' 1" }}>star</span>
                {totalPoints} Points
              </div>
            </div>
          </section>
          <section className="mb-8">
            <h2 className="text-lg font-bold text-[#001e40] mb-4 flex items-center gap-2 font-headline"><span className="material-symbols-outlined text-[#006c49]" style={{ fontVariationSettings: "'FILL' 1" }}>task_alt</span>Today&apos;s Activities</h2>
            <div className="space-y-3">
              {todayDone.map(p => <div key={p.id} onClick={() => router.push(`/exam/${p.id}/review?userId=${userId}`)} className="flex items-center gap-3 p-4 bg-[#6cf8bb]/20 border border-[#6cf8bb]/30 rounded-2xl cursor-pointer"><div className="w-5 h-5 rounded border-2 border-[#006c49] bg-[#006c49] flex items-center justify-center"><span className="material-symbols-outlined text-white text-xs" style={{ fontVariationSettings: "'FILL' 1" }}>check</span></div><div className="flex-1 min-w-0"><span className="font-semibold text-sm text-[#0b1c30] truncate block">{p.title}</span><span className="text-[10px] text-[#43474f]">{relativeDate(p.createdAt)}</span></div><span className="text-[9px] font-bold px-2 py-0.5 bg-[#6cf8bb] text-[#006c49] rounded-full shrink-0">DONE</span></div>)}
              {todayTodo.map(p => <div key={p.id} onClick={() => goToPaper(p)} className="flex items-center gap-3 p-4 bg-white rounded-2xl shadow-sm cursor-pointer"><div className="w-5 h-5 rounded border-2 border-[#c3c6d1]" /><div className="flex-1 min-w-0"><span className="font-semibold text-sm text-[#0b1c30] truncate block">{p.title}</span><span className="text-[10px] text-[#43474f]">{relativeDate(p.createdAt)}</span></div><span className="text-[9px] font-bold px-2 py-0.5 bg-[#dce9ff] text-[#737780] rounded-full shrink-0">TODO</span></div>)}
              {todayActivities.length === 0 && <p className="text-sm text-[#43474f] text-center py-4">No activities yet today</p>}
            </div>
          </section>
          {weekHomework.length > 0 && <section className="mb-8"><h2 className="text-lg font-bold text-[#001e40] mb-4 font-headline">This Week&apos;s Homework</h2><div className="space-y-3">{weekHomework.map(p => <div key={p.id} onClick={() => goToPaper(p)} className="flex items-center gap-3 p-4 bg-white rounded-2xl shadow-sm cursor-pointer"><div className="w-10 h-10 rounded-xl bg-[#eff4ff] flex items-center justify-center shrink-0"><span className="material-symbols-outlined text-[#001e40]">{paperIcon(p)}</span></div><div className="flex-1 min-w-0"><p className="font-bold text-sm text-[#001e40] truncate">{p.title}</p><p className="text-xs text-[#43474f]">{relativeDate(p.createdAt)}</p></div></div>)}</div></section>}
          <h2 className="text-lg font-bold text-[#001e40] mb-3 font-headline">Self-learning</h2>
          <section className="mb-8 grid grid-cols-2 gap-3">
            <button onClick={() => setShowQuizSetup(true)} className="relative h-32 rounded-2xl bg-[#006c49] overflow-hidden text-left p-5 flex flex-col justify-end"><span className="material-symbols-outlined text-3xl text-white/20 absolute top-3 right-3">rocket_launch</span><h3 className="text-sm font-extrabold text-white font-headline">Daily Quiz</h3><p className="text-[10px] text-[#6cf8bb]/80">20 min practice</p></button>
            <button onClick={() => router.push(`/scan?userId=${userId}`)} className="relative h-32 rounded-2xl bg-[#001e40] overflow-hidden text-left p-5 flex flex-col justify-end"><span className="material-symbols-outlined text-3xl text-white/20 absolute top-3 right-3">camera_enhance</span><h3 className="text-sm font-extrabold text-white font-headline">Scan 听写</h3><p className="text-[10px] text-[#a7c8ff]/80">Mark spelling</p></button>
          </section>
          {recentTests.length > 0 && (
            <section className="mb-8">
              <h2 className="text-base font-bold text-[#001e40] mb-3 font-headline">Recent Spelling / 听写</h2>
              <div className="space-y-2">
                {recentTests.map(t => (
                  <div key={t.id} onClick={() => router.push(`/test/${t.id}?userId=${userId}`)} className="flex items-center gap-3 p-3 bg-white rounded-xl shadow-sm cursor-pointer">
                    <div className="w-9 h-9 rounded-lg bg-[#eff4ff] flex items-center justify-center text-[#001e40] shrink-0"><span className="material-symbols-outlined text-base">spellcheck</span></div>
                    <div className="flex-1 min-w-0"><p className="font-bold text-xs text-[#001e40] truncate">{t.title}</p><p className="text-[10px] text-[#43474f]">{relativeDate(t.createdAt)} &middot; {t.wordCount} words</p></div>
                    <span className="material-symbols-outlined text-[#c3c6d1] text-base shrink-0">chevron_right</span>
                  </div>
                ))}
              </div>
            </section>
          )}
          {completedPapers.length > 0 && <section className="mb-8"><button onClick={() => setShowPastWork(!showPastWork)} className="flex items-center gap-1 text-xs font-bold text-[#43474f] mb-3"><span className="material-symbols-outlined text-sm">{showPastWork ? "expand_less" : "expand_more"}</span>Past Work ({completedPapers.length})</button>{showPastWork && <div className="space-y-2">{completedPapers.slice(0, 10).map(p => { const pct = scorePct(p); return <div key={p.id} onClick={() => router.push(`/exam/${p.id}/review?userId=${userId}`)} className="flex items-center gap-3 p-3 bg-white rounded-xl shadow-sm cursor-pointer"><div className="w-9 h-9 rounded-lg bg-[#eff4ff] flex items-center justify-center text-[#001e40] shrink-0"><span className="material-symbols-outlined text-base">{paperIcon(p)}</span></div><div className="flex-1 min-w-0"><p className="font-bold text-xs text-[#001e40] truncate">{p.title}</p><p className="text-[10px] text-[#43474f]">{relativeDate(p.completedAt!)}</p></div>{pct !== null && <span className={`font-extrabold text-xs ${pct >= 75 ? "text-[#006c49]" : pct >= 50 ? "text-[#d58d00]" : "text-[#ba1a1a]"}`}>{pct}%</span>}</div>; })}</div>}</section>}
        </div>
      </div>


      {/* ── Quiz Setup Modal ─────────────────────────────────────────────── */}
      {showQuizSetup && (
        <div className="fixed inset-0 bg-black/40 flex items-end justify-center z-50 p-4 pb-20" onClick={() => setShowQuizSetup(false)}>
          <div className="bg-white rounded-3xl w-full max-w-lg p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="font-headline font-extrabold text-lg text-[#003366] mb-4">Daily Quiz</h3>
            <p className="text-xs font-extrabold text-[#43474f] uppercase tracking-wider mb-2">Subject</p>
            <div className="flex gap-2 mb-4">
              {(["math", "science", "english"] as const).map(s => (
                <button key={s} onClick={() => setQuizSubject(s)}
                  className={`flex-1 py-2.5 rounded-xl border-2 text-sm font-medium transition-all ${quizSubject === s ? "border-[#006c49] bg-[#006c49]/5 text-[#006c49]" : "border-slate-200 text-slate-600"}`}>
                  {s === "math" ? "Math" : s === "science" ? "Science" : "English"}
                </button>
              ))}
            </div>
            <p className="text-xs font-extrabold text-[#43474f] uppercase tracking-wider mb-2">Type</p>
            {quizSubject !== "english" ? (
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
            ) : (
              <div className="mb-6">
                <p className="text-[10px] text-[#43474f] mb-3">Select sections to include:</p>
                <div className="space-y-2">
                  {[
                    { key: "grammar-mcq", label: "Grammar MCQ" },
                    { key: "vocab-mcq", label: "Vocabulary MCQ" },
                    { key: "vocab-cloze", label: "Vocabulary Cloze" },
                    { key: "visual-text", label: "Visual Text" },
                    { key: "grammar-cloze", label: "Grammar Cloze" },
                    { key: "editing", label: "Editing" },
                    { key: "comprehension-cloze", label: "Comprehension Cloze" },
                    { key: "synthesis", label: "Synthesis" },
                    { key: "comprehension-oeq", label: "Comprehension OEQ" },
                  ].map(s => (
                    <label key={s.key} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={englishSections.has(s.key)}
                        onChange={() => {
                          setEnglishSections(prev => {
                            const next = new Set(prev);
                            next.has(s.key) ? next.delete(s.key) : next.add(s.key);
                            return next;
                          });
                        }}
                        className="w-4 h-4 accent-[#006c49] rounded"
                      />
                      <span className="text-sm text-[#001e40]">{s.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
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

      {/* ── Link Parent Modal ────────────────────────────────────────────── */}
      {showLinkModal && (
        <div className="fixed inset-0 bg-black/40 flex items-end justify-center z-50 p-4 pb-6" onClick={() => setShowLinkModal(false)}>
          <div className="bg-white rounded-3xl w-full max-w-lg p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h3 className="font-headline font-extrabold text-lg text-[#003366]">Link with Parent</h3>
              <button onClick={() => setShowLinkModal(false)} className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center">
                <span className="material-symbols-outlined text-slate-500 text-base">close</span>
              </button>
            </div>
            {/* Tabs */}
            <div className="flex gap-1 bg-slate-100 p-1 rounded-xl mb-5">
              {(["share", "enter"] as const).map(t => (
                <button key={t} onClick={() => { setLinkTab(t); if (t === "share" && !myCode) fetchMyCode(); }}
                  className={`flex-1 py-2 rounded-lg text-sm font-bold transition-all ${linkTab === t ? "bg-white text-[#003366] shadow-sm" : "text-slate-500"}`}>
                  {t === "share" ? "My Code" : "Enter Code"}
                </button>
              ))}
            </div>
            {linkTab === "share" ? (
              <div className="text-center">
                <p className="text-xs text-slate-400 mb-4">Share this code with your parent so they can link with you.</p>
                {myCodeLoading ? (
                  <div className="h-16 flex items-center justify-center">
                    <div className="animate-spin rounded-full h-6 w-6 border-2 border-slate-200 border-t-[#003366]" />
                  </div>
                ) : myCode ? (
                  <>
                    <div className="bg-[#eff4ff] rounded-2xl py-5 px-6 mb-4">
                      <p className="font-mono text-4xl font-extrabold text-[#003366] tracking-[0.3em]">{myCode}</p>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => navigator.clipboard.writeText(myCode)}
                        className="flex-1 py-2.5 rounded-xl border-2 border-slate-200 text-sm font-semibold text-slate-600 flex items-center justify-center gap-1.5">
                        <span className="material-symbols-outlined text-base">content_copy</span>Copy
                      </button>
                      <button onClick={() => { setMyCode(null); fetchMyCode(); }}
                        className="flex-1 py-2.5 rounded-xl border-2 border-slate-200 text-sm font-semibold text-slate-600 flex items-center justify-center gap-1.5">
                        <span className="material-symbols-outlined text-base">refresh</span>Refresh
                      </button>
                    </div>
                    <p className="text-[10px] text-slate-300 mt-3">Code expires in 24 hours</p>
                  </>
                ) : (
                  <button onClick={fetchMyCode} className="px-6 py-3 rounded-xl bg-[#003366] text-white text-sm font-bold">Generate Code</button>
                )}
              </div>
            ) : (
              <div>
                <p className="text-xs text-slate-400 mb-3">Enter the code from your parent.</p>
                <div className="flex gap-2 mb-3">
                  <input type="text" value={enterCode}
                    onChange={e => { setEnterCode(e.target.value.toUpperCase()); setEnterError(""); }}
                    placeholder="XXXXXX" maxLength={6}
                    className="flex-1 px-4 py-3 rounded-xl border-2 border-slate-200 focus:border-[#003366] focus:outline-none text-center font-mono text-2xl tracking-widest uppercase" />
                  <button onClick={handleEnterCode} disabled={enterLoading || enterCode.length < 6}
                    className="px-5 rounded-xl bg-[#003366] text-white font-bold disabled:opacity-50">
                    {enterLoading ? "..." : "Link"}
                  </button>
                </div>
                {enterError && <p className="text-xs text-red-500">{enterError}</p>}
                {enterSuccess && <p className="text-xs text-[#006c49] font-semibold">Linked successfully!</p>}
              </div>
            )}
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
