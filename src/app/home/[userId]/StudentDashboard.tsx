"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ExamPaperSummary, User } from "@/types";
import { playClick, playExp } from "@/lib/sfx";
import { canSeeMasterClass } from "@/lib/master-class-access";
import TrialReminder from "@/components/TrialReminder";
import DocumentScanner from "@/components/DocumentScanner";
import ScannerErrorBoundary from "@/components/ScannerErrorBoundary";

// Experience bar: 100 points per level. 435 pts → Lvl 4, 35% into Lvl 5.
const POINTS_PER_LEVEL = 100;

// Habitats & pets — unlocks at 200 points. First habitat awarded: Jungle.
const HABITAT_UNLOCK_POINTS = 200;
const FIRST_HABITAT = { id: "jungle", name: "Jungle", image: "/avatars/landscape_jungle_thumb.webp" };

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
  // Only surface a percentage once the paper is fully marked. A
  // mid-deploy kill leaves the marker writing a partial score AND
  // status="failed" (the safety net at the end of markExamPaper) —
  // OR leaves status="in_progress" with stale score from a previous
  // run. Either way the number is misleading; show "Incomplete
  // marking" instead by returning null here.
  if (paper.markingStatus !== "complete" && paper.markingStatus !== "released") return null;
  if (paper.score === null || !paper.totalMarks) return null;
  // Match the review-page formula: subtract skipped marks from the
  // denominator so a student isn't penalised for questions they
  // chose not to attempt. `paper.skippedMarks` is sum of
  // marksAvailable for questions marked __SKIPPED__. Falls back to
  // 0 when the API didn't surface it.
  const totalRaw = parseFloat(paper.totalMarks);
  const denom = Math.max(0, totalRaw - (paper.skippedMarks ?? 0));
  if (denom === 0) return null;
  return Math.round((paper.score / denom) * 100);
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

function ExperienceBar({ points, level, progressPct, justUpdated, wide, crystals, showCrystals }: {
  points: number;
  level: number;
  progressPct: number;
  justUpdated: boolean;
  wide?: boolean;
  crystals: number;
  showCrystals: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <div
        data-xp-bar
        className={`relative flex flex-col gap-1 bg-[#e5eeff] text-[#001e40] rounded-2xl px-4 py-2.5 ${wide ? "min-w-[220px] lg:min-w-[280px]" : "min-w-[150px]"}`}
        style={{ animation: justUpdated ? "xpBarPulse 1.2s ease-out 4" : undefined }}
      >
        <div className="flex items-center justify-between text-xs font-extrabold tracking-wider">
          <span className="flex items-center gap-1.5">
            <span className="material-symbols-outlined text-base text-[#003366]" style={{ fontVariationSettings: "'FILL' 1" }}>bolt</span>
            {points} pts
          </span>
          <span className="text-[#003366]">Lvl {level}</span>
        </div>
        <div className="relative h-2.5 rounded-full bg-white/80 overflow-hidden">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-[#6cf8bb] via-[#34d399] to-[#006c49] transition-[width] duration-500 ease-out"
            style={{ width: `${Math.max(0, Math.min(100, progressPct))}%` }}
          />
        </div>
      </div>
      {showCrystals && (
        <div className="flex items-center gap-1.5 bg-[#e5eeff] text-[#001e40] rounded-2xl px-3 self-stretch" title="Crystals — earned per parent-reviewed quiz">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/stickers/crystal_t.PNG" alt="crystal" className="w-7 h-7 object-contain" />
          <span className="text-sm font-extrabold">{crystals}</span>
        </div>
      )}
    </div>
  );
}

// Pick whichever rendered XP bar is actually visible on screen. Both the
// desktop and mobile variants mount simultaneously (responsive classes hide
// one via display:none), so a single React ref would race; querySelector
// finds every instance and we keep the one with a non-zero rect.
function findVisibleXpBar(): DOMRect | null {
  if (typeof document === "undefined") return null;
  const els = document.querySelectorAll<HTMLElement>("[data-xp-bar]");
  for (const el of els) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return rect;
  }
  return null;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function StudentDashboard({
  userId,
  user,
  firstQuiz,
  examPapers,
  setExamPapers,
}: {
  userId: string;
  user: User;
  firstQuiz?: boolean;
  // Owned by page.tsx so the SWR/localStorage prime + polling lives in
  // one place. StudentDashboard reads + dispatches via setters.
  // Spelling tests no longer flow through — the home page used to
  // pull /api/tests just to count them in an unused AI-tip; the
  // dedicated /spelling page owns the list now.
  examPapers: ExamPaperSummary[];
  setExamPapers: React.Dispatch<React.SetStateAction<ExamPaperSummary[]>>;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Rename modal — click the user's name in the side panel to open.
  // PATCHes /api/users with { displayName }. The login username
  // (`name`) is immutable post-signup; only the display label changes.
  const [showRename, setShowRename] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameSaving, setRenameSaving] = useState(false);
  async function submitRename() {
    const trimmed = renameValue.trim();
    if (trimmed.length < 2) { setRenameError("Too short"); return; }
    const currentDisplay = user.displayName ?? user.name;
    if (trimmed === currentDisplay) { setShowRename(false); return; }
    setRenameSaving(true);
    setRenameError(null);
    try {
      const res = await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, displayName: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRenameError(data.error ?? "Could not save");
        return;
      }
      setShowRename(false);
      window.location.reload();
    } catch {
      setRenameError("Could not save");
    } finally {
      setRenameSaving(false);
    }
  }
  // Avatar gating: requires BOTH (a) the parent has explicitly enabled it on the
  // student's settings (settings.avatar === true) AND (b) the student has earned
  // the 100-point unlock threshold. New students start with avatar off.
  const parentAllowedAvatar = user.settings?.avatar === true;
  const avatarType = (user.settings as Record<string, unknown> | null)?.avatarType as string | undefined ?? "bunny";
  const whitetigerUnlocked = (user.settings as Record<string, unknown> | null)?.whitetiger === true;
  // One-time celebration popup. Set settings.whitetigerCelebrate=true
  // (admin grant or future automatic trigger) and the student sees a
  // congratulatory modal once; dismissal PATCHes the flag back to
  // false so it doesn't repeat.
  const [showWhitetigerCelebrate, setShowWhitetigerCelebrate] = useState(
    () => (user.settings as Record<string, unknown> | null)?.whitetigerCelebrate === true,
  );
  async function dismissWhitetigerCelebrate() {
    setShowWhitetigerCelebrate(false);
    try {
      await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, settings: { whitetigerCelebrate: false } }),
      });
    } catch {
      // Best-effort — if the PATCH fails the popup just shows again next visit.
    }
  }
  const [avatarSrc, setAvatarSrc] = useState(() => `/avatars/${avatarType}${Math.floor(Math.random() * 4) + 1}.mp4`);
  const [nextAvatarSrc, setNextAvatarSrc] = useState<string | null>(null);
  // Mobile avatar uses `loop` and picks a single clip on mount. Keeping it on
  // its own state means the desktop layout's onEnded → swap cascade can't
  // reload the mobile video and flash a blank frame between sources.
  const [mobileAvatarSrc] = useState(() => `/avatars/${avatarType}${Math.floor(Math.random() * 4) + 1}.mp4`);
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

  // tests + examPapers now flow in from page.tsx (owned at that
  // level so SWR cache priming + 30 s polling lives in one place).
  // In-app scanner target — opens the DocumentScanner overlay for
  // self-serve scan-back of a paper the parent already printed. Only
  // appears on assignments whose printedAt is set.
  const [scannerTarget, setScannerTarget] = useState<{
    masterPaperId: string;
    paperTitle: string;
  } | null>(null);
  // Admin viewer escape hatch: an admin looking at a student's home
  // needs to be able to force a re-mark on a paper whose marker got
  // stuck in_progress. The card itself stays inert for the student;
  // this just toggles whether the small Re-mark pill renders next to
  // "MARKING…". Authoritative session-cookie check on the API.
  const [isAdminViewer, setIsAdminViewer] = useState(false);
  useEffect(() => {
    fetch("/api/admin/check").then(r => setIsAdminViewer(r.ok)).catch(() => setIsAdminViewer(false));
  }, []);
  const [forcingRemark, setForcingRemark] = useState<string | null>(null);
  async function forceRemark(paperId: string) {
    if (!confirm("Force a re-mark on this paper?")) return;
    setForcingRemark(paperId);
    try {
      const res = await fetch(`/api/exam/${paperId}/mark`, { method: "POST" });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        alert(`Re-mark failed (HTTP ${res.status}): ${body || "no body"}`);
        return;
      }
      // Refetch the papers so the card flips back to "Marking…" with
      // a fresh timestamp; the user sees the request landed.
      fetch(`/api/exam?userId=${userId}`).then(r => r.json()).then(d => setExamPapers(d.papers ?? [])).catch(() => {});
    } catch (err) {
      alert(`Re-mark failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setForcingRemark(null);
    }
  }
  // Admin/test overrides: extra points/crystals added on top of earned ones.
  const bonusPoints = ((user.settings as Record<string, unknown> | null)?.bonusPoints as number | undefined) ?? 0;
  const bonusCrystals = ((user.settings as Record<string, unknown> | null)?.bonusCrystals as number | undefined) ?? 0;
  // Avatar gate: parent permission AND >= 100 earned points. Computed here so
  // it's available to the milestone useEffect below.
  // Skip compiled-revision papers (admin "Revise Work" output) so
  // they don't double-count past attempts towards the points total
  // / avatar / habitats unlock.
  const earnedPoints = examPapers.filter(p => p.completedAt && !p.isRevision).reduce((sum, p) => sum + (p.score ?? 0), 0) + bonusPoints;
  const hasAvatar = parentAllowedAvatar && earnedPoints >= 100;
  // (removed showFirstQuizPopup — merged with showAccountInfo into a
  // single first-visit modal.)
  const [showPointsMilestone, setShowPointsMilestone] = useState(false);
  const [milestoneMessage, setMilestoneMessage] = useState("");
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const [selectedAvatar, setSelectedAvatar] = useState<string | null>(null);
  const [savingAvatar, setSavingAvatar] = useState(false);
  const [quizBadge, setQuizBadge] = useState<{ badge: string; image: string; count: number; streak: number } | null>(null);
  const [aiTip, setAiTip] = useState<string | null>(null);
  // Unified Quiz / Focused Practice modal — mirrors ParentDashboard's
  // QuizModal (single modal with a Daily Quiz ↔ Focused Practice pill
  // toggle) so the student-side picker matches the parent-side picker
  // visually and behaviourally. Two former modals (showFocusedSetup
  // and showQuizSetup) are collapsed into one driven by assignMode.
  const [showQuizSetup, setShowQuizSetup] = useState(false);
  const [assignMode, setAssignMode] = useState<"quiz" | "focused">("quiz");
  const [quizSubject, setQuizSubject] = useState<"math" | "science" | "english">("math");
  const [quizType, setQuizType] = useState<"mcq" | "mcq-oeq">("mcq");
  const [focusedType, setFocusedType] = useState<"mcq" | "mcq-oeq">("mcq");
  const [englishSections, setEnglishSections] = useState<Set<string>>(new Set(["grammar-mcq", "vocab-mcq", "vocab-cloze"]));
  // Focused practice: topic list comes from /api/student-progress so
  // the weakest-topic ranking + dropdown reflect the student's own
  // performance. Subject is taken from `quizSubject` (shared with
  // Daily Quiz) — same UX as parent.
  const [focusedTopic, setFocusedTopic] = useState<string>("");
  const [focusedTopics, setFocusedTopics] = useState<{ topic: string; pct: number; sample: number }[]>([]);
  useEffect(() => {
    if (!showQuizSetup) return;
    if (assignMode !== "focused") return;
    if (quizSubject !== "math" && quizSubject !== "science") return;
    fetch(`/api/student-progress?studentId=${userId}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        const subjBucket = quizSubject === "math" ? "Math" : "Science";
        const subjData = d.subjects?.[subjBucket];
        if (!subjData) { setFocusedTopics([]); return; }
        const rows = Object.entries(subjData.topics as Record<string, { earned: number; available: number; count: number }>)
          .filter(([t]) => t !== "Untagged")
          .map(([t, v]) => ({ topic: t, pct: v.available > 0 ? Math.round((v.earned / v.available) * 100) : 0, sample: v.count }))
          .sort((a, b) => a.pct - b.pct);
        setFocusedTopics(rows);
      })
      .catch(() => setFocusedTopics([]));
  }, [showQuizSetup, assignMode, quizSubject, userId]);
  const [creatingQuiz, setCreatingQuiz] = useState(false);
  const [badgeToast, setBadgeToast] = useState(false);
  type QuestionNotif = { kind: "question"; questionId: string; questionNum: string; adminReply: string; paperTitle: string; transcribedStem: string | null; flagText: string | null; crystalAwarded: boolean };
  type FeedbackNotif = { kind: "feedback"; feedbackId: string; originalMessage: string; adminReply: string; adminRepliedAt: string | null };
  type AdminNotif = QuestionNotif | FeedbackNotif;
  const [adminNotifs, setAdminNotifs] = useState<AdminNotif[]>([]);
  const [showAdminNotifs, setShowAdminNotifs] = useState(false);
  // First-visit reminder: students often share an account with their
  // parent and don't realise theirs is separate. Show a one-time
  // popup making the split explicit. Tracked per-user in
  // localStorage so it doesn't reappear on every reload.
  const [showAccountInfo, setShowAccountInfo] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkTab, setLinkTab] = useState<"share" | "enter">("share");
  const [myCode, setMyCode] = useState<string | null>(null);
  const [myCodeLoading, setMyCodeLoading] = useState(false);
  const [enterCode, setEnterCode] = useState("");
  const [enterLoading, setEnterLoading] = useState(false);
  const [enterError, setEnterError] = useState("");
  const [enterSuccess, setEnterSuccess] = useState(false);
  const [activeNav, setActiveNav] = useState<"home" | "scan" | "quiz" | "master">("home");
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showPastWork, setShowPastWork] = useState(false);
  const [pastWorkLimit, setPastWorkLimit] = useState(10);

  // "Points flowing in" animation after completing/reviewing a quiz.
  // The review page sends us back with ?newPoints=20&fromPaper=<id>. We hold
  // the display counter at (total - newPoints) until the bubbles land, then
  // tick it up to total. localStorage stops a refresh/back-button from
  // replaying the animation.
  const animationTriggeredRef = useRef(false);
  const [displayPoints, setDisplayPoints] = useState<number | null>(null);
  const [barPulsing, setBarPulsing] = useState(false);
  const [bubbles, setBubbles] = useState<Array<{ id: number; marks: number; startX: number; startY: number; endX: number; endY: number; delay: number }>>([]);
  const [showArena, setShowArena] = useState(false);
  const hasArena = (user.settings as Record<string, unknown> | null)?.pvp === true;
  // Habitats feature — ON by default. Parents can turn it off in Student Settings.
  const habitatsEnabled = (user.settings as Record<string, unknown> | null)?.habitats !== false;
  const [showHabitatUnlock, setShowHabitatUnlock] = useState(false);
  const studentQuizMode = ((user.settings as Record<string, unknown> | null)?.studentQuizMode as string) ?? "all";
  const canCreateQuiz = studentQuizMode !== "none";
  // Fixed battle sequence: attack, attack, defend, attack, kill
  const arenaPairs = [
    { avatar: "attack", slime: "hit" },
    { avatar: "attack", slime: "hit" },
    { avatar: "defend", slime: "attack" },
    { avatar: "attack", slime: "hit" },
    { avatar: "ready", slime: "dead" },
  ] as const;
  const arenaActions = arenaPairs;
  const [arenaAction, setArenaAction] = useState(0);
  const [arenaGifReady, setArenaGifReady] = useState(true);
  const [showSlash, setShowSlash] = useState(false);
  const [showShield, setShowShield] = useState(false);
  const [monster, setMonster] = useState<"slime" | "mushroom">("slime");
  // map arena "slime" action names to mushroom file names (dead → die)
  const mushroomAct = (a: string) => (a === "dead" ? "die" : a);
  // Preload all arena GIFs
  // Fight avatar resolution — pick the right prefix/extension for the player's avatar type.
  // bunny: gif, tiered (ha unlocked at 200 pts); bear: gif la only; tiger/fox: mp4 la only.
  function fightAvatarCfg(type: string, points: number): { prefix: string; ext: "gif" | "mp4"; isVideo: boolean } {
    const haEligible = type === "bunny" && points >= 200;
    const tier = haEligible ? "ha" : "la";
    if (type === "bear") return { prefix: `/avatars/Fight/bear_la`, ext: "gif", isVideo: false };
    if (type === "tiger") return { prefix: `/avatars/Fight/tiger_la`, ext: "mp4", isVideo: true };
    if (type === "fox") return { prefix: `/avatars/Fight/fox_la`, ext: "mp4", isVideo: true };
    if (type === "otter") return { prefix: `/avatars/Fight/otter_la`, ext: "mp4", isVideo: true };
    return { prefix: `/avatars/Fight/bunny_${tier}`, ext: "gif", isVideo: false };
  }

  // Preload all arena fight assets for the player's avatar type + slime + mushroom
  useEffect(() => {
    if (!hasArena) return;
    for (const tier of ["la", "ha"]) {
      for (const act of ["ready", "attack", "defend", "hit"]) {
        const img = new Image();
        img.src = `/avatars/Fight/bunny_${tier}_${act}.gif`;
      }
    }
    for (const act of ["ready", "attack", "defend", "hit"]) {
      const img = new Image();
      img.src = `/avatars/Fight/bear_la_${act}.gif`;
    }
    for (const brand of ["tiger", "fox", "otter"]) {
      for (const act of ["ready", "attack", "defend", "hit"]) {
        const v = document.createElement("video");
        v.src = `/avatars/Fight/${brand}_la_${act}.mp4`;
        v.preload = "auto";
      }
    }
    for (const act of ["attack", "hit", "dead"]) {
      const img = new Image();
      img.src = `/avatars/Fight/slime_${act}.gif`;
    }
    // Preload mushroom videos (mp4)
    for (const act of ["attack", "hit", "die"]) {
      const v = document.createElement("video");
      v.src = `/avatars/Fight/mushroom_${act}.mp4`;
      v.preload = "auto";
    }
    const slashImg = new Image();
    slashImg.src = "/avatars/Fight/slash.gif";
  }, [hasArena]);

  // Trigger slash 1s after avatar attacks
  useEffect(() => {
    if (!showArena || !hasArena) return;
    const currentPair = arenaPairs[arenaAction];
    if (currentPair.avatar !== "attack") { setShowSlash(false); return; }
    const t1 = setTimeout(() => setShowSlash(true), 1000);
    const t2 = setTimeout(() => setShowSlash(false), 1500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [arenaAction, showArena, hasArena, arenaPairs]);

  // Trigger shield while avatar defends
  useEffect(() => {
    if (!showArena || !hasArena) return;
    const currentPair = arenaPairs[arenaAction];
    if (currentPair.avatar !== "defend") { setShowShield(false); return; }
    const t1 = setTimeout(() => setShowShield(true), 500);
    const t2 = setTimeout(() => setShowShield(false), 2500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [arenaAction, showArena, hasArena, arenaPairs]);
  useEffect(() => {
    if (!showArena || !hasArena) return;
    const interval = setInterval(() => {
      setArenaGifReady(false);
      setArenaAction(prev => {
        const next = (prev + 1) % arenaPairs.length;
        // When we loop back to 0, swap to the other monster
        if (next === 0) setMonster(m => (m === "slime" ? "mushroom" : "slime"));
        return next;
      });
    }, 3000);
    return () => clearInterval(interval);
  }, [showArena, hasArena, arenaPairs.length]);
  const [arenaData, setArenaData] = useState<{ leaderboard: Array<{ id: string; name: string; points: number; pct: number }>; playerRank: number | null; playerEntry: { id: string; name: string; points: number; pct: number } | null } | null>(null);

  // Mount fetch + visibility/focus/popstate listeners + 30 s poll used
  // to live here AND on page.tsx — two parallel /api/exam + /api/tests
  // round-trips and two pollers per student visit. page.tsx now owns
  // all of them (with SWR-prime from localStorage), so we just read
  // the data + dispatch through the setter props.

  // (firstQuiz popup removed — accountInfo popup now covers both
  // the welcome-with-first-quiz message and the parent-vs-student
  // account reminder. accountInfo trigger remains below.)

  useEffect(() => {
    fetch(`/api/user/${userId}/quiz-badge`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.badge) setQuizBadge({ badge: d.badge, image: d.badgeImage, count: d.completedQuizzes, streak: d.streak ?? 0 }); })
      .catch(() => {});
  }, [userId]);

  // Check point milestones (only if avatar toggle is on)
  useEffect(() => {
    if (!hasAvatar || examPapers.length === 0) return;
    const pts = examPapers.filter(p => p.completedAt && !p.isRevision).reduce((sum, p) => sum + (p.score ?? 0), 0) + bonusPoints;
    const milestones = [
      { points: 100, key: `points-milestone-100-${userId}`, msg: "You have scored more than 100 points. You can now select your profile avatar!" },
      { points: 500, key: `points-milestone-500-${userId}`, msg: "You have scored more than 500 points! A new **Fox** avatar has been unlocked!" },
      { points: 750, key: `points-milestone-750-${userId}`, msg: "You have scored more than 750 points! A new **Otter** avatar has been unlocked!" },
      { points: 250, key: `points-milestone-250-${userId}`, msg: "You have scored more than 250 points! A new **Tiger** avatar has been unlocked!" },
      { points: 1000, key: `points-milestone-1000-${userId}`, msg: "You have scored more than 1000 points! A new **Unicorn** avatar has been unlocked!" },
      { points: 1250, key: `points-milestone-1250-${userId}`, msg: "You have scored more than 1250 points! A new **Dragon** avatar has been unlocked!" },
      { points: 1500, key: `points-milestone-1500-${userId}`, msg: "You have scored more than 1500 points! A new **Merlion** avatar has been unlocked!" },
      { points: 1750, key: `points-milestone-1750-${userId}`, msg: "You have scored more than 1750 points! The legendary **Qilin** avatar has been unlocked!" },
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

  // Fetch arena leaderboard
  useEffect(() => {
    if (!hasArena) return;
    fetch(`/api/arena?studentId=${userId}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setArenaData(d); })
      .catch(() => {});
  }, [hasArena, userId]);

  // Fetch admin notifications — flagged-question replies AND feedback
  // replies are bundled in one response since 2026-06; merge both into
  // the popup so a kid sees every admin response at once.
  useEffect(() => {
    fetch(`/api/notifications?userId=${userId}`)
      .then(r => r.ok ? r.json() : { questions: [], feedback: [] })
      .then((data: { questions: QuestionNotif[]; feedback: FeedbackNotif[] }) => {
        const merged: AdminNotif[] = [...(data.questions ?? []), ...(data.feedback ?? [])];
        if (merged.length > 0) { setAdminNotifs(merged); setShowAdminNotifs(true); }
      })
      .catch(() => {});
  }, [userId]);

  // First-visit account-info popup. Persisted on user.settings so
  // dismissal sticks across devices / browsers / Capacitor WebView.
  // Falls back to localStorage if the settings flag isn't set yet
  // (legacy users who dismissed before this change shipped).
  //
  // Also suppressed once the kid has completed at least one paper —
  // the 'Your first quiz is ready. Click on the quiz below to begin.'
  // copy is stale in that case and shouldn't fire on subsequent
  // logins.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const settings = (user.settings as Record<string, unknown> | null) ?? {};
    const dbSeen = settings.studentAccountInfoSeen === true;
    const seenKey = `mfy_studentAccountInfoSeen_${userId}`;
    const localSeen = window.localStorage.getItem(seenKey) === "1";
    if (dbSeen || localSeen) return;
    const hasCompletedPaper = examPapers.some(p => p.markingStatus === "complete" || p.markingStatus === "released");
    if (hasCompletedPaper) return;
    const t = setTimeout(() => setShowAccountInfo(true), 600);
    return () => clearTimeout(t);
  }, [userId, user.settings, examPapers]);

  // `name` is the immutable login username; `displayName` is the
  // mutable greeting label. Falls back to the username when not set.
  const displayName = user.displayName ?? user.name;

  // Generate a simple AI tip from available data. Previously this
  // branched on the spelling-test count too, but /api/tests is no
  // longer fetched on the home page — for users with at least one
  // paper we now show the generic encouragement instead.
  useEffect(() => {
    if (examPapers.length === 0) return;
    const name = displayName.split(" ")[0];
    setAiTip(`${name}, start by scanning your spelling list — AI will correct it in seconds!`);
  }, [examPapers, displayName]);

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
    const normalised = enterCode.trim().toUpperCase();
    if (normalised.length < 6) return;
    setEnterLoading(true); setEnterError("");
    try {
      const res = await fetch("/api/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: normalised, userId }),
      });
      const data = await res.json();
      if (!res.ok) { setEnterError(data.error || "Invalid code"); return; }
      setEnterSuccess(true);
      setTimeout(() => { window.location.reload(); }, 1500);
    } catch { setEnterError("Something went wrong"); }
    finally { setEnterLoading(false); }
  }

  async function handleDeletePaper(e: React.MouseEvent, paperId: string) {
    e.stopPropagation();
    if (!confirm("Delete this quiz/practice?")) return;
    try {
      await fetch(`/api/exam/${paperId}?userId=${userId}`, { method: "DELETE" });
      // Refetch the full papers list — the weekly scheduler, recent
      // activities feed, and the count chips all derive from this state,
      // and a local filter+set leaves any server-side rollup (e.g.
      // attempted-this-week badges) stale until the next mount.
      const r = await fetch(`/api/exam?userId=${userId}`);
      if (r.ok) setExamPapers(((await r.json()).papers ?? []) as ExamPaperSummary[]);
    } catch { /* silent fail */ }
  }

  async function startQuiz() {
    // Unified dispatcher — mirrors ParentDashboard's QuizModal submit
    // branch. Daily Quiz hits /api/daily-quiz; Focused Practice hits
    // /api/focused-test for Math/Science (topic + type) and
    // /api/daily-quiz with focused:true for English (single-section
    // doubled quiz).
    setCreatingQuiz(true);
    try {
      if (assignMode === "focused") {
        if (quizSubject === "english") {
          if (englishSections.size !== 1) { alert("Pick exactly one section"); return; }
          const res = await fetch("/api/daily-quiz", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userId,
              quizType: "mcq",
              subject: "english",
              englishSections: [...englishSections],
              focused: true,
            }),
          });
          const data = await res.json();
          if (!res.ok) { alert(data.error || "Failed to create practice"); return; }
          setShowQuizSetup(false);
          fetch(`/api/exam?userId=${userId}`).then(r => r.json()).then(d => setExamPapers(d.papers ?? [])).catch(() => {});
          return;
        }
        // Math / Science focused
        if (!focusedTopic) { alert("Pick a topic"); return; }
        const subject = quizSubject === "math" ? "Mathematics" : "Science";
        const res = await fetch("/api/focused-test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parentId: userId, studentId: userId, subject, topic: focusedTopic, type: focusedType }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { alert(data.error ?? `Create failed (HTTP ${res.status})`); return; }
        setShowQuizSetup(false);
        setFocusedTopic("");
        fetch(`/api/exam?userId=${userId}`).then(r => r.json()).then(d => setExamPapers(d.papers ?? [])).catch(() => {});
        return;
      }
      // Daily Quiz branch
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

  // Compiled "revise work" papers come in two flavours:
  //   - REVIEW mode  (parent picked "Compile and review") -- born
  //     completedAt + markingStatus=complete; a static rollup the
  //     parent and child go through together. Hide from the kid's
  //     home so they don't see "0%" / "complete" on a paper they
  //     never sat.
  //   - PRACTICE mode (parent picked "Compile and set paper")  --
  //     born blank, completedAt=null. The kid is supposed to attempt
  //     it. Previously the bare `!p.isRevision` filter hid these
  //     too, which broke the entire "set paper" flow -- a parent
  //     would click Compile and set paper but the quiz never showed
  //     up on the child's account (canonical case: Nilohoo set
  //     paper cmqf6z1l2000uqs2gzd930z3j for LohXY2014, never
  //     appeared). Narrow the exclusion to only completed revisions
  //     so practice ones reach the todo list.
  // Points / arena math below still uses `!p.isRevision` on both
  // flavours, so neither double-counts toward avatar / habitat
  // unlocks.
  const studentPapers = examPapers.filter(p => !(p.isRevision && p.completedAt));
  const todoPapers = studentPapers.filter(p => !p.completedAt && p.markingStatus !== "released");
  const completedPapers = studentPapers
    .filter(p => p.completedAt || p.markingStatus === "released")
    .sort((a, b) => {
      const aTime = a.completedAt ? new Date(a.completedAt).getTime() : 0;
      const bTime = b.completedAt ? new Date(b.completedAt).getTime() : 0;
      return bTime - aTime;
    });

  const totalPoints = completedPapers.reduce((sum, p) => sum + (p.score ?? 0), 0) + bonusPoints;
  // Crystals = number of parent-reviewed (released) quizzes / papers. Used as
  // the currency for unlocking additional habitats + pets down the road.
  const spentCrystals = ((user.settings as Record<string, unknown> | null)?.spentCrystals as number | undefined) ?? 0;
  // Clamp at 0 — if a quiz is un-released or admin reduces bonusCrystals
  // below what was already spent, the raw subtraction can go negative.
  // The display should never show a negative balance.
  const crystals = Math.max(0, examPapers.filter(p => p.markingStatus === "released").length + bonusCrystals - spentCrystals);
  const level = Math.floor(totalPoints / POINTS_PER_LEVEL);
  // Progress on the bar reflects the displayed (animating) points, not the
  // committed total, so the fill grows in step with the landing bubbles.
  const effectivePoints = displayPoints ?? totalPoints;
  const levelProgressPct = ((effectivePoints % POINTS_PER_LEVEL) / POINTS_PER_LEVEL) * 100;
  const displayedLevel = Math.floor(effectivePoints / POINTS_PER_LEVEL);

  // Habitat-unlock popup at 200 points — once per student.
  useEffect(() => {
    if (!habitatsEnabled) return;
    if (typeof window === "undefined") return;
    const key = `mfy-habitat-unlocked-${userId}`;
    if (localStorage.getItem(key)) return;
    if (totalPoints < HABITAT_UNLOCK_POINTS) return;
    localStorage.setItem(key, "1");
    setShowHabitatUnlock(true);
  }, [totalPoints, habitatsEnabled, userId]);

  // Trigger the points-flowing-in animation once per paper — BUT only after
  // examPapers loads and totalPoints includes the new quiz score. Initial
  // render has examPapers=[], totalPoints=0, which is why the bar was
  // settling at "0 pts Lvl 0" before the fix.
  useEffect(() => {
    if (animationTriggeredRef.current) return;
    const newPoints = parseInt(searchParams?.get("newPoints") ?? "", 10);
    const fromPaper = searchParams?.get("fromPaper") ?? "";
    if (!Number.isFinite(newPoints) || newPoints <= 0 || !fromPaper) return;
    if (typeof window === "undefined") return;
    const animKey = `mfy-points-animated-${fromPaper}`;
    if (localStorage.getItem(animKey)) return;
    // Wait until examPapers has loaded with the paper we just completed.
    if (examPapers.length === 0) return;
    if (!examPapers.some(p => p.id === fromPaper && (p.completedAt || p.markingStatus === "released"))) return;
    // Also need the visible XP bar in the DOM so we can target it with the
    // bubbles. Both mobile and desktop bars mount (one is display:none), so
    // pick whichever has a non-zero rect.
    const barRect = findVisibleXpBar();
    if (!barRect) return;

    animationTriggeredRef.current = true;
    localStorage.setItem(animKey, "1");

    // Strip the params from the URL so a refresh doesn't try to replay.
    window.history.replaceState({}, "", `/home/${userId}`);

    // Hold the counter at (total − new) so bubbles can fill it in.
    const startPoints = Math.max(0, totalPoints - newPoints);
    setDisplayPoints(startPoints);
    setBarPulsing(true);

    const bubbleCount = Math.min(Math.max(newPoints, 1), 15);
    const perBubble = Math.max(1, Math.round(newPoints / bubbleCount));
    // Start near the top-right of the viewport, land at the bar's centre.
    const startX = window.innerWidth - 48;
    const startY = 40;
    const endX = barRect.left + barRect.width / 2;
    const endY = barRect.top + barRect.height / 2;
    const spawned = [] as Array<{ id: number; marks: number; startX: number; startY: number; endX: number; endY: number; delay: number }>;
    let runningTotal = 0;
    for (let i = 0; i < bubbleCount; i++) {
      const marks = i === bubbleCount - 1 ? newPoints - runningTotal : perBubble;
      runningTotal += marks;
      spawned.push({
        id: Date.now() + i,
        marks,
        startX: startX - Math.random() * 40, // slight horizontal spread so they don't stack exactly
        startY: startY + Math.random() * 20,
        endX,
        endY,
        delay: i * 160,
      });
    }
    setBubbles(spawned);

    let running = startPoints;
    spawned.forEach((b) => {
      window.setTimeout(() => {
        running += b.marks;
        setDisplayPoints(Math.min(running, totalPoints));
        if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
          try { navigator.vibrate(20); } catch { /* ignore */ }
        }
        // Soft "whoosh" each time a bubble enters the XP bar.
        playExp();
      }, b.delay + 950);
    });
    const settleDelay = spawned[spawned.length - 1]!.delay + 1400;
    window.setTimeout(() => {
      setDisplayPoints(totalPoints);
      setBubbles([]);
      setBarPulsing(false);
    }, settleDelay);
    // NOTE: no cleanup return. The effect's deps (examPapers, totalPoints)
    // change mid-animation during normal polling; returning a cleanup that
    // clears the settle timer left barPulsing stuck at true and the glow
    // ran forever. The animation is short (~3s) and all it does is set
    // state — safe to let it run to completion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examPapers, searchParams, totalPoints]);
  const hasParent = (user.linkedParents?.length ?? 0) > 0;

  // ─── Derived data for new layout ───
  const now = new Date();
  // Use local date strings to avoid UTC timezone mismatch (e.g. SGT = UTC+8)
  const localDateStr = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const todayStr = localDateStr(now);
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const tomorrowStr = localDateStr(tomorrow);
  const paperDate = (p: ExamPaperSummary) => new Date(p.scheduledFor ?? p.createdAt ?? "");
  const paperDateStr = (p: ExamPaperSummary) => localDateStr(paperDate(p));
  const WEEKDAY_LABELS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  // Start of the current week (Monday 00:00 local). Anything before this is a prior week.
  const thisWeekStart = (() => {
    const dow = now.getDay();
    const diff = dow === 0 ? 6 : dow - 1;
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
  })();
  const weekdayLabel = (p: ExamPaperSummary) => {
    const d = paperDate(p);
    const label = WEEKDAY_LABELS[d.getDay()];
    return d < thisWeekStart ? `Last ${label}` : label;
  };

  // Today = papers scheduled for today only
  const todayActivities = studentPapers.filter(p => paperDateStr(p) === todayStr);
  const todayTodo = todayActivities.filter(p => !p.completedAt);
  const todayDone = todayActivities.filter(p => p.completedAt);
  // Homework to show: undone papers that are past-due (any age --
  // older-than-a-week stays visible) OR scheduled within the next
  // 14 days. Window bumped from "tomorrow only" to "next 2 weeks"
  // so parents who set work ahead of time know the kid sees it.
  const weekHomework = studentPapers.filter(p => {
    if (p.completedAt) return false;
    const ds = paperDateStr(p);
    if (ds === todayStr) return false;
    const d = paperDate(p);
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const twoWeeksOut = new Date(todayStart);
    twoWeeksOut.setDate(twoWeeksOut.getDate() + 14);
    return d < todayStart || (d >= todayStart && d <= twoWeeksOut);
  });

  function goToPaper(p: ExamPaperSummary) {
    playClick();
    if (p.paperType === "quiz" || p.paperType === "focused" || p.paperType === "mastery") {
      router.push(`/quiz/${p.id}?userId=${userId}`);
      return;
    }
    // English + Chinese master clones use the clean-extract quiz UI
    // even though they have no paperType — the marker is tied to the
    // text-based answer flow (not the scan-back path that other
    // subjects use). Falls back to the image-based /exam view if the
    // paper hasn't been clean-extracted yet.
    const raw = p.subject ?? "";
    const s = raw.toLowerCase();
    const isTextBasedSubject =
      s.includes("english") ||
      s.includes("chinese") ||
      raw.includes("华文") || raw.includes("中文") || raw.includes("华语");
    if (isTextBasedSubject && p.cleanExtracted) {
      router.push(`/quiz/${p.id}?userId=${userId}`);
      return;
    }
    router.push(`/exam/${p.id}?userId=${userId}`);
  }
  function paperIcon(p: ExamPaperSummary) {
    if (p.paperType === "quiz") return "quiz";
    if (p.paperType === "focused") return "psychology";
    const s = (p.subject ?? "").toLowerCase();
    return s.includes("science") ? "biotech" : s.includes("english") ? "abc" : "calculate";
  }

  return (
    <div className="bg-[#f8f9ff] font-body text-[#0b1c30] antialiased min-h-screen overflow-x-hidden">
      <TrialReminder
        userId={userId}
        subscriptionStatus={user.subscriptionStatus}
        trialEndsAtIso={user.trialEndsAt}
      />
      {/* Habitat unlock popup at 200 points */}
      {showHabitatUnlock && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[120] p-4" onClick={() => setShowHabitatUnlock(false)}>
          <div className="bg-white rounded-3xl p-8 max-w-sm w-full shadow-2xl text-center" onClick={e => e.stopPropagation()}>
            <div className="w-16 h-16 rounded-full bg-[#6cf8bb]/30 flex items-center justify-center mx-auto mb-4">
              <span className="material-symbols-outlined text-3xl text-[#006c49]" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
            </div>
            <h2 className="font-headline text-xl font-extrabold text-[#001e40] mb-2">Habitats &amp; Pets unlocked!</h2>
            <p className="text-sm text-[#43474f] mb-4">Congratulations! You are given your first habitat: <span className="font-bold text-[#006c49]">{FIRST_HABITAT.name}</span>.</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={FIRST_HABITAT.image} alt={FIRST_HABITAT.name} className="w-full rounded-2xl border-2 border-[#6cf8bb]/40 mb-5" />
            <div className="flex gap-3">
              <button onClick={() => setShowHabitatUnlock(false)} className="flex-1 py-3 rounded-xl border-2 border-[#c3c6d1] text-[#001e40] font-bold text-sm">Later</button>
              <button
                onClick={() => { setShowHabitatUnlock(false); router.push(`/habitats/${userId}`); }}
                className="flex-1 py-3 rounded-xl bg-[#006c49] text-white font-extrabold text-sm"
              >
                Visit my habitat
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Point bubbles swooping from top-right into the experience bar */}
      {bubbles.length > 0 && (
        <div className="fixed inset-0 z-[90] pointer-events-none">
          {bubbles.map(b => (
            <span
              key={b.id}
              className="absolute top-0 left-0 rounded-full bg-gradient-to-br from-[#6cf8bb] to-[#34d399] w-3 h-3 shadow-[0_2px_6px_rgba(108,248,187,0.6)]"
              style={{
                // animation-fill-mode: both — hold the 0% keyframe (start position,
                // opacity 0) during the stagger delay, otherwise the bubble renders
                // at top:0/left:0 until its turn arrives and you see dots at the
                // top-left corner. "both" covers that pre-animation gap.
                animation: `pointBubbleFly 1100ms cubic-bezier(0.4,0.9,0.5,1) ${b.delay}ms both`,
                ["--bubble-start-x" as string]: `${b.startX}px`,
                ["--bubble-start-y" as string]: `${b.startY}px`,
                ["--bubble-end-x" as string]: `${b.endX}px`,
                ["--bubble-end-y" as string]: `${b.endY}px`,
              }}
            />
          ))}
        </div>
      )}

      {/* First-time student popup */}
      {/* showFirstQuizPopup removed — message merged into the
          showAccountInfo modal below to prevent two welcome popups
          firing back-to-back on first login. */}

      {/* Points milestone — avatar selection */}
      {showPointsMilestone && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[100] p-4">
          {/* Confetti — pure-CSS burst behind the modal so the new avatar
              feels celebratory. 24 pieces falling from above with random
              colour, horizontal start, delay, duration, and rotation. */}
          <div className="pointer-events-none fixed inset-0 overflow-hidden z-[99]">
            {Array.from({ length: 24 }).map((_, i) => {
              const colors = ["#006c49", "#003366", "#d58d00", "#ba1a1a", "#6cf8bb", "#ffddb4", "#a7c8ff"];
              const color = colors[i % colors.length];
              const left = Math.round((i * 4.17) % 100);
              const delay = (i % 8) * 0.12;
              const dur = 1.6 + (i % 4) * 0.3;
              const size = 8 + (i % 3) * 4;
              const rot = (i * 47) % 360;
              return (
                <span
                  key={i}
                  style={{
                    position: "absolute",
                    top: "-24px",
                    left: `${left}%`,
                    width: `${size}px`,
                    height: `${size * 0.4}px`,
                    background: color,
                    transform: `rotate(${rot}deg)`,
                    animation: `confetti-fall ${dur}s ease-in ${delay}s forwards`,
                    borderRadius: "2px",
                  }}
                />
              );
            })}
            <style jsx>{`
              @keyframes confetti-fall {
                0% { transform: translateY(-10vh) rotate(0deg); opacity: 1; }
                80% { opacity: 1; }
                100% { transform: translateY(110vh) rotate(540deg); opacity: 0; }
              }
            `}</style>
          </div>
          <div className="relative bg-white rounded-3xl p-8 max-w-sm w-full shadow-2xl text-center z-[101]">
            <div className="w-16 h-16 rounded-full bg-[#ffddb4]/50 flex items-center justify-center mx-auto mb-4">
              <span className="material-symbols-outlined text-3xl text-[#d58d00]" style={{ fontVariationSettings: "'FILL' 1" }}>stars</span>
            </div>
            <h2 className="font-headline text-xl font-extrabold text-[#001e40] mb-2">Congratulations!</h2>
            <p className="text-sm text-[#43474f] mb-6">
              {milestoneMessage.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (
                part.startsWith("**") && part.endsWith("**")
                  ? <strong key={i} className="font-extrabold text-[#001e40]">{part.slice(2, -2)}</strong>
                  : <span key={i}>{part}</span>
              ))}
            </p>
            <div className="grid grid-cols-3 gap-3 mb-6">
              {[
                { key: "bunny", label: "Bunny", points: 0 },
                { key: "bear", label: "Bear", points: 0 },
                { key: "tiger", label: "Tiger", points: 250 },
                { key: "fox", label: "Fox", points: 500 },
                { key: "otter", label: "Otter", points: 750 },
                { key: "uni", label: "Unicorn", points: 1000 },
                { key: "dragon", label: "Dragon", points: 1250 },
                { key: "merlion", label: "Merlion", points: 1500 },
                { key: "qilin", label: "Qilin", points: 1750 },
                ...(whitetigerUnlocked ? [{ key: "whitetiger", label: "White Tiger", points: 0, special: true as const }] : []),
              ].map(animal => {
                const unlocked = "special" in animal ? true : totalPoints >= animal.points;
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
                { key: "tiger", label: "Tiger", points: 250 },
                { key: "fox", label: "Fox", points: 500 },
                { key: "otter", label: "Otter", points: 750 },
                { key: "uni", label: "Unicorn", points: 1000 },
                { key: "dragon", label: "Dragon", points: 1250 },
                { key: "merlion", label: "Merlion", points: 1500 },
                { key: "qilin", label: "Qilin", points: 1750 },
                ...(whitetigerUnlocked ? [{ key: "whitetiger", label: "White Tiger", points: 0, special: true as const }] : []),
              ].map(animal => {
                const unlocked = "special" in animal ? true : totalPoints >= animal.points;
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

      {/* First-visit reminder: merged "first quiz ready" + "account
          is separate from parent". Was previously two popups firing
          back-to-back — same trigger window, jarring on first load. */}
      {showAccountInfo && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[100] p-4">
          <div className="bg-white rounded-3xl p-6 max-w-sm w-full shadow-2xl space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-[#003366] flex items-center justify-center">
                <span className="material-symbols-outlined text-white text-lg">info</span>
              </div>
              <h3 className="font-headline font-extrabold text-[#001e40]">Welcome, {displayName.split(" ")[0]}!</h3>
            </div>
            <div className="space-y-3">
              <p className="text-sm text-[#0b1c30] leading-relaxed">
                <span className="font-extrabold">Your first quiz is ready.</span> Click on the quiz below to begin.
              </p>
              <p className="text-sm text-[#0b1c30] leading-relaxed">
                Remember: this is <span className="font-extrabold">your own account</span> — separate from your parent&apos;s. Your scores stay private to you and your parent. Always log in with <span className="font-bold text-[#001e40]">your</span> username and password.
              </p>
            </div>
            <button
              onClick={async () => {
                setShowAccountInfo(false);
                // Persist on the user row so the popup never shows again,
                // regardless of device or browser. localStorage is also
                // set as a belt-and-braces fast-path.
                if (typeof window !== "undefined") {
                  window.localStorage.setItem(`mfy_studentAccountInfoSeen_${userId}`, "1");
                }
                try {
                  await fetch("/api/users", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ userId, settings: { studentAccountInfoSeen: true } }),
                  });
                } catch {
                  // Non-fatal — localStorage covers this device.
                }
              }}
              className="w-full py-3 rounded-xl bg-[#003366] text-white font-bold">
              Got it
            </button>
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
            {adminNotifs.map(n => n.kind === "question" ? (
              <div key={`q-${n.questionId}`} className="bg-[#eff4ff] rounded-2xl px-4 py-3 space-y-2">
                <p className="text-xs text-[#43474f] font-medium">{n.paperTitle} · Q{n.questionNum}</p>
                {n.transcribedStem && (
                  <p className="text-xs text-[#43474f] italic line-clamp-3 border-l-2 border-[#c3c6d1] pl-2">{n.transcribedStem}</p>
                )}
                {n.flagText && (
                  <div className="text-xs bg-amber-50 border-l-2 border-amber-300 pl-2 py-1 rounded-r">
                    <span className="font-semibold text-amber-700">You flagged: </span>
                    <span className="text-[#001e40]">{n.flagText}</span>
                  </div>
                )}
                <p className="text-sm text-[#001e40] whitespace-pre-wrap">{n.adminReply}</p>
                {n.crystalAwarded && (
                  <div className="inline-flex items-center gap-1.5 bg-white text-[#001e40] rounded-full pl-2 pr-3 py-1 font-extrabold text-sm">
                    <span>+1</span>
                    <img src="/stickers/crystal_t.PNG" alt="crystal" className="w-5 h-5 object-contain" />
                    <span className="text-xs font-semibold">crystal</span>
                  </div>
                )}
              </div>
            ) : (
              <div key={`f-${n.feedbackId}`} className="bg-[#eff4ff] rounded-2xl px-4 py-3 space-y-2">
                <p className="text-xs text-[#43474f] font-medium">Reply to your feedback</p>
                <p className="text-xs text-[#43474f] italic line-clamp-3 border-l-2 border-[#c3c6d1] pl-2">{n.originalMessage}</p>
                <p className="text-sm text-[#001e40] whitespace-pre-wrap">{n.adminReply}</p>
              </div>
            ))}
            <button
              onClick={() => {
                // Clear local state too — otherwise the bell dot stayed
                // visible after dismissal (adminNotifs still populated),
                // and the kid would see "dot but no popup" on the next
                // nav, refresh to find it gone, and never realise they'd
                // already dismissed the actual message popup.
                setShowAdminNotifs(false);
                const questionIds = adminNotifs.filter((n): n is QuestionNotif => n.kind === "question").map(n => n.questionId);
                const feedbackIds = adminNotifs.filter((n): n is FeedbackNotif => n.kind === "feedback").map(n => n.feedbackId);
                setAdminNotifs([]);
                fetch("/api/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId, questionIds, feedbackIds }) }).catch(() => {});
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
              <div className="w-12 h-12 rounded-full bg-[#d3e4fe] flex items-center justify-center text-[#001e40] font-extrabold">{initials(displayName)}</div>
              <div>
                <button
                  onClick={() => { setRenameValue(displayName); setRenameError(null); setShowRename(true); }}
                  className="font-bold text-[#0b1c30] hover:underline cursor-pointer"
                  title="Click to change your name"
                >{displayName}</button>
                {user.linkedParents?.length > 0 && <p className="text-xs text-[#43474f]">Parent: {user.linkedParents[0].name}</p>}
              </div>
            </div>
          </div>
          <nav className="flex flex-col gap-2 text-sm font-medium font-headline">
            <button className="flex items-center gap-3 px-4 py-3 rounded-lg text-[#001e40] font-bold border-r-4 border-[#001e40] bg-blue-50/50">
              <span className="material-symbols-outlined">home</span>Home
            </button>
            <button onClick={() => router.push(`/spelling?userId=${userId}`)} className="flex items-center gap-3 px-4 py-3 rounded-lg text-slate-500 hover:bg-blue-50 transition-colors">
              <span className="material-symbols-outlined">spellcheck</span>
              {/* Desktop has room for both labels; mobile sidebar
                  is cramped so we keep just the CJK. */}
              <span className="hidden lg:inline">听写 / Spelling</span>
              <span className="inline lg:hidden">听写</span>
            </button>
            {canCreateQuiz && (
              <>
                <button onClick={() => { playClick(); setAssignMode("quiz"); setShowQuizSetup(true); }} className="flex items-center gap-3 px-4 py-3 rounded-lg text-slate-500 hover:bg-blue-50 transition-colors">
                  <span className="material-symbols-outlined">quiz</span>Quiz
                </button>
                <button onClick={() => { playClick(); setAssignMode("focused"); setShowQuizSetup(true); }} className="flex items-center gap-3 px-4 py-3 rounded-lg text-slate-500 hover:bg-blue-50 transition-colors">
                  <span className="material-symbols-outlined">psychology</span>Focused Practice
                </button>
              </>
            )}
            {/* Master Class — gated to a small allow-list for now
                until we ship to all students. Allow-list lives in
                @/lib/master-class-access — add a name there to grant. */}
            {canSeeMasterClass(user.name) && (
              <button onClick={() => router.push(`/master-class?userId=${userId}`)} className="flex items-center gap-3 px-4 py-3 rounded-lg text-slate-500 hover:bg-blue-50 transition-colors">
                <span className="material-symbols-outlined">school</span>Master Class
              </button>
            )}
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
              {/* Quiz badge icon removed for now */}
              <button onClick={async () => { try { await fetch("/api/auth", { method: "DELETE" }); } catch {} window.location.href = "/"; }} className="text-[#43474f] hover:text-[#ba1a1a] transition-colors" title="Log out">
                <span className="material-symbols-outlined">logout</span>
              </button>
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
                <h1 className="text-4xl font-extrabold text-[#001e40] mb-2 tracking-tight font-headline">{greeting()}, {displayName.split(" ")[0]}!</h1>
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
                  <ExperienceBar
                    points={effectivePoints}
                    level={displayedLevel}
                    progressPct={levelProgressPct}
                    justUpdated={barPulsing}
                    crystals={crystals}
                    showCrystals={habitatsEnabled && totalPoints >= HABITAT_UNLOCK_POINTS}
                    wide
                  />
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
                  {todayTodo.map(p => (
                    <div key={p.id} onClick={() => goToPaper(p)} className="flex items-center gap-4 p-5 bg-white rounded-2xl shadow-sm hover:shadow-md transition-shadow cursor-pointer">
                      <div className="w-6 h-6 rounded border-2 border-[#c3c6d1]" />
                      <div className="flex-1 min-w-0">
                        <span className="font-semibold text-[#0b1c30] truncate block">{p.title}</span>
                        <span className="text-[10px] text-[#43474f]">Due today</span>
                      </div>
                      <span className={`text-[10px] font-bold px-2 py-1 rounded-full shrink-0 ${p.timeSpentSeconds > 0 ? "bg-[#fef3c7] text-[#92400e]" : "bg-[#dce9ff] text-[#737780]"}`}>{p.timeSpentSeconds > 0 ? "IN PROGRESS" : "TODO"}</span>
                    </div>
                  ))}
                  {todayDone.map(p => {
                    const pct = scorePct(p);
                    // Block clicks while the marker is still running —
                    // the partial score and missing notes show up as
                    // "Q1-Q60 graded, Q61+ blank" and confuse students.
                    // Card stays visible but inert until status becomes
                    // complete/released.
                    const stillMarking = !!p.completedAt && p.markingStatus !== "complete" && p.markingStatus !== "released";
                    return (
                      <div
                        key={p.id}
                        onClick={stillMarking ? undefined : () => router.push(`/exam/${p.id}/review?userId=${userId}`)}
                        aria-disabled={stillMarking}
                        className={`flex items-center gap-4 p-5 rounded-2xl shadow-sm transition-shadow ${stillMarking ? "bg-[#eff4ff] border border-[#dce9ff] cursor-not-allowed" : "bg-[#6cf8bb]/20 border border-[#6cf8bb]/30 hover:shadow-md cursor-pointer"}`}
                      >
                        <div className={`w-6 h-6 rounded border-2 flex items-center justify-center ${stillMarking ? "border-[#737780]" : "border-[#006c49] bg-[#006c49]"}`}>
                          {stillMarking
                            ? <span className="animate-spin material-symbols-outlined text-[#737780] text-sm">progress_activity</span>
                            : <span className="material-symbols-outlined text-white text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>check</span>}
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="font-semibold text-[#0b1c30] truncate block">{p.title}</span>
                          <span className="text-[10px] text-[#43474f]">{stillMarking ? "Marking your answers…" : "Due today"}</span>
                        </div>
                        <span className="flex items-center gap-1.5 shrink-0">
                          {stillMarking ? (
                            <>
                              <span className="text-[10px] font-bold px-2 py-1 bg-[#dce9ff] text-[#001e40] rounded-full">MARKING…</span>
                              {isAdminViewer && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); forceRemark(p.id); }}
                                  disabled={forcingRemark === p.id}
                                  title="Force re-mark (admin)"
                                  className="text-[10px] font-bold text-[#003366] bg-[#dce9ff] hover:bg-[#a7c8ff] px-2 py-0.5 rounded-full transition-colors disabled:opacity-50"
                                >{forcingRemark === p.id ? "…" : "Re-mark"}</button>
                              )}
                            </>
                          ) : (
                            <>
                              <span className="text-[10px] font-bold px-2 py-1 bg-[#6cf8bb] text-[#006c49] rounded-full">DONE</span>
                              {pct !== null && (
                                <span className={`text-sm font-extrabold ${pct >= 75 ? "text-[#006c49]" : pct >= 50 ? "text-[#d58d00]" : "text-[#ba1a1a]"}`}>{pct}%</span>
                              )}
                            </>
                          )}
                        </span>
                      </div>
                    );
                  })}
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
                      <button key={p.id} type="button" onClick={() => goToPaper(p)} className="text-left bg-white p-6 rounded-3xl group cursor-pointer hover:bg-[#001e40] hover:text-white transition-all duration-300 shadow-sm">
                        <div className="w-12 h-12 rounded-2xl bg-[#006c49]/10 group-hover:bg-white/20 flex items-center justify-center mb-4 transition-colors">
                          <span className="material-symbols-outlined text-[#006c49] group-hover:text-white">{paperIcon(p)}</span>
                        </div>
                        <h3 className="font-bold text-lg leading-tight mb-2">{p.title}</h3>
                        <p className="text-sm opacity-70">{weekdayLabel(p)}</p>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-8"><span className="material-symbols-outlined text-3xl text-[#c3c6d1] mb-2 block">celebration</span><p className="text-sm text-[#43474f]">All caught up! No pending homework.</p></div>
                )}
              </div>
            </div>
            {canCreateQuiz && (
            <section className="mb-12">
              <h2 className="text-xl font-bold text-[#001e40] mb-4 font-headline">Self-learning</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                <button onClick={() => { playClick(); setAssignMode("quiz"); setShowQuizSetup(true); }} className="relative group h-48 rounded-[2.5rem] bg-[#006c49] overflow-hidden text-left p-10 flex flex-col justify-end transition-all hover:scale-[1.02] active:scale-95 shadow-xl shadow-[#006c49]/20">
                  <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(circle_at_30%_-20%,rgba(255,255,255,0.2),transparent)]" />
                  <span className="material-symbols-outlined text-6xl text-white/20 absolute top-8 right-8">rocket_launch</span>
                  <h3 className="text-3xl font-extrabold text-white mb-2 font-headline">Daily 20min Quiz</h3>
                  <p className="text-[#6cf8bb]/90 font-medium">Power up your memory today</p>
                </button>
                <button onClick={() => { playClick(); setAssignMode("focused"); setShowQuizSetup(true); }} className="relative group h-48 rounded-[2.5rem] bg-[#003366] overflow-hidden text-left p-10 flex flex-col justify-end transition-all hover:scale-[1.02] active:scale-95 shadow-xl shadow-[#003366]/20">
                  <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(circle_at_30%_-20%,rgba(255,255,255,0.2),transparent)]" />
                  <span className="material-symbols-outlined text-6xl text-white/20 absolute top-8 right-8">psychology</span>
                  <h3 className="text-3xl font-extrabold text-white mb-2 font-headline">Focused Practice</h3>
                  <p className="text-white/80 font-medium">Drill a topic you want to improve on</p>
                </button>
                <button onClick={() => router.push(`/spelling?userId=${userId}`)} className="relative group h-48 rounded-[2.5rem] bg-[#001e40] overflow-hidden text-left p-10 flex flex-col justify-end transition-all hover:scale-[1.02] active:scale-95 shadow-xl shadow-[#001e40]/20">
                  <span className="material-symbols-outlined text-6xl text-white/20 absolute top-8 right-8">spellcheck</span>
                  <h3 className="text-3xl font-extrabold text-white mb-2 font-headline">Spelling / 听写</h3>
                  <p className="text-[#a7c8ff] font-medium">View lists and test yourself</p>
                </button>
              </div>
            </section>
            )}
            {/* Spelling tests moved to /spelling page */}

            {completedPapers.length > 0 && (
              <section className="mb-12">
                <button onClick={() => setShowPastWork(!showPastWork)} className="flex items-center gap-2 text-sm font-bold text-[#43474f] hover:text-[#001e40] transition-colors mb-4">
                  <span className="material-symbols-outlined text-base">{showPastWork ? "expand_less" : "expand_more"}</span>Past Completed Work ({completedPapers.length})
                </button>
                {showPastWork && (
                  <div className="space-y-3">
                    {completedPapers.slice(0, pastWorkLimit).map(p => {
                      const pct = scorePct(p);
                      const stillMarking = p.markingStatus !== "complete" && p.markingStatus !== "released";
                      return (
                        <div
                          key={p.id}
                          onClick={stillMarking ? undefined : () => router.push(`/exam/${p.id}/review?userId=${userId}`)}
                          aria-disabled={stillMarking}
                          className={`flex items-center gap-4 p-4 rounded-2xl shadow-sm transition-shadow ${stillMarking ? "bg-[#eff4ff] cursor-not-allowed" : "bg-white hover:shadow-md cursor-pointer"}`}
                        >
                          <div className="w-10 h-10 rounded-xl bg-[#eff4ff] flex items-center justify-center text-[#001e40] shrink-0"><span className="material-symbols-outlined text-lg">{paperIcon(p)}</span></div>
                          <div className="flex-1 min-w-0"><p className="font-bold text-sm text-[#001e40] truncate">{p.title}</p><p className="text-xs text-[#43474f]">{stillMarking ? "Marking your answers…" : relativeDate(p.completedAt!)}</p></div>
                          {stillMarking ? (
                            <span className="flex items-center gap-1 shrink-0">
                              <span className="text-[9px] font-bold px-2 py-0.5 bg-[#dce9ff] text-[#001e40] rounded-full">MARKING…</span>
                              {isAdminViewer && (
                                <button
                                  onClick={(e) => { e.stopPropagation(); forceRemark(p.id); }}
                                  disabled={forcingRemark === p.id}
                                  title="Force re-mark (admin)"
                                  className="text-[9px] font-bold text-[#003366] bg-[#dce9ff] hover:bg-[#a7c8ff] px-2 py-0.5 rounded-full transition-colors disabled:opacity-50"
                                >{forcingRemark === p.id ? "…" : "Re-mark"}</button>
                              )}
                            </span>
                          ) : pct !== null && <span className={`font-extrabold text-sm ${pct >= 75 ? "text-[#006c49]" : pct >= 50 ? "text-[#d58d00]" : "text-[#ba1a1a]"}`}>{pct}%</span>}
                        </div>
                      );
                    })}
                    {completedPapers.length > pastWorkLimit && (
                      <button onClick={() => setPastWorkLimit(l => l + 20)} className="w-full py-3 text-sm font-bold text-[#003366] bg-[#eff4ff] rounded-2xl hover:bg-[#dce9ff] transition-colors">
                        See more ({completedPapers.length - pastWorkLimit} remaining)
                      </button>
                    )}
                  </div>
                )}
              </section>
            )}

            {/* Habitats & pets CTA — unlocks at 200 pts */}
            {habitatsEnabled && totalPoints >= HABITAT_UNLOCK_POINTS && (
              <section className="mt-8">
                <button
                  onClick={() => router.push(`/habitats/${userId}`)}
                  className="flex items-center gap-3 w-full p-5 rounded-3xl bg-gradient-to-r from-[#6cf8bb]/20 to-[#a7c8ff]/20 border border-[#6cf8bb]/40 hover:from-[#6cf8bb]/35 hover:to-[#a7c8ff]/35 transition-colors text-left"
                >
                  <span className="material-symbols-outlined text-3xl text-[#006c49]" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
                  <div className="flex-1">
                    <p className="font-headline font-extrabold text-[#001e40]">Go to habitats and pets</p>
                    <p className="text-xs text-[#43474f]">Visit your unlocked habitats and meet the pets that live there.</p>
                  </div>
                  <span className="material-symbols-outlined text-[#001e40]">arrow_forward</span>
                </button>
              </section>
            )}

            {/* Arena Battle panel */}
            {hasArena && arenaData && (
              <section className="mt-8">
                <button onClick={() => setShowArena(!showArena)} className="flex items-center gap-2 text-sm font-bold text-[#43474f] hover:text-[#001e40] transition-colors mb-4">
                  <span className="material-symbols-outlined text-base">{showArena ? "expand_less" : "expand_more"}</span>
                  <span className="material-symbols-outlined text-base text-[#737780]" style={{ fontVariationSettings: "'FILL' 1" }}>swords</span>
                  Arena Battle
                </button>
                {showArena && (
                  <div className="rounded-2xl flex" style={{ background: `#1a1a2e url(/avatars/Fight/battlearena.jpg) center/cover`, backgroundBlendMode: "overlay" }}>
                      {/* Leaderboard table */}
                      <div className="w-[40%] shrink-0 p-5">
                        <h3 className="text-white font-headline font-bold text-lg mb-3">Weekly Arena</h3>
                        <table className="w-full">
                          <thead>
                            <tr className="text-white/50 text-[10px] uppercase tracking-wider">
                              <th className="text-left pb-2 font-semibold">#</th>
                              <th className="text-left pb-2 font-semibold">Name</th>
                              <th className="text-right pb-2 font-semibold">Points</th>
                              <th className="text-right pb-2 font-semibold">Score</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Array.from({ length: 10 }, (_, i) => {
                              const entry = arenaData.leaderboard[i];
                              if (!entry) return (
                                <tr key={`empty-${i}`} className="text-white/20">
                                  <td className="py-1 text-xs">{i + 1}</td>
                                  <td className="py-1 text-xs">—</td>
                                  <td className="py-1 text-xs text-right">0</td>
                                  <td className="py-1 text-xs text-right">—</td>
                                </tr>
                              );
                              const isMe = entry.id === userId;
                              return (
                                <tr key={entry.id} className={isMe ? "text-[#ffddb4] font-bold" : "text-white/80"}>
                                  <td className="py-1 text-xs">{i + 1}</td>
                                  <td className="py-1 text-xs">{isMe ? `${entry.name} ⭐` : entry.name}</td>
                                  <td className="py-1 text-xs text-right">{entry.points}</td>
                                  <td className="py-1 text-xs text-right">{entry.pct}%</td>
                                </tr>
                              );
                            })}
                            {arenaData.playerEntry && arenaData.playerRank && arenaData.playerRank > 10 ? (
                              <tr className="text-[#ffddb4] font-bold border-t border-white/10">
                                <td className="py-1 text-xs">{arenaData.playerRank}</td>
                                <td className="py-1 text-xs">{arenaData.playerEntry.name} ⭐</td>
                                <td className="py-1 text-xs text-right">{arenaData.playerEntry.points}</td>
                                <td className="py-1 text-xs text-right">{arenaData.playerEntry.pct}%</td>
                              </tr>
                            ) : (
                              <tr className="text-white/10"><td className="py-1 text-xs" colSpan={4}>&nbsp;</td></tr>
                            )}
                          </tbody>
                        </table>
                        <p className="text-white/30 text-[9px] mt-3 italic">Resets every Monday</p>
                      </div>
                      {/* Battle scene — avatar (left, facing right) vs slime (right), overlapping */}
                      <div className="flex-1 flex items-end justify-center p-4">
                        <div className="relative h-48" style={{ width: "340px" }}>
                          {/* Avatar — above slime (z-10) */}
                          {(() => {
                            const myPoints = arenaData.playerEntry?.points ?? arenaData.leaderboard.find(e => e.id === userId)?.points ?? 0;
                            const cfg = fightAvatarCfg(avatarType, myPoints);
                            const acts = ["attack", "defend", "ready"] as const;
                            const currentPair = arenaPairs[arenaAction];
                            return acts.map(act => cfg.isVideo ? (
                              <video key={`a-${act}`} src={`${cfg.prefix}_${act}.${cfg.ext}`}
                                autoPlay muted playsInline loop
                                className={`h-48 object-contain absolute bottom-0 left-0 z-10 ${currentPair.avatar === act ? "" : "invisible"}`}
                                style={{ mixBlendMode: "screen", transform: "scaleX(-1)" }}
                              />
                            ) : (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img key={`a-${act}`} src={`${cfg.prefix}_${act}.${cfg.ext}`} alt={act}
                                className={`h-48 object-contain absolute bottom-0 left-0 z-10 ${currentPair.avatar === act ? "" : "invisible"}`}
                                style={{ mixBlendMode: "screen", transform: "scaleX(-1)" }}
                                onLoad={() => { if (currentPair.avatar === act) setArenaGifReady(true); }}
                              />
                            ));
                          })()}
                          {/* Monster — behind avatar (alternates slime / mushroom each cycle) */}
                          {(() => {
                            const currentPair = arenaPairs[arenaAction];
                            const mAct = mushroomAct(currentPair.slime);
                            return (
                              <>
                                {["hit", "attack", "dead"].map(s => (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img key={`s-${s}`} src={`/avatars/Fight/slime_${s}.gif`} alt={s}
                                    className={`h-36 object-contain absolute bottom-0 right-0 ${monster === "slime" && currentPair.slime === s ? "" : "invisible"}`}
                                    style={{ mixBlendMode: "screen" }}
                                  />
                                ))}
                                {["hit", "attack", "die"].map(s => (
                                  <video key={`m-${s}`} src={`/avatars/Fight/mushroom_${s}.mp4`}
                                    autoPlay muted playsInline loop={s !== "die"}
                                    className={`h-36 object-contain absolute bottom-2 right-12 ${monster === "mushroom" && mAct === s ? "" : "invisible"}`}
                                    style={{ mixBlendMode: "screen" }}
                                  />
                                ))}
                              </>
                            );
                          })()}
                          {/* Slash — between avatar and slime */}
                          {showSlash && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={`/avatars/Fight/slash.gif?t=${arenaAction}`} alt="slash"
                              className="h-64 object-contain absolute -bottom-2 left-1/2 -translate-x-1/2 z-20"
                              style={{ mixBlendMode: "screen" }}
                            />
                          )}
                          {/* Shield — over avatar when defending */}
                          {showShield && (
                            <video key={`shield-${arenaAction}`} src="/avatars/Fight/shield.mp4"
                              autoPlay muted playsInline
                              className="h-48 object-contain absolute bottom-0 left-0 z-20"
                              style={{ mixBlendMode: "screen" }}
                            />
                          )}
                        </div>
                      </div>
                  </div>
                )}
              </section>
            )}
          </div>
        </main>
      </div>

      {/* ══ MOBILE LAYOUT ══ */}
      <div className="lg:hidden pb-24">
        {/* Top bar scrolls with content — keeps the iOS WebView
            viewport clean. Only the bottom nav is sticky. */}
        <header className="bg-[#f8f9ff]/90 backdrop-blur-md px-5 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2"><img src="/logo_t.png" alt="Owl" className="w-7 h-7 object-contain" /><img src="/markforyou2_t.png" alt="Markforyou" className="h-5 object-contain" /></div>
          <div className="flex items-center gap-2">
            <button onClick={() => openLinkModal("share")} className="text-xs font-bold text-[#003366] bg-[#eff4ff] px-3 py-1.5 rounded-full">{hasParent ? "+" : "Link"}</button>
            <button onClick={async () => { try { await fetch("/api/auth", { method: "DELETE" }); } catch {} window.location.href = "/"; }} className="text-[#43474f] hover:text-[#ba1a1a] transition-colors" title="Log out">
              <span className="material-symbols-outlined text-xl">logout</span>
            </button>
          </div>
        </header>
        <div className="px-5">
          <section className="mb-8 mt-2">
            <div className="flex items-center gap-3">
              {hasAvatar && (
                <button onClick={() => setShowAvatarPicker(true)} className="w-12 h-12 rounded-full border-2 border-[#a7c8ff] overflow-hidden flex items-center justify-center bg-white shrink-0 hover:border-[#003366] transition-all">
                  <video src={mobileAvatarSrc} autoPlay loop muted playsInline className="w-full h-full object-contain pointer-events-none" style={{ mixBlendMode: "multiply" }} />
                </button>
              )}
              <h1 className="text-2xl font-extrabold text-[#001e40] mb-1 font-headline">{greeting()}, {displayName.split(" ")[0]}!</h1>
            </div>
            <p className="text-sm text-[#43474f]">Ready to learn today?</p>
            <div className="flex flex-wrap gap-2 mt-3">
              {quizBadge && quizBadge.streak > 0 && <div className="flex items-center gap-1.5 bg-[#ffddb4] text-[#291800] px-3 py-1.5 rounded-full text-sm font-extrabold"><span className="material-symbols-outlined text-xl" style={{ fontVariationSettings: "'FILL' 1" }}>local_fire_department</span>{quizBadge.streak}-day streak</div>}
              {quizBadge && quizBadge.image && <div className="flex items-center gap-1.5 bg-[#d3e4fe] text-[#001e40] px-3 py-1.5 rounded-full text-sm font-extrabold">{/* eslint-disable-next-line @next/next/no-img-element */}<img src={quizBadge.image} alt={quizBadge.badge} className="w-6 h-6 object-contain" />{quizBadge.count} {quizBadge.count === 1 ? "quiz" : "quizzes"}</div>}
              <ExperienceBar
                points={effectivePoints}
                level={displayedLevel}
                progressPct={levelProgressPct}
                justUpdated={barPulsing}
                crystals={crystals}
                showCrystals={habitatsEnabled && totalPoints >= HABITAT_UNLOCK_POINTS}
              />
            </div>
          </section>
          <section className="mb-8">
            <h2 className="text-lg font-bold text-[#001e40] mb-4 flex items-center gap-2 font-headline"><span className="material-symbols-outlined text-[#006c49]" style={{ fontVariationSettings: "'FILL' 1" }}>task_alt</span>Today&apos;s Activities</h2>
            <div className="space-y-3">
              {todayTodo.map(p => <div key={p.id} onClick={() => goToPaper(p)} className="flex items-center gap-3 p-4 bg-white rounded-2xl shadow-sm cursor-pointer"><div className="w-5 h-5 rounded border-2 border-[#c3c6d1]" /><div className="flex-1 min-w-0"><span className="font-semibold text-sm text-[#0b1c30] truncate block">{p.title}</span><span className="text-[10px] text-[#43474f]">Due today</span></div>{p.printedAt && <button type="button" onClick={e => { e.stopPropagation(); playClick(); setScannerTarget({ masterPaperId: p.id, paperTitle: p.title }); }} aria-label={`Scan printed pages for ${p.title}`} className="shrink-0 w-8 h-8 rounded-full bg-[#006c49]/10 hover:bg-[#006c49]/20 text-[#006c49] flex items-center justify-center"><span className="material-symbols-outlined text-base">photo_camera</span></button>}<span className="text-[9px] font-bold px-2 py-0.5 bg-[#dce9ff] text-[#737780] rounded-full shrink-0">TODO</span></div>)}
              {todayDone.map(p => {
                const pct = scorePct(p);
                const stillMarking = !!p.completedAt && p.markingStatus !== "complete" && p.markingStatus !== "released";
                return (
                  <div
                    key={p.id}
                    onClick={stillMarking ? undefined : () => router.push(`/exam/${p.id}/review?userId=${userId}`)}
                    aria-disabled={stillMarking}
                    className={`flex items-center gap-3 p-4 rounded-2xl ${stillMarking ? "bg-[#eff4ff] border border-[#dce9ff] cursor-not-allowed" : "bg-[#6cf8bb]/20 border border-[#6cf8bb]/30 cursor-pointer"}`}
                  >
                    <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${stillMarking ? "border-[#737780]" : "border-[#006c49] bg-[#006c49]"}`}>
                      {stillMarking
                        ? <span className="animate-spin material-symbols-outlined text-[#737780] text-xs">progress_activity</span>
                        : <span className="material-symbols-outlined text-white text-xs" style={{ fontVariationSettings: "'FILL' 1" }}>check</span>}
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="font-semibold text-sm text-[#0b1c30] truncate block">{p.title}</span>
                      <span className="text-[10px] text-[#43474f]">{stillMarking ? "Marking your answers…" : "Due today"}</span>
                    </div>
                    <span className="flex items-center gap-1 shrink-0">
                      {stillMarking ? (
                        <>
                          <span className="text-[9px] font-bold px-2 py-0.5 bg-[#dce9ff] text-[#001e40] rounded-full">MARKING…</span>
                          {isAdminViewer && (
                            <button
                              onClick={(e) => { e.stopPropagation(); forceRemark(p.id); }}
                              disabled={forcingRemark === p.id}
                              title="Force re-mark (admin)"
                              className="text-[9px] font-bold text-[#003366] bg-[#dce9ff] hover:bg-[#a7c8ff] px-2 py-0.5 rounded-full transition-colors disabled:opacity-50"
                            >{forcingRemark === p.id ? "…" : "Re-mark"}</button>
                          )}
                        </>
                      ) : (
                        <>
                          <span className="text-[9px] font-bold px-2 py-0.5 bg-[#6cf8bb] text-[#006c49] rounded-full">DONE</span>
                          {pct !== null && <span className={`text-xs font-extrabold ${pct >= 75 ? "text-[#006c49]" : pct >= 50 ? "text-[#d58d00]" : "text-[#ba1a1a]"}`}>{pct}%</span>}
                        </>
                      )}
                    </span>
                  </div>
                );
              })}
              {todayActivities.length === 0 && <p className="text-sm text-[#43474f] text-center py-4">No activities yet today</p>}
            </div>
          </section>
          <section className="mb-8">
            <h2 className="text-lg font-bold text-[#001e40] mb-4 font-headline">This Week&apos;s Homework</h2>
            {weekHomework.length > 0 ? (
              <div className="space-y-3">
                {weekHomework.map(p => (
                  <div key={p.id} className="relative flex items-center gap-3 p-4 bg-white rounded-2xl shadow-sm">
                    <button type="button" onClick={() => goToPaper(p)} className="flex items-center gap-3 flex-1 min-w-0 text-left cursor-pointer">
                      <div className="w-10 h-10 rounded-xl bg-[#eff4ff] flex items-center justify-center shrink-0">
                        <span className="material-symbols-outlined text-[#001e40]">{paperIcon(p)}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-sm text-[#001e40] truncate">{p.title}</p>
                        <p className="text-xs text-[#43474f]">{weekdayLabel(p)}</p>
                      </div>
                    </button>
                    {p.printedAt && (
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); playClick(); setScannerTarget({ masterPaperId: p.id, paperTitle: p.title }); }}
                        aria-label={`Scan printed pages for ${p.title}`}
                        className="shrink-0 w-9 h-9 rounded-full bg-[#006c49]/10 hover:bg-[#006c49]/20 text-[#006c49] flex items-center justify-center"
                      >
                        <span className="material-symbols-outlined text-base">photo_camera</span>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-6 bg-white/60 rounded-2xl">
                <span className="material-symbols-outlined text-2xl text-[#c3c6d1] mb-1 block">celebration</span>
                <p className="text-xs text-[#43474f]">All caught up! No pending homework.</p>
              </div>
            )}
          </section>
          <h2 className="text-lg font-bold text-[#001e40] mb-3 font-headline">Self-learning</h2>
          <section className="mb-8 grid grid-cols-2 gap-3">
            {canCreateQuiz && (
              <>
                <button onClick={() => { playClick(); setAssignMode("quiz"); setShowQuizSetup(true); }} className="relative h-32 rounded-2xl bg-[#006c49] overflow-hidden text-left p-5 flex flex-col justify-end"><span className="material-symbols-outlined text-3xl text-white/20 absolute top-3 right-3">rocket_launch</span><h3 className="text-sm font-extrabold text-white font-headline">Daily Quiz</h3><p className="text-[10px] text-[#6cf8bb]/80">20 min practice</p></button>
                <button onClick={() => { playClick(); setAssignMode("focused"); setShowQuizSetup(true); }} className="relative h-32 rounded-2xl bg-[#003366] overflow-hidden text-left p-5 flex flex-col justify-end"><span className="material-symbols-outlined text-3xl text-white/20 absolute top-3 right-3">psychology</span><h3 className="text-sm font-extrabold text-white font-headline">Focused Practice</h3><p className="text-[10px] text-white/70">Drill a topic</p></button>
              </>
            )}
            <button onClick={() => router.push(`/spelling?userId=${userId}`)} className="relative h-32 rounded-2xl bg-[#001e40] overflow-hidden text-left p-5 flex flex-col justify-end">
              <span className="material-symbols-outlined text-3xl text-white/20 absolute top-3 right-3">spellcheck</span>
              {/* Mobile-area tile — keep CJK only when space is tight,
                  show both on sm+ since the tile is at least 2 columns wide. */}
              <h3 className="text-sm font-extrabold text-white font-headline">
                <span className="hidden sm:inline">听写 / Spelling</span>
                <span className="inline sm:hidden">听写</span>
              </h3>
              <p className="text-[10px] text-[#a7c8ff]/80">Spelling lists</p>
            </button>
            {/* Progress + Lumi entry point for the student. Routes to
                /progress/{studentId}?view=lumi which now renders
                TutorBodyForStudent (fluency table + topic chart +
                Lumi greeting) for kid sessions too. */}
            <button
              onClick={() => router.push(`/progress/${userId}?view=lumi`)}
              className="relative h-32 rounded-2xl overflow-hidden text-left p-5 flex flex-col justify-end"
              style={{ background: "linear-gradient(135deg, #7c3aed 0%, #a855f7 100%)" }}
            >
              <span className="material-symbols-outlined text-3xl text-white/20 absolute top-3 right-3" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
              <h3 className="text-sm font-extrabold text-white font-headline">Progress &amp; Lumi</h3>
              <p className="text-[10px] text-white/80">See where you stand</p>
            </button>
          </section>
          {/* Spelling tests moved to /spelling page */}
          {completedPapers.length > 0 && <section className="mb-8"><button onClick={() => setShowPastWork(!showPastWork)} className="flex items-center gap-1 text-xs font-bold text-[#43474f] mb-3"><span className="material-symbols-outlined text-sm">{showPastWork ? "expand_less" : "expand_more"}</span>Past Work ({completedPapers.length})</button>{showPastWork && <div className="space-y-2">{completedPapers.slice(0, pastWorkLimit).map(p => { const pct = scorePct(p); return <div key={p.id} onClick={() => router.push(`/exam/${p.id}/review?userId=${userId}`)} className="flex items-center gap-3 p-3 bg-white rounded-xl shadow-sm cursor-pointer"><div className="w-9 h-9 rounded-lg bg-[#eff4ff] flex items-center justify-center text-[#001e40] shrink-0"><span className="material-symbols-outlined text-base">{paperIcon(p)}</span></div><div className="flex-1 min-w-0"><p className="font-bold text-xs text-[#001e40] truncate">{p.title}</p><p className="text-[10px] text-[#43474f]">{relativeDate(p.completedAt!)}</p></div>{pct !== null && <span className={`font-extrabold text-xs ${pct >= 75 ? "text-[#006c49]" : pct >= 50 ? "text-[#d58d00]" : "text-[#ba1a1a]"}`}>{pct}%</span>}</div>; })}{completedPapers.length > pastWorkLimit && <button onClick={() => setPastWorkLimit(l => l + 20)} className="w-full py-2.5 text-xs font-bold text-[#003366] bg-[#eff4ff] rounded-xl hover:bg-[#dce9ff] transition-colors">See more ({completedPapers.length - pastWorkLimit} remaining)</button>}</div>}</section>}

          {/* Habitats & pets CTA — mobile */}
          {habitatsEnabled && totalPoints >= HABITAT_UNLOCK_POINTS && (
            <section className="mb-8">
              <button
                onClick={() => { playClick(); router.push(`/habitats/${userId}`); }}
                className="flex items-center gap-3 w-full p-4 rounded-2xl bg-gradient-to-r from-[#6cf8bb]/20 to-[#a7c8ff]/20 border border-[#6cf8bb]/40"
              >
                <span className="material-symbols-outlined text-2xl text-[#006c49]" style={{ fontVariationSettings: "'FILL' 1" }}>pets</span>
                <div className="flex-1 text-left">
                  <p className="font-bold text-sm text-[#001e40]">Go to habitats and pets</p>
                  <p className="text-[10px] text-[#43474f]">See your unlocked habitats.</p>
                </div>
                <span className="material-symbols-outlined text-lg text-[#001e40]">arrow_forward</span>
              </button>
            </section>
          )}

          {/* Arena Battle — mobile */}
          {hasArena && arenaData && (
            <section className="mb-8">
              <button onClick={() => setShowArena(!showArena)} className="flex items-center gap-2 text-xs font-bold text-[#43474f] mb-3">
                <span className="material-symbols-outlined text-sm">{showArena ? "expand_less" : "expand_more"}</span>
                <span className="material-symbols-outlined text-sm text-[#737780]" style={{ fontVariationSettings: "'FILL' 1" }}>swords</span>
                Arena Battle
              </button>
              {showArena && (
                <div className="rounded-2xl flex flex-col p-4" style={{ background: `#1a1a2e url(/avatars/Fight/battlearena.jpg) center/cover`, backgroundBlendMode: "overlay" }}>
                  <div>
                    <h3 className="text-white font-headline font-bold text-base mb-2">Weekly Arena</h3>
                    <table className="w-full">
                      <thead>
                        <tr className="text-white/50 text-[9px] uppercase tracking-wider">
                          <th className="text-left pb-1">#</th>
                          <th className="text-left pb-1">Name</th>
                          <th className="text-right pb-1">Pts</th>
                          <th className="text-right pb-1">%</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Array.from({ length: 10 }, (_, i) => {
                          const entry = arenaData.leaderboard[i];
                          if (!entry) return (
                            <tr key={`empty-${i}`} className="text-white/20">
                              <td className="py-0.5 text-[10px]">{i + 1}</td>
                              <td className="py-0.5 text-[10px]">—</td>
                              <td className="py-0.5 text-[10px] text-right">0</td>
                              <td className="py-0.5 text-[10px] text-right">—</td>
                            </tr>
                          );
                          const isMe = entry.id === userId;
                          return (
                            <tr key={entry.id} className={isMe ? "text-[#ffddb4] font-bold" : "text-white/80"}>
                              <td className="py-0.5 text-[10px]">{i + 1}</td>
                              <td className="py-0.5 text-[10px]">{isMe ? `${entry.name} ⭐` : entry.name}</td>
                              <td className="py-0.5 text-[10px] text-right">{entry.points}</td>
                              <td className="py-0.5 text-[10px] text-right">{entry.pct}%</td>
                            </tr>
                          );
                        })}
                        {arenaData.playerEntry && arenaData.playerRank && arenaData.playerRank > 10 ? (
                          <tr className="text-[#ffddb4] font-bold border-t border-white/10">
                            <td className="py-0.5 text-[10px]">{arenaData.playerRank}</td>
                            <td className="py-0.5 text-[10px]">{arenaData.playerEntry.name} ⭐</td>
                            <td className="py-0.5 text-[10px] text-right">{arenaData.playerEntry.points}</td>
                            <td className="py-0.5 text-[10px] text-right">{arenaData.playerEntry.pct}%</td>
                          </tr>
                        ) : (
                          <tr className="text-white/10"><td className="py-0.5 text-[10px]" colSpan={4}>&nbsp;</td></tr>
                        )}
                      </tbody>
                    </table>
                    <p className="text-white/30 text-[8px] mt-2 italic">Resets every Monday</p>
                  </div>
                  {/* Battle scene — avatar vs slime, overlapping */}
                  <div className="flex justify-center items-end mt-2">
                    <div className="relative h-28" style={{ width: "200px" }}>
                      {/* Avatar — above slime (z-10) */}
                      {(() => {
                        const myPoints = arenaData.playerEntry?.points ?? arenaData.leaderboard.find(e => e.id === userId)?.points ?? 0;
                        const cfg = fightAvatarCfg(avatarType, myPoints);
                        const acts = ["attack", "defend", "ready"] as const;
                        const currentPair = arenaPairs[arenaAction];
                        return acts.map(act => cfg.isVideo ? (
                          <video key={`a-${act}`} src={`${cfg.prefix}_${act}.${cfg.ext}`}
                            autoPlay muted playsInline loop
                            className={`h-28 object-contain absolute bottom-0 left-0 z-10 ${currentPair.avatar === act ? "" : "invisible"}`}
                            style={{ mixBlendMode: "screen", transform: "scaleX(-1)" }}
                          />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img key={`a-${act}`} src={`${cfg.prefix}_${act}.${cfg.ext}`} alt={act}
                            className={`h-28 object-contain absolute bottom-0 left-0 z-10 ${currentPair.avatar === act ? "" : "invisible"}`}
                            style={{ mixBlendMode: "screen", transform: "scaleX(-1)" }}
                          />
                        ));
                      })()}
                      {/* Monster — behind avatar (alternates slime / mushroom each cycle) */}
                      {(() => {
                        const currentPair = arenaPairs[arenaAction];
                        const mAct = mushroomAct(currentPair.slime);
                        return (
                          <>
                            {["hit", "attack", "dead"].map(s => (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img key={`s-${s}`} src={`/avatars/Fight/slime_${s}.gif`} alt={s}
                                className={`h-20 object-contain absolute bottom-0 right-0 ${monster === "slime" && currentPair.slime === s ? "" : "invisible"}`}
                                style={{ mixBlendMode: "screen" }}
                              />
                            ))}
                            {["hit", "attack", "die"].map(s => (
                              <video key={`m-${s}`} src={`/avatars/Fight/mushroom_${s}.mp4`}
                                autoPlay muted playsInline loop={s !== "die"}
                                className={`h-20 object-contain absolute bottom-1 right-8 ${monster === "mushroom" && mAct === s ? "" : "invisible"}`}
                                style={{ mixBlendMode: "screen" }}
                              />
                            ))}
                          </>
                        );
                      })()}
                      {/* Slash — between avatar and slime */}
                      {showSlash && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={`/avatars/Fight/slash.gif?t=${arenaAction}`} alt="slash"
                          className="h-40 object-contain absolute -bottom-1 left-1/2 -translate-x-1/2 z-20"
                          style={{ mixBlendMode: "screen" }}
                        />
                      )}
                      {/* Shield — over avatar when defending */}
                      {showShield && (
                        <video key={`shield-${arenaAction}`} src="/avatars/Fight/shield.mp4"
                          autoPlay muted playsInline
                          className="h-28 object-contain absolute bottom-0 left-0 z-20"
                          style={{ mixBlendMode: "screen" }}
                        />
                      )}
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      </div>


      {/* ── Unified Quiz / Focused Practice Modal ────────────────────────
          Mirrors ParentDashboard's QuizModal so the student-side picker
          matches the parent-side picker visually + behaviourally. One
          modal with a Daily Quiz ↔ Focused Practice pill toggle, shared
          Subject row, mode-specific body, single action button. */}
      {showQuizSetup && canCreateQuiz && (
        <div className="fixed inset-0 bg-black/50 flex items-end lg:items-center justify-center z-[60] p-4" onClick={() => setShowQuizSetup(false)}>
          <div className="bg-white rounded-t-3xl lg:rounded-3xl w-full max-w-sm p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="font-headline text-lg font-extrabold text-[#001e40] mb-4">{assignMode === "quiz" ? "Daily Quiz" : "Focused Practice"}</h3>
            {/* Mode toggle — same pill style as the parent modal. */}
            <div className="flex gap-1 bg-slate-100 p-1 rounded-xl mb-4">
              {(["quiz", "focused"] as const).map(m => (
                <button key={m} onClick={() => { setAssignMode(m); if (m === "focused" && quizSubject === "english") setQuizSubject("math"); }}
                  className={`flex-1 py-2 rounded-lg text-sm font-bold transition-all ${assignMode === m ? "bg-white text-[#001e40] shadow-sm" : "text-slate-500"}`}>
                  {m === "quiz" ? "Daily Quiz" : "Focused Practice"}
                </button>
              ))}
            </div>
            <p className="text-xs font-extrabold text-[#43474f] uppercase tracking-wider mb-2">Subject</p>
            <div className="flex gap-2 mb-4">
              {(["math", "science", "english"] as const).map(s => (
                <button key={s} onClick={() => setQuizSubject(s)}
                  className={`flex-1 py-2.5 rounded-xl border-2 text-sm font-medium ${quizSubject === s ? "border-[#006c49] bg-[#6cf8bb]/20 text-[#006c49]" : "border-[#c3c6d1] text-[#43474f]"}`}>
                  {s === "math" ? "Math" : s === "science" ? "Science" : "English"}
                </button>
              ))}
            </div>
            {/* Focused Practice — English: pick a single section
                (doubled to 2x via /api/daily-quiz focused branch). */}
            {assignMode === "focused" && quizSubject === "english" && (
              <div className="mb-4">
                <p className="text-[10px] font-extrabold text-[#43474f] uppercase tracking-wider mb-1.5">Pick one section (2x questions)</p>
                <select value={[...englishSections][0] ?? ""} onChange={e => setEnglishSections(new Set(e.target.value ? [e.target.value] : []))}
                  className="w-full px-3 py-2 rounded-xl border-2 border-[#c3c6d1] text-xs font-medium text-[#001e40] focus:border-[#003366] focus:outline-none bg-white">
                  <option value="">Select a section…</option>
                  <option value="grammar-mcq">Grammar MCQ</option>
                  <option value="vocab-mcq">Vocabulary MCQ</option>
                  <option value="vocab-cloze">Vocabulary Cloze</option>
                  <option value="visual-text">Visual Text Comprehension</option>
                  <option value="grammar-cloze">Grammar Cloze</option>
                  <option value="editing">Editing (Spelling & Grammar)</option>
                  <option value="comprehension-cloze">Comprehension Cloze</option>
                  <option value="synthesis">Synthesis & Transformation</option>
                  <option value="comprehension-oeq">Comprehension OEQ</option>
                </select>
              </div>
            )}
            {/* Focused Practice — Math / Science: type pill, weakest
                topics quick-pick, then full topic dropdown. */}
            {assignMode === "focused" && (quizSubject === "math" || quizSubject === "science") && (
              <>
                <p className="text-xs font-extrabold text-[#43474f] uppercase tracking-wider mb-2">Type</p>
                <div className="flex gap-2 mb-4">
                  {(["mcq", "mcq-oeq"] as const).map(t => (
                    <button key={t} onClick={() => setFocusedType(t)}
                      className={`flex-1 py-2.5 rounded-xl border-2 text-sm font-medium ${focusedType === t ? "border-[#006c49] bg-[#6cf8bb]/20 text-[#006c49]" : "border-[#c3c6d1] text-[#43474f]"}`}>
                      {t === "mcq" ? "MCQ Only" : "MCQ + Written"}
                    </button>
                  ))}
                </div>
                {(() => {
                  const weak = focusedTopics.filter(t => t.pct <= 75).slice(0, 3);
                  return weak.length > 0 ? (
                    <div className="mb-4">
                      <p className="text-xs font-extrabold text-[#43474f] uppercase tracking-wider mb-2">Weakest Topics</p>
                      <div className="space-y-1.5">
                        {weak.map(t => (
                          <button key={t.topic} onClick={() => setFocusedTopic(t.topic)}
                            className={`w-full flex items-center justify-between text-left px-3 py-2 rounded-xl border-2 transition-all ${focusedTopic === t.topic ? "border-[#006c49] bg-[#6cf8bb]/20" : "border-[#c3c6d1] bg-white"}`}>
                            <span className="text-sm font-bold text-[#001e40] truncate pr-2">{t.topic}</span>
                            <span className="text-xs text-[#ba1a1a] font-extrabold shrink-0">{t.pct}%</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null;
                })()}
                <div className="mb-5">
                  <p className="text-xs font-extrabold text-[#43474f] uppercase tracking-wider mb-2">{focusedTopics.filter(t => t.pct <= 75).length > 0 ? "Or Choose Topic" : "Choose Topic"}</p>
                  <select value={focusedTopic} onChange={e => setFocusedTopic(e.target.value)}
                    className="w-full px-3 py-2.5 rounded-xl border-2 border-[#c3c6d1] text-sm focus:border-[#003366] focus:outline-none bg-white">
                    <option value="">Select a topic…</option>
                    {(quizSubject === "math"
                      ? ["Basic math operations", "Fractions", "Percentage", "Ratio", "Algebra", "Area and circumference of circle", "Volume of cube and cuboid", "Geometry", "Statistics", "Time", "Volume measurement"]
                      : ["Diversity of living and non-living things", "Diversity of materials", "Life cycles in plants and animals", "Plant parts and functions", "Human digestive system", "Cycles in matter", "Water cycle, evaporation, condensation", "Plant respiratory and circulatory systems", "Human respiratory and circulatory systems", "Reproduction in plants and animals", "Light energy and uses", "Heat energy and uses", "Electrical system and circuits", "Photosynthesis", "Energy conversion", "Interaction of forces (Magnets)", "Interaction of forces (Frictional force, gravitational force, elastic spring force)", "Interactions within the environment"]
                    ).map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
              </>
            )}
            {/* Daily Quiz body — same as the parent modal's quiz path. */}
            {assignMode === "quiz" && (
              <>
                <p className="text-xs font-extrabold text-[#43474f] uppercase tracking-wider mb-2">Type</p>
                {quizSubject !== "english" ? (
                  <>
                    <div className="flex gap-2 mb-5">
                      {(["mcq", "mcq-oeq"] as const).map(t => {
                        const blocked = t === "mcq" && studentQuizMode === "oeq-only";
                        return (
                          <button key={t} onClick={() => { if (!blocked) setQuizType(t); }} disabled={blocked}
                            className={`flex-1 py-2.5 rounded-xl border-2 text-sm font-medium ${blocked ? "border-slate-100 opacity-40" : quizType === t ? "border-[#006c49] bg-[#6cf8bb]/20 text-[#006c49]" : "border-[#c3c6d1] text-[#43474f]"}`}>
                            {t === "mcq" ? "MCQ Only" : "MCQ + Written"}
                          </button>
                        );
                      })}
                    </div>
                    {quizType === "mcq-oeq" && (
                      <p className="text-[10px] text-[#c3c6d1] -mt-3 mb-4 flex items-center gap-1">
                        <span className="material-symbols-outlined text-xs">stylus_note</span>
                        Stylus recommended for written questions
                      </p>
                    )}
                  </>
                ) : (
                  <div className="mb-5">
                    <p className="text-[10px] text-[#43474f] mb-3">Select sections to include:</p>
                    <div className="space-y-2">
                      {[
                        { key: "grammar-mcq", label: "Grammar MCQ" },
                        { key: "vocab-mcq", label: "Vocabulary MCQ" },
                        { key: "vocab-cloze", label: "Vocabulary Cloze MCQ" },
                        { key: "visual-text", label: "Visual Text Comprehension MCQ" },
                        { key: "grammar-cloze", label: "Grammar Cloze" },
                        { key: "editing", label: "Editing (Spelling & Grammar)" },
                        { key: "comprehension-cloze", label: "Comprehension Cloze" },
                        { key: "synthesis", label: "Synthesis & Transformation (5 questions)" },
                        { key: "comprehension-oeq", label: "Comprehension OEQ" },
                      ].map(s => (
                        <label key={s.key} className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={englishSections.has(s.key)}
                            onChange={() => {
                              setEnglishSections(prev => {
                                const next = new Set(prev);
                                if (next.has(s.key)) next.delete(s.key);
                                else next.add(s.key);
                                return next;
                              });
                            }}
                            className="w-4 h-4 rounded accent-[#006c49]"
                          />
                          <span className="text-sm text-[#001e40]">{s.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
            <div className="flex gap-3">
              <button onClick={() => setShowQuizSetup(false)} className="flex-1 py-3 rounded-xl border-2 border-[#c3c6d1] text-[#001e40] font-bold">Cancel</button>
              <button
                disabled={creatingQuiz || (assignMode === "focused" && (quizSubject === "math" || quizSubject === "science") && !focusedTopic) || (assignMode === "focused" && quizSubject === "english" && englishSections.size !== 1)}
                onClick={startQuiz}
                className="flex-1 py-3 rounded-xl bg-[#006c49] text-white font-bold disabled:opacity-50 flex items-center justify-center gap-2">
                {creatingQuiz && <span className="inline-block w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
                {creatingQuiz ? "Creating…" : assignMode === "focused" ? "Start Practice" : "Start Quiz"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Link Parent Modal ────────────────────────────────────────────── */}
      {showLinkModal && (
        <div className="fixed inset-0 bg-black/40 flex items-end lg:items-center justify-center z-50 p-4 pb-24 lg:pb-4" onClick={() => setShowLinkModal(false)}>
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
                <p className="text-sm font-semibold text-[#003366] mb-4">Share this code with your parent so they can link their account with yours.</p>
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
          onClick={() => { setActiveNav("scan"); router.push(`/spelling?userId=${userId}`); }}
          className={`flex flex-col items-center gap-0.5 transition-all ${activeNav === "scan" ? "text-[#006c49]" : "text-slate-400"}`}
        >
          <span className="material-symbols-outlined text-2xl" style={{ fontVariationSettings: activeNav === "scan" ? "'FILL' 1" : "'FILL' 0" }}>document_scanner</span>
          <span className="text-[10px] font-medium">听写</span>
        </button>
        {canCreateQuiz && (
          <>
            <button
              onClick={() => { setActiveNav("quiz"); setAssignMode("quiz"); setShowQuizSetup(true); }}
              className={`flex flex-col items-center gap-0.5 transition-all ${activeNav === "quiz" ? "text-[#006c49]" : "text-slate-400"}`}
            >
              <span className="material-symbols-outlined text-2xl" style={{ fontVariationSettings: activeNav === "quiz" ? "'FILL' 1" : "'FILL' 0" }}>history_edu</span>
              <span className="text-[10px] font-medium">Quiz</span>
            </button>
            <button
              onClick={() => { setAssignMode("focused"); setShowQuizSetup(true); }}
              className="flex flex-col items-center gap-0.5 transition-all text-slate-400"
            >
              <span className="material-symbols-outlined text-2xl">psychology</span>
              <span className="text-[10px] font-medium">Focused</span>
            </button>
          </>
        )}
        {/* Master Class — mirrors the desktop nav gate. */}
        {canSeeMasterClass(user.name) && (
          <button
            onClick={() => { setActiveNav("master"); router.push(`/master-class?userId=${userId}`); }}
            className={`flex flex-col items-center gap-0.5 transition-all ${activeNav === "master" ? "text-[#006c49]" : "text-slate-400"}`}
          >
            <span className="material-symbols-outlined text-2xl" style={{ fontVariationSettings: activeNav === "master" ? "'FILL' 1" : "'FILL' 0" }}>school</span>
            <span className="text-[10px] font-medium">Master</span>
          </button>
        )}
      </nav>

      {/* White Tiger Celebration — one-time popup. Triggered by
          settings.whitetigerCelebrate=true. Dismissal PATCHes the
          flag back so it doesn't repeat. */}
      {showWhitetigerCelebrate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={dismissWhitetigerCelebrate}>
          <div className="bg-white rounded-3xl w-full max-w-md p-6 shadow-2xl text-center" onClick={e => e.stopPropagation()}>
            <video
              src="/avatars/whitetiger_smile.webm"
              autoPlay
              loop
              muted
              playsInline
              className="w-40 h-40 mx-auto rounded-2xl bg-slate-100 object-cover mb-4"
            />
            <h3 className="font-headline font-extrabold text-xl text-[#001e40] mb-2">Congratulations!</h3>
            <p className="text-sm text-[#43474f] mb-5">You&apos;ve unlocked the <strong className="text-[#001e40]">White Tiger</strong>. He&apos;s ready to join your habitat — head over and pick him as your avatar.</p>
            <button
              onClick={dismissWhitetigerCelebrate}
              className="w-full py-3 rounded-xl bg-[#003366] text-white text-sm font-bold hover:bg-[#002145]"
            >
              Awesome!
            </button>
          </div>
        </div>
      )}

      {/* Rename Modal */}
      {showRename && (
        <div className="fixed inset-0 bg-black/40 flex items-end lg:items-center justify-center z-50 p-4 pb-20 lg:pb-4" onClick={() => !renameSaving && setShowRename(false)}>
          <div className="bg-white rounded-3xl w-full max-w-md p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-headline font-extrabold text-lg text-[#001e40]">Change your name</h3>
              <button onClick={() => !renameSaving && setShowRename(false)} className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center">
                <span className="material-symbols-outlined text-slate-500 text-base">close</span>
              </button>
            </div>
            <input
              type="text"
              value={renameValue}
              onChange={e => { setRenameValue(e.target.value); setRenameError(null); }}
              onKeyDown={e => { if (e.key === "Enter" && !renameSaving) submitRename(); }}
              maxLength={40}
              autoFocus
              className="w-full px-4 py-3 rounded-xl border-2 border-slate-200 focus:border-[#003366] outline-none text-[#001e40]"
              placeholder="New name"
            />
            {renameError && <p className="text-xs text-[#ba1a1a] mt-2">{renameError}</p>}
            <div className="flex gap-2 mt-5">
              <button
                onClick={() => setShowRename(false)}
                disabled={renameSaving}
                className="flex-1 py-2.5 rounded-xl bg-slate-100 text-[#001e40] text-sm font-bold hover:bg-slate-200 disabled:opacity-50"
              >Cancel</button>
              <button
                onClick={submitRename}
                disabled={renameSaving || renameValue.trim().length < 2}
                className="flex-1 py-2.5 rounded-xl bg-[#003366] text-white text-sm font-bold hover:bg-[#002145] disabled:opacity-50"
              >{renameSaving ? "Saving…" : "Save"}</button>
            </div>
          </div>
        </div>
      )}

      {/* In-app document scanner overlay. Opens when the student taps
          the camera icon on an assignment the parent already printed —
          self-serve scan-back. Wrapped in an error boundary so a
          single render crash inside the scanner doesn't blow up the
          whole homepage. parentId is the student's own id because
          /api/exam/[id]/scan-submit reads the actor from the session
          cookie, not the param. */}
      {scannerTarget && (
        <ScannerErrorBoundary onReset={() => { setScannerTarget(null); fetch(`/api/exam?userId=${userId}`).then(r => r.json()).then(d => setExamPapers(d.papers ?? [])).catch(() => {}); }}>
          <DocumentScanner
            parentId={userId}
            masterPaperId={scannerTarget.masterPaperId}
            studentId={userId}
            studentName={user.name}
            paperTitle={scannerTarget.paperTitle}
            onClose={() => { setScannerTarget(null); fetch(`/api/exam?userId=${userId}`).then(r => r.json()).then(d => setExamPapers(d.papers ?? [])).catch(() => {}); }}
          />
        </ScannerErrorBoundary>
      )}

    </div>
  );
}
