"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExamPaperSummary, SpellingTestSummary, User } from "@/types";
import ExamPaperCard from "@/components/ExamPaperCard";

// ─── Types ────────────────────────────────────────────────────────────────────

type SubjectGap = { subject: string; topics: string[] };
type RecAction = {
  type: string;
  studentId?: string;
  studentName?: string;
  studentLevel?: number | null;
  gaps?: SubjectGap[];
  examType?: string;
  students?: { id: string; name: string; level: number | null }[];
};
type ProgressTopics = Record<string, { earned: number; available: number; count: number }>;
type ProgressData = {
  subjects: Record<string, { examCount: number; topics: ProgressTopics }>;
};
type TopicRow = { topic: string; subject: string; pct: number };
type AdminNotif = { questionId: string; questionNum: string; adminReply: string; paperTitle: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function initials(name: string) {
  return name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

function renderBold(text: string) {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) =>
    i % 2 === 1 ? <strong key={i} className="font-bold text-white/90">{part}</strong> : part
  );
}

function relativeDate(dateStr: string) {
  const d = new Date(dateStr);
  const now = new Date();
  const days = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString("en-SG", { day: "numeric", month: "short" });
}

function activityIcon(paper: ExamPaperSummary) {
  if (paper.paperType === "focused") return "psychology";
  if (paper.paperType === "quiz") return "quiz";
  const s = (paper.subject ?? "").toLowerCase();
  if (s.includes("english")) return "abc";
  if (s.includes("science")) return "science";
  return "description";
}

function scorePct(paper: ExamPaperSummary) {
  if (paper.score === null || !paper.totalMarks) return null;
  const total = parseFloat(paper.totalMarks);
  return total > 0 ? Math.round((paper.score / total) * 100) : null;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ParentDashboard({ userId, user, initialStudentId, initialView, initialOpenQuiz, diagnosticWelcome }: { userId: string; user: User; initialStudentId?: string; initialView?: string; initialOpenQuiz?: boolean; diagnosticWelcome?: boolean }) {
  const router = useRouter();
  const avatarTypeMap: Record<string, string[]> = Object.fromEntries(
    ["bunny","bear","tiger","fox","otter","uni","dragon","merlion","qilin","whitetiger"].map(k => [
      k,
      [1,2,3,4].map(n => `/avatars/${k}${n}.mp4`),
    ])
  );
  const defaultAvatarMap: Record<string, string> = { admin: "bunny", papa: "bear" };
  const nameLower = user.name?.toLowerCase() ?? "";
  const parentAvatarType = (user.settings as Record<string, unknown> | null)?.avatarType as string | undefined ?? defaultAvatarMap[nameLower] ?? null;
  const avatarVideos = parentAvatarType ? (avatarTypeMap[parentAvatarType] ?? null) : null;
  const hasAvatar = !!avatarVideos;
  const [showParentAvatarPicker, setShowParentAvatarPicker] = useState(false);
  const [schedulerPopup, setSchedulerPopup] = useState<{ id: string; title: string; completed: boolean } | null>(null);
  const [quizTargetDay, setQuizTargetDay] = useState<Date | null>(null);

  async function reschedulePaper(paperId: string, newDay: Date) {
    const d = new Date(newDay); d.setHours(9, 0, 0, 0);
    // Optimistic local update
    setExamPapers(prev => prev.map(p => p.id === paperId ? { ...p, scheduledFor: d.toISOString() } : p));
    try {
      await fetch(`/api/exam/${paperId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduledFor: d.toISOString() }),
      });
    } catch {
      // revert on failure
      await refreshPapers();
    }
  }
  const [bunnySrc, setBunnySrc] = useState(() => avatarVideos ? avatarVideos[Math.floor(Math.random() * avatarVideos.length)] : "");
  const [nextSrc, setNextSrc] = useState<string | null>(null);
  const bunnyRef = useRef<HTMLVideoElement>(null);
  const preloadRef = useRef<HTMLVideoElement>(null);
  const nextBunny = () => {
    const cur = bunnySrc;
    let next: string;
    if (!avatarVideos) return;
    do { next = avatarVideos[Math.floor(Math.random() * avatarVideos.length)]; } while (next === cur);
    setNextSrc(next);
  };
  // When preload video is ready, swap it in
  const onPreloadReady = () => {
    if (nextSrc) {
      setBunnySrc(nextSrc);
      setNextSrc(null);
    }
  };
  useEffect(() => {
    const v = bunnyRef.current;
    if (v) { v.currentTime = 0; v.play().catch(() => {}); }
    // Resume on visibility change (iOS pauses background videos)
    function onVisible() {
      if (document.visibilityState === "visible") {
        bunnyRef.current?.play().catch(() => {});
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [bunnySrc]);

  // Data
  const [examPapers, setExamPapers] = useState<ExamPaperSummary[]>([]);
  const [loadingPapers, setLoadingPapers] = useState(true);
  const [progressData, setProgressData] = useState<ProgressData | null>(null);
  const [loadingProgress, setLoadingProgress] = useState(false);
  const [aiInsight, setAiInsight] = useState("");
  const [recActions, setRecActions] = useState<RecAction[]>([]);
  const [recLoading, setRecLoading] = useState(false);

  // UI state
  const [selectedStudentId, setSelectedStudentIdRaw] = useState(
    (initialStudentId && user.linkedStudents.some(s => s.id === initialStudentId))
      ? initialStudentId
      : (user.linkedStudents[0]?.id ?? "")
  );
  // Sync selected student to URL so back-navigation (e.g. from a quiz review)
  // returns the parent to the same student.
  const setSelectedStudentId = (id: string) => {
    setSelectedStudentIdRaw(prev => {
      if (prev === id) return prev;
      const qs = new URLSearchParams(window.location.search);
      if (id) qs.set("student", id);
      else qs.delete("student");
      const url = `/home/${userId}${qs.toString() ? `?${qs.toString()}` : ""}`;
      window.history.replaceState(null, "", url);
      return id;
    });
  };
  const [showStudentMenu, setShowStudentMenu] = useState(false);
  const [, setSettingsTick] = useState(0);
  type ActiveView = "progress" | "papers" | "activities";
  const parseView = (v: string | undefined): ActiveView =>
    v === "papers" || v === "activities" ? v : "progress";
  const [activeView, setActiveViewRaw] = useState<ActiveView>(parseView(initialView));
  // Sync activeView to the URL so browser back/forward, refresh, and deep links all work.
  const setActiveView: typeof setActiveViewRaw = (next) => {
    setActiveViewRaw(prev => {
      const resolved = typeof next === "function" ? (next as (p: ActiveView) => ActiveView)(prev) : next;
      const qs = new URLSearchParams(window.location.search);
      if (resolved === "progress") qs.delete("view");
      else qs.set("view", resolved);
      const url = `/home/${userId}${qs.toString() ? `?${qs.toString()}` : ""}`;
      if (prev !== resolved) window.history.pushState(null, "", url);
      return resolved;
    });
  };
  // On mount, make sure the URL reflects the currently selected student so
  // back-navigation from a quiz/review restores it.
  useEffect(() => {
    if (!selectedStudentId) return;
    const qs = new URLSearchParams(window.location.search);
    if (qs.get("student") !== selectedStudentId) {
      qs.set("student", selectedStudentId);
      const url = `/home/${userId}${qs.toString() ? `?${qs.toString()}` : ""}`;
      window.history.replaceState(null, "", url);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Respond to browser back/forward
  useEffect(() => {
    const handler = () => {
      const qs = new URLSearchParams(window.location.search);
      setActiveViewRaw(parseView(qs.get("view") ?? undefined));
      const sid = qs.get("student");
      if (sid && user.linkedStudents.some(s => s.id === sid)) {
        setSelectedStudentIdRaw(sid);
      }
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Modals
  const [showFocused, setShowFocused] = useState(false);
  const [focusedSubject, setFocusedSubject] = useState<"math" | "science">("math");
  const [focusedType, setFocusedType] = useState<"mcq" | "mcq-oeq">("mcq");
  const [recActing, setRecActing] = useState<string | null>(null);
  const [showQuiz, setShowQuiz] = useState(initialOpenQuiz ?? false);
  const [quizStudentId, setQuizStudentId] = useState(initialStudentId ?? user.linkedStudents[0]?.id ?? "");
  const [quizType, setQuizType] = useState<"mcq" | "mcq-oeq">("mcq");
  const [quizSubject, setQuizSubject] = useState<"math" | "science" | "english">("math");
  const [englishSections, setEnglishSections] = useState<Set<string>>(new Set(["grammar-mcq", "vocab-mcq", "vocab-cloze"]));
  const [assignMode, setAssignMode] = useState<"quiz" | "focused">("quiz");
  const [focusedTopic, setFocusedTopic] = useState("");
  const [customTopic, setCustomTopic] = useState("");
  const [customActing, setCustomActing] = useState(false);
  const [customError, setCustomError] = useState("");
  const [creatingQuiz, setCreatingQuiz] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState("");
  const [showDiagnosticWelcome, setShowDiagnosticWelcome] = useState(() => {
    if (!diagnosticWelcome) return false;
    try {
      const key = `mfy-welcome-shown-${userId}`;
      if (typeof window !== "undefined" && window.localStorage.getItem(key)) return false;
    } catch { /* ignore */ }
    return true;
  });
  useEffect(() => {
    if (!showDiagnosticWelcome) return;
    try {
      if (typeof window !== "undefined") window.localStorage.setItem(`mfy-welcome-shown-${userId}`, "1");
    } catch { /* ignore */ }
  }, [showDiagnosticWelcome, userId]);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [sendingFeedback, setSendingFeedback] = useState(false);
  const [adminNotifs, setAdminNotifs] = useState<AdminNotif[]>([]);
  const [showAdminNotifs, setShowAdminNotifs] = useState(false);
  const [showPendingReview, setShowPendingReview] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [spellingTests, setSpellingTests] = useState<SpellingTestSummary[]>([]);
  const [assigningPaperId, setAssigningPaperId] = useState<string | null>(null);
  const [assignToast, setAssignToast] = useState<string | null>(null);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkTab, setLinkTab] = useState<"share" | "enter">("share");
  const [myCode, setMyCode] = useState<string | null>(null);
  const [myCodeLoading, setMyCodeLoading] = useState(false);
  const [enterCode, setEnterCode] = useState("");
  const [enterLoading, setEnterLoading] = useState(false);
  const [enterError, setEnterError] = useState("");
  const [enterSuccess, setEnterSuccess] = useState(false);

  // Filters for papers view
  const [subjectFilter, setSubjectFilter] = useState<string | null>(null);
  const [examTypeFilter, setExamTypeFilter] = useState<string | null>(null);
  const [expandedWeekDay, setExpandedWeekDay] = useState<number | null>(null);
  const [levelFilter, setLevelFilter] = useState<string | null>(null);

  const hasStudents = user.linkedStudents.length > 0;
  const selectedStudent = user.linkedStudents.find(s => s.id === selectedStudentId);

  // ── Fetches ──────────────────────────────────────────────────────────────

  const refreshPapers = useCallback(async () => {
    const res = await fetch(`/api/exam?userId=${userId}`);
    if (res.ok) setExamPapers((await res.json()).papers ?? []);
    setLoadingPapers(false);
  }, [userId]);

  useEffect(() => { refreshPapers(); }, [refreshPapers]);

  // Keep quiz modal target student in sync with the currently selected student
  useEffect(() => { if (selectedStudentId) setQuizStudentId(selectedStudentId); }, [selectedStudentId]);

  useEffect(() => {
    if (!selectedStudentId) return;
    setLoadingProgress(true);
    setProgressData(null);
    fetch(`/api/student-progress?parentId=${userId}&studentId=${selectedStudentId}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setProgressData(d))
      .catch(() => {})
      .finally(() => setLoadingProgress(false));
    // Fetch spelling tests for selected student
    fetch(`/api/tests?userId=${selectedStudentId}`)
      .then(r => r.ok ? r.json() : { tests: [] })
      .then(d => setSpellingTests(d.tests ?? []))
      .catch(() => setSpellingTests([]));
  }, [userId, selectedStudentId]);

  const recFetchingRef = useRef<string | null>(null);
  function fetchInsight(forceRefresh = false) {
    if (!selectedStudentId || recFetchingRef.current === selectedStudentId) return;
    const key = `recs-fetched-${selectedStudentId}`;
    if (!forceRefresh) {
      const cached = localStorage.getItem(key);
      if (cached && JSON.parse(cached).date === new Date().toDateString()) {
        setAiInsight(JSON.parse(cached).insight);
        return;
      }
    }
    recFetchingRef.current = selectedStudentId;
    setAiInsight("");
    setRecLoading(true);
    fetch(`/api/parent-recommendations?parentId=${userId}&studentId=${selectedStudentId}&hour=${new Date().getHours()}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const insight = d?.greeting ?? "";
        if (insight) {
          setAiInsight(insight);
          localStorage.setItem(key, JSON.stringify({ date: new Date().toDateString(), insight }));
        }
        if (d?.actions?.length) setRecActions(d.actions);
      })
      .catch(() => {})
      .finally(() => { recFetchingRef.current = null; setRecLoading(false); });
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchInsight(); }, [userId, selectedStudentId]);

  useEffect(() => {
    fetch(`/api/notifications?userId=${userId}`)
      .then(r => r.ok ? r.json() : [])
      .then((data: AdminNotif[]) => { if (data.length > 0) { setAdminNotifs(data); setShowAdminNotifs(true); } })
      .catch(() => {});
  }, [userId]);

  async function handleDeletePaper(e: React.MouseEvent, paperId: string) {
    e.stopPropagation();
    if (!confirm("Delete this quiz/practice?")) return;
    try {
      await fetch(`/api/exam/${paperId}?userId=${userId}`, { method: "DELETE" });
      setExamPapers(prev => prev.filter(p => p.id !== paperId));
    } catch { /* silent */ }
  }

  async function handleRemarkPaper(e: React.MouseEvent, paperId: string) {
    e.stopPropagation();
    if (!confirm("Marking is stuck or taking too long. Force a re-mark now?")) return;
    try {
      const res = await fetch(`/api/exam/${paperId}/mark`, { method: "POST" });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        alert(`Re-mark failed (HTTP ${res.status}): ${body || "no body"}`);
        return;
      }
      setAssignToast("Re-mark requested — refresh in a moment");
      setTimeout(() => setAssignToast(null), 3000);
    } catch (err) {
      alert(`Re-mark failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Link modal helpers ────────────────────────────────────────────────────

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
      setTimeout(() => { setShowLinkModal(false); router.refresh(); }, 1500);
    } catch { setEnterError("Something went wrong"); }
    finally { setEnterLoading(false); }
  }

  // ── Derived metrics ───────────────────────────────────────────────────────

  const studentPapers = examPapers.filter(p => p.assignedToId === selectedStudentId);
  const completedPapers = studentPapers.filter(p => p.completedAt);
  const pendingRelease = completedPapers.filter(p => p.markingStatus === "complete");
  const scoredPapers = completedPapers.filter(p => p.score !== null && p.totalMarks && parseFloat(p.totalMarks) > 0);
  const avgScore = scoredPapers.length > 0
    ? Math.round(scoredPapers.reduce((s, p) => s + (p.score! / parseFloat(p.totalMarks!) * 100), 0) / scoredPapers.length)
    : null;

  // ── Performance chart data (up to 5 most recent per subject, right-aligned) ──
  const SUBJ_COLORS: Record<string, string> = { math: "#006c49", science: "#3a5f94", english: "#001e40" };
  const SUBJ_LABELS: Record<string, string> = { math: "Math", science: "Science", english: "English" };
  const MAX_CHART_PTS = 5;
  type ChartLine = { subject: string; color: string; label: string; points: number[]; count: number; avg: number };
  const chartLines: ChartLine[] = (() => {
    // Group scored papers by subject, sorted by completedAt asc
    const bySubj: Record<string, number[]> = {};
    const sorted = [...scoredPapers].sort((a, b) => new Date(a.completedAt!).getTime() - new Date(b.completedAt!).getTime());
    for (const p of sorted) {
      const subj = (p.subject ?? "").toLowerCase();
      const key = subj.includes("math") ? "math" : subj.includes("sci") ? "science" : subj.includes("eng") ? "english" : null;
      if (!key) continue;
      if (!bySubj[key]) bySubj[key] = [];
      bySubj[key].push(Math.round((p.score! / parseFloat(p.totalMarks!)) * 100));
    }
    const lines: ChartLine[] = [];
    for (const [subj, scores] of Object.entries(bySubj)) {
      if (scores.length < 2) continue; // need at least 2 to chart
      const pts = scores.slice(-MAX_CHART_PTS);
      const avg = Math.round(pts.reduce((a, b) => a + b, 0) / pts.length);
      lines.push({ subject: subj, color: SUBJ_COLORS[subj] ?? "#737780", label: SUBJ_LABELS[subj] ?? subj, points: pts, count: pts.length, avg });
    }
    return lines;
  })();
  const showChart = chartLines.length > 0;
  const chartMaxPts = showChart ? Math.max(...chartLines.map(l => l.count)) : 0;
  const overallChartAvg = showChart ? Math.round(chartLines.reduce((s, l) => s + l.avg, 0) / chartLines.length) : null;

  const recentActivities = [...completedPapers]
    .sort((a, b) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime())
    .slice(0, 3);

  const allTopics: TopicRow[] = [];
  if (progressData?.subjects) {
    for (const [subj, subData] of Object.entries(progressData.subjects)) {
      for (const [topic, tData] of Object.entries(subData.topics)) {
        if (topic === "Untagged" || tData.available === 0) continue;
        allTopics.push({ topic, subject: subj, pct: Math.round((tData.earned / tData.available) * 100) });
      }
    }
  }
  allTopics.sort((a, b) => b.pct - a.pct);
  const strongTopics = allTopics.filter(t => t.pct >= 75).slice(0, 2);
  const weakTopics = allTopics.filter(t => t.pct < 65).slice(0, 2);

  const threeDaysAgo = new Date(); threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  const recentQuizCount = completedPapers.filter(p =>
    (p.paperType === "quiz" || p.paperType === "focused") &&
    p.completedAt && new Date(p.completedAt) >= threeDaysAgo
  ).length;

  const focusedGapRec = recActions.find(r => r.type === "focused-gap" && r.studentId === selectedStudentId)
    ?? recActions.find(r => r.type === "focused-gap");

  const insightForCard = aiInsight
    || (completedPapers.length === 0
      ? `Start assigning a daily quiz for AI to diagnose ${selectedStudent?.name ?? "your child"}'s strengths and gaps.`
      : `${selectedStudent?.name ?? "Your child"} has averaged ${avgScore}% across ${completedPapers.length} completed ${completedPapers.length === 1 ? "paper" : "papers"}.`);

  // Weekly schedule helpers (Sunday to Saturday)
  const todayDate = new Date();
  const dayOfWeek = todayDate.getDay(); // 0=Sun
  const sunday = new Date(todayDate);
  sunday.setDate(todayDate.getDate() - dayOfWeek);
  const weekDays = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(sunday); d.setDate(sunday.getDate() + i); return d;
  });
  const DAY_LABELS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const isToday = (d: Date) => d.toDateString() === todayDate.toDateString();

  // Group student papers by day of week for scheduler (by scheduledFor, falling back to createdAt)
  const papersByDay = weekDays.map(d => {
    const dayStr = d.toDateString();
    const forDay = studentPapers.filter(p => new Date(p.scheduledFor ?? p.createdAt).toDateString() === dayStr);
    // Undone first, done below
    return forDay.sort((a, b) => Number(!!a.completedAt) - Number(!!b.completedAt));
  });

  function shortenTitle(title: string) {
    return title
      .replace(/^P\d+\s+/, "")
      .replace(/Daily Quiz –\s*/, "")
      .replace(/\s*\(MCQ\)$/, "")
      .replace(/\s*\(MCQ \+ OEQ\)$/, " +OEQ")
      .replace(/Quiz MCQ \+ OEQ$/, "Quiz +OEQ")
      .replace(/Quiz MCQ$/, "Quiz")
      .slice(0, 20);
  }

  // Master papers (not assigned = available to assign)
  // English exam papers are temporarily disabled from the parent Set Papers flow
  const masterPapers = examPapers.filter(p => !p.assignedToId && p.paperType === null && !(p.subject ?? "").toLowerCase().includes("english") && !p.title.startsWith("[Synthetic Bank]"));

  // Available subjects and exam types from master papers (dedup case-insensitively, keep first casing seen)
  const dedupKeepFirst = (vals: (string | null)[]) => {
    const seen = new Map<string, string>();
    for (const v of vals) {
      if (!v) continue;
      const k = v.trim().toLowerCase();
      if (!seen.has(k)) seen.set(k, v.trim());
    }
    return Array.from(seen.values());
  };
  const availableSubjects = dedupKeepFirst(masterPapers.map(p => p.subject));
  const availableExamTypes = dedupKeepFirst(masterPapers.map(p => p.examType));

  // Filtered papers for Set Papers view — filter by selected student's level + subject + examType
  const selectedStudentLevel = selectedStudent?.level ?? null;
  const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
  const filteredPapers = masterPapers.filter(p => {
    if (subjectFilter && norm(p.subject) !== norm(subjectFilter)) return false;
    if (examTypeFilter && norm(p.examType) !== norm(examTypeFilter)) return false;
    // Only show papers matching the selected student's level
    if (selectedStudentLevel && p.level && !p.level.includes(String(selectedStudentLevel))) return false;
    return true;
  });

  // ── Early: no students ────────────────────────────────────────────────────

  if (!hasStudents) {
    return (
      <div className="min-h-screen bg-[#f8f9ff] flex flex-col items-center justify-center p-8 text-center">
        <div className="w-16 h-16 rounded-3xl bg-[#003366] flex items-center justify-center mb-6">
          <span className="material-symbols-outlined text-white text-3xl" style={{ fontVariationSettings: "'FILL' 1" }}>family_restroom</span>
        </div>
        <h2 className="font-headline text-2xl font-extrabold text-[#001e40] mb-3">Let&apos;s create a student account for your child</h2>
        <p className="text-[#43474f] mb-6 max-w-xs text-sm leading-relaxed">Create your child&apos;s account to start assigning quizzes and tracking progress.</p>
        <div className="flex flex-col gap-3 w-full max-w-xs">
          <button
            onClick={() => router.push(`/register/student?parentId=${userId}`)}
            className="px-6 py-3 rounded-xl bg-[#003366] text-white font-bold hover:bg-[#001e40] transition-colors shadow-lg flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined text-base">person_add</span>
            Create Student Account
          </button>
          <button
            onClick={() => openLinkModal("share")}
            className="px-6 py-3 rounded-xl border-2 border-[#003366]/20 text-[#003366] font-bold hover:bg-[#eff4ff] transition-colors flex items-center justify-center gap-2"
          >
            <span className="material-symbols-outlined text-base">link</span>
            Link Existing Student
          </button>
        </div>
        <Link href="/" className="mt-6 text-sm text-[#43474f] underline">Back to home</Link>

        {/* Link modal */}
        {showLinkModal && (
          <div className="fixed inset-0 bg-black/40 flex items-end lg:items-center justify-center z-50 p-4 pb-20 lg:pb-4" onClick={() => setShowLinkModal(false)}>
            <div className="bg-white rounded-3xl w-full max-w-lg p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-5">
                <h3 className="font-headline font-extrabold text-lg text-[#001e40]">Link with Student</h3>
                <button onClick={() => setShowLinkModal(false)} className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center">
                  <span className="material-symbols-outlined text-slate-500 text-base">close</span>
                </button>
              </div>
              <div className="flex gap-1 bg-slate-100 p-1 rounded-xl mb-5">
                {(["share", "enter"] as const).map(t => (
                  <button key={t} onClick={() => { setLinkTab(t); if (t === "share" && !myCode) fetchMyCode(); }}
                    className={`flex-1 py-2 rounded-lg text-sm font-bold transition-all ${linkTab === t ? "bg-white text-[#001e40] shadow-sm" : "text-slate-500"}`}>
                    {t === "share" ? "My Code" : "Enter Code"}
                  </button>
                ))}
              </div>
              {linkTab === "share" ? (
                <div className="text-center">
                  <p className="text-xs text-slate-400 mb-4">Share this code with your student so they can link with you.</p>
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
                        <button onClick={() => {
                            try {
                              if (navigator.clipboard?.writeText) {
                                navigator.clipboard.writeText(myCode).then(() => {
                                  alert("Code copied!");
                                }).catch(() => {
                                  prompt("Copy this code:", myCode);
                                });
                              } else {
                                prompt("Copy this code:", myCode);
                              }
                            } catch { prompt("Copy this code:", myCode); }
                          }}
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
                  <p className="text-xs text-slate-400 mb-3">Enter the code from your student.</p>
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
                  {enterSuccess && <p className="text-xs text-[#006c49] font-semibold">Linked! Refreshing...</p>}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Modals ────────────────────────────────────────────────────────────────

  const FocusedModal = () => {
    if (!showFocused) return null;
    const subjectTopics = allTopics
      .filter(t => t.subject.toLowerCase().includes(focusedSubject === "math" ? "math" : "science") && t.pct < 65)
      .slice(0, 3);
    const targetStudentId = selectedStudentId ?? user.linkedStudents[0]?.id;
    // customTopic, customActing, customError hoisted to parent component
    async function handleCustom() {
      const topic = customTopic.trim();
      if (!topic) return;
      setCustomActing(true);
      setCustomError("");
      try {
        const res = await fetch("/api/focused-test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parentId: userId, studentId: targetStudentId, subject: focusedSubject === "math" ? "Mathematics" : "Science", topic, type: focusedType }),
        });
        if (!res.ok) { const d = await res.json(); setCustomError(d.error ?? "No questions found"); return; }
        await refreshPapers();
        setShowFocused(false);
      } finally { setCustomActing(false); }
    }
    return (
      <div className="fixed inset-0 bg-black/50 flex items-end lg:items-center justify-center z-[60] p-4" onClick={() => setShowFocused(false)}>
        <div className="bg-white rounded-t-3xl lg:rounded-3xl w-full max-w-sm p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
          <h3 className="font-headline text-lg font-extrabold text-[#001e40] mb-1">Focused Practice</h3>
          <p className="text-sm text-[#43474f] mb-4">Create a 10-question test on a weak topic.</p>

          {/* Subject toggle */}
          <p className="text-xs font-extrabold text-[#43474f] uppercase tracking-wider mb-2">Subject</p>
          <div className="flex gap-2 mb-4">
            {(["math", "science"] as const).map(s => (
              <button key={s} onClick={() => setFocusedSubject(s)}
                className={`flex-1 py-2.5 rounded-xl border-2 text-sm font-medium transition-all ${focusedSubject === s ? "border-[#003366] bg-[#eff4ff] text-[#003366]" : "border-[#c3c6d1] text-[#43474f]"}`}>
                {s === "math" ? "Mathematics" : "Science"}
              </button>
            ))}
          </div>

          {/* Type toggle */}
          <p className="text-xs font-extrabold text-[#43474f] uppercase tracking-wider mb-2">Question Type</p>
          <div className="flex gap-2 mb-5">
            {(["mcq", "mcq-oeq"] as const).map(t => (
              <button key={t} onClick={() => setFocusedType(t)}
                className={`flex-1 py-2.5 rounded-xl border-2 text-sm font-medium transition-all ${focusedType === t ? "border-[#003366] bg-[#eff4ff] text-[#003366]" : "border-[#c3c6d1] text-[#43474f]"}`}>
                {t === "mcq" ? "MCQ" : "MCQ + OEQ"}
              </button>
            ))}
          </div>

          {/* Top 3 weak topics */}
          <p className="text-xs font-extrabold text-[#43474f] uppercase tracking-wider mb-2">Weakest Topics</p>
          {subjectTopics.length > 0 ? (
            <div className="space-y-2 mb-4">
              {subjectTopics.map((t) => {
                const key = `${t.subject}-${t.topic}`;
                return (
                  <div key={key} className="flex items-center gap-3 p-3 bg-[#eff4ff] rounded-xl">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-[#001e40] truncate">{t.topic}</p>
                      <p className="text-xs text-[#43474f]">{t.pct}% mastery</p>
                    </div>
                    <button
                      disabled={recActing === key}
                      onClick={async () => {
                        setRecActing(key);
                        try {
                          await fetch("/api/focused-test", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ parentId: userId, studentId: targetStudentId, subject: t.subject, topic: t.topic, type: focusedType }),
                          });
                          await refreshPapers();
                          setShowFocused(false);
                        } finally { setRecActing(null); }
                      }}
                      className="px-3 py-1.5 rounded-lg bg-[#003366] text-white text-xs font-bold disabled:opacity-50 shrink-0"
                    >
                      {recActing === key ? "…" : "Assign →"}
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-[#43474f] py-2 text-center">No auto-detected weak topics. Choose one below.</p>
          )}

          {/* Topic selection — dropdown or manual entry */}
          <p className="text-xs font-extrabold text-[#43474f] uppercase tracking-wider mb-2">Choose Topic</p>
          <div className="flex gap-2 mb-1">
            <select
              value={customTopic}
              onChange={e => { setCustomTopic(e.target.value); setCustomError(""); }}
              className="flex-1 min-w-0 px-3 py-2 rounded-xl border-2 border-[#c3c6d1] text-sm focus:border-[#003366] focus:outline-none bg-white truncate"
            >
              <option value="">Select a topic…</option>
              {(focusedSubject === "math"
                ? ["Basic math operations", "Fractions", "Percentage", "Ratio", "Algebra", "Area and circumference of circle", "Volume of cube and cuboid", "Geometry", "Statistics", "Time", "Volume measurement"]
                : ["Diversity of living and non-living things", "Diversity of materials", "Life cycles in plants and animals", "Plant parts and functions", "Human digestive system", "Cycles in matter", "Water cycle, evaporation, condensation", "Plant respiratory and circulatory systems", "Human respiratory and circulatory systems", "Reproduction in plants and animals", "Light energy and uses", "Heat energy and uses", "Electrical system and circuits", "Photosynthesis", "Energy conversion", "Interaction of forces (Magnets)", "Interaction of forces (Frictional force, gravitational force, elastic spring force)", "Interactions within the environment"]
              ).map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <button
              onClick={handleCustom}
              disabled={!customTopic.trim() || customActing}
              className="px-4 py-2 rounded-xl bg-[#003366] text-white text-sm font-bold disabled:opacity-50"
            >
              {customActing ? "…" : "Go"}
            </button>
          </div>
          {customError && <p className="text-xs text-[#ba1a1a] mb-2">{customError}</p>}

          <button onClick={() => setShowFocused(false)} className="w-full mt-3 py-3 rounded-xl border-2 border-[#c3c6d1] text-[#001e40] font-bold text-sm">Close</button>
        </div>
      </div>
    );
  };

  const QuizModal = () => !showQuiz ? null : (
    <div className="fixed inset-0 bg-black/50 flex items-end lg:items-center justify-center z-[60] p-4" onClick={() => { setShowQuiz(false); setQuizTargetDay(null); }}>
      <div className="bg-white rounded-t-3xl lg:rounded-3xl w-full max-w-sm p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
        <h3 className="font-headline text-lg font-extrabold text-[#001e40] mb-1">{assignMode === "quiz" ? "Assign Daily Quiz" : "Assign Focused Practice"}</h3>
        <p className="text-sm text-[#43474f] mb-4">
          For <span className="font-bold text-[#001e40]">{selectedStudent?.name ?? "student"}</span>{selectedStudent?.level ? ` (P${selectedStudent.level})` : ""}
          {quizTargetDay && <> · <span className="font-bold text-[#003366]">{quizTargetDay.toLocaleDateString(undefined, { weekday: "long" })}</span></>}
        </p>
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
        {assignMode === "focused" && quizSubject !== "english" && (() => {
          const weakDetected = allTopics
            .filter(t => t.subject.toLowerCase().includes(quizSubject === "math" ? "math" : "science") && t.pct < 65)
            .slice(0, 3);
          return (
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
              {weakDetected.length > 0 && (
                <div className="mb-4">
                  <p className="text-xs font-extrabold text-[#43474f] uppercase tracking-wider mb-2">Weakest Topics</p>
                  <div className="space-y-1.5">
                    {weakDetected.map(t => (
                      <button key={t.topic} onClick={() => setFocusedTopic(t.topic)}
                        className={`w-full flex items-center justify-between text-left px-3 py-2 rounded-xl border-2 transition-all ${focusedTopic === t.topic ? "border-[#006c49] bg-[#6cf8bb]/20" : "border-[#c3c6d1] bg-white"}`}>
                        <span className="text-sm font-bold text-[#001e40] truncate pr-2">{t.topic}</span>
                        <span className="text-xs text-[#ba1a1a] font-extrabold shrink-0">{t.pct}%</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="mb-5">
                <p className="text-xs font-extrabold text-[#43474f] uppercase tracking-wider mb-2">Or Choose Topic</p>
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
          );
        })()}
        {assignMode === "quiz" && (<>
        <p className="text-xs font-extrabold text-[#43474f] uppercase tracking-wider mb-2">Type</p>
        {quizSubject !== "english" ? (<>
          {(() => {
            const MCQ_ONLY_BLOCKED = new Set(["cmmbbyvs30004qa9yinn3drl6", "cmm5wf91d000ryrxwaddlo6xh"]);
            const mcqBlocked = MCQ_ONLY_BLOCKED.has(quizStudentId);
            // Auto-flip to mcq-oeq if selected student is blocked
            if (mcqBlocked && quizType === "mcq") setTimeout(() => setQuizType("mcq-oeq"), 0);
            return (
              <div className="flex gap-2 mb-5">
                <button onClick={() => { if (!mcqBlocked) setQuizType("mcq"); }} disabled={mcqBlocked}
                  className={`flex-1 py-2.5 rounded-xl border-2 text-sm font-medium ${mcqBlocked ? "border-[#c3c6d1]/40 text-[#c3c6d1]/60 opacity-50 cursor-not-allowed" : quizType === "mcq" ? "border-[#006c49] bg-[#6cf8bb]/20 text-[#006c49]" : "border-[#c3c6d1] text-[#43474f]"}`}>
                  MCQ Only
                </button>
                <button onClick={() => setQuizType("mcq-oeq")}
                  className={`flex-1 py-2.5 rounded-xl border-2 text-sm font-medium ${quizType === "mcq-oeq" ? "border-[#006c49] bg-[#6cf8bb]/20 text-[#006c49]" : "border-[#c3c6d1] text-[#43474f]"}`}>
                  MCQ + Written
                </button>
              </div>
            );
          })()}
          {quizType === "mcq-oeq" && (
            <p className="text-[10px] text-[#c3c6d1] -mt-3 mb-4 flex items-center gap-1">
              <span className="material-symbols-outlined text-xs">stylus_note</span>
              Stylus recommended for written questions
            </p>
          )}
        </>) : (
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
        </>)}
        <div className="flex gap-3">
          <button onClick={() => { setShowQuiz(false); setQuizTargetDay(null); }} className="flex-1 py-3 rounded-xl border-2 border-[#c3c6d1] text-[#001e40] font-bold">Cancel</button>
          <button
            disabled={creatingQuiz || !quizStudentId || (assignMode === "focused" && quizSubject !== "english" && !focusedTopic) || (assignMode === "focused" && quizSubject === "english" && englishSections.size !== 1)}
            onClick={async () => {
              setCreatingQuiz(true);
              try {
                const scheduledForIso = quizTargetDay ? (() => { const d = new Date(quizTargetDay); d.setHours(9, 0, 0, 0); return d.toISOString(); })() : undefined;
                if (assignMode === "focused") {
                  if (quizSubject === "english") {
                    // Focused English: doubled single-section quiz via daily-quiz
                    const res = await fetch("/api/daily-quiz", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        userId: quizStudentId,
                        quizType: "mcq",
                        subject: "english",
                        englishSections: [...englishSections],
                        focused: true,
                        ...(scheduledForIso ? { scheduledFor: scheduledForIso } : {}),
                      }),
                    });
                    const data = await res.json();
                    if (!res.ok) { alert(data.error || "Failed"); return; }
                    setShowQuiz(false); setQuizTargetDay(null);
                    await refreshPapers();
                    return;
                  }
                  const res = await fetch("/api/focused-test", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      parentId: userId,
                      studentId: quizStudentId,
                      subject: quizSubject === "math" ? "Mathematics" : "Science",
                      topic: focusedTopic,
                      type: focusedType,
                      ...(scheduledForIso ? { scheduledFor: scheduledForIso } : {}),
                    }),
                  });
                  const data = await res.json();
                  if (!res.ok) { alert(data.error || "Failed"); return; }
                  setShowQuiz(false); setQuizTargetDay(null); setFocusedTopic("");
                  await refreshPapers();
                  return;
                }
                const res = await fetch("/api/daily-quiz", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    userId: quizStudentId,
                    quizType: quizSubject === "english" ? "mcq" : quizType,
                    subject: quizSubject,
                    ...(quizSubject === "english" && englishSections.size > 0 ? { englishSections: [...englishSections] } : {}),
                    ...(scheduledForIso ? { scheduledFor: scheduledForIso } : {}),
                  }),
                });
                const data = await res.json();
                if (!res.ok) { alert(data.error || "Failed"); return; }
                setShowQuiz(false);
                setQuizTargetDay(null);
                // First-time user: auto-open student tab only if this student has no prior quizzes
                const studentHasPriorQuizzes = examPapers.some(p => p.assignedToId === quizStudentId && p.paperType === "quiz");
                if (!studentHasPriorQuizzes) {
                  window.open(`/home/${quizStudentId}?firstQuiz=1`, "_blank");
                }
                await refreshPapers();
              } catch { alert("Something went wrong"); }
              finally { setCreatingQuiz(false); }
            }}
            className="flex-1 py-3 rounded-xl bg-[#006c49] text-white font-bold disabled:opacity-50 flex items-center justify-center gap-2">
            {creatingQuiz && <span className="inline-block w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
            {creatingQuiz ? "Creating…" : assignMode === "focused" ? "Assign Practice" : "Assign Quiz"}
          </button>
        </div>
      </div>
    </div>
  );

  const FeedbackModal = () => !showFeedback ? null : (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4" onClick={() => setShowFeedback(false)}>
      <div className="bg-white rounded-3xl p-6 max-w-sm w-full shadow-2xl" onClick={e => e.stopPropagation()}>
        {feedbackSent ? (
          <>
            <p className="text-center font-extrabold text-[#001e40] mb-4">Thank you for your feedback! 🙏</p>
            <button onClick={() => { setShowFeedback(false); setFeedbackSent(false); setFeedbackMsg(""); }}
              className="w-full py-3 rounded-xl bg-[#003366] text-white font-bold">Close</button>
          </>
        ) : (
          <>
            <h3 className="font-headline font-extrabold text-[#001e40] mb-4">Give Feedback</h3>
            <textarea value={feedbackMsg} onChange={e => setFeedbackMsg(e.target.value)}
              placeholder="Tell us what you think or what you'd like to see..."
              rows={4} className="w-full border border-[#c3c6d1] rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:border-[#003366] mb-3" />
            <div className="flex gap-3">
              <button onClick={() => setShowFeedback(false)} className="flex-1 py-3 rounded-xl border-2 border-[#c3c6d1] text-[#001e40] font-bold">Cancel</button>
              <button
                disabled={!feedbackMsg.trim() || sendingFeedback}
                onClick={async () => {
                  setSendingFeedback(true);
                  try {
                    await fetch("/api/feedback", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId, message: feedbackMsg }) });
                    setFeedbackSent(true);
                  } finally { setSendingFeedback(false); }
                }}
                className="flex-1 py-3 rounded-xl bg-[#003366] text-white font-bold disabled:opacity-50">
                {sendingFeedback ? "Sending..." : "Send"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );

  const SettingsModal = () => {
    if (!showSettings) return null;
    const student = selectedStudent;
    if (!student) return null;
    const sSettings = (student.settings ?? {}) as Record<string, unknown>;
    const skipReviewPerfect = sSettings.skipReviewPerfect === true;
    const studentQuizMode = (sSettings.studentQuizMode as string) ?? "all";

    async function updateStudentSetting(key: string, value: unknown) {
      await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: student!.id, settings: { [key]: value } }),
      });
      // Update local state
      if (student) student.settings = { ...(student.settings ?? {}), [key]: value } as typeof student.settings;
      setSettingsTick(t => t + 1);
    }

    return (
      <div className="fixed inset-0 bg-black/50 flex items-end lg:items-center justify-center z-[60] p-4" onClick={() => setShowSettings(false)}>
        <div className="bg-white rounded-t-3xl lg:rounded-3xl w-full max-w-sm p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
          <h3 className="font-headline text-lg font-extrabold text-[#001e40] mb-1">Settings</h3>
          <p className="text-sm text-[#43474f] mb-5">For {student.name}</p>

          {/* Skip review for 100% */}
          <div className="flex items-center justify-between py-3 border-b border-[#e5eeff]">
            <div>
              <p className="text-sm font-bold text-[#001e40]">Skip review for 100% score</p>
              <p className="text-xs text-[#43474f]">Auto-release papers with perfect score</p>
            </div>
            <button
              onClick={() => updateStudentSetting("skipReviewPerfect", !skipReviewPerfect)}
              className={`w-12 h-7 rounded-full transition-colors relative ${skipReviewPerfect ? "bg-[#006c49]" : "bg-[#c3c6d1]"}`}
            >
              <div className={`w-5 h-5 rounded-full bg-white shadow absolute top-1 transition-transform ${skipReviewPerfect ? "translate-x-6" : "translate-x-1"}`} />
            </button>
          </div>

          {/* Student self-learning */}
          <div className="py-3">
            <p className="text-sm font-bold text-[#001e40] mb-1">Student self-learning</p>
            <p className="text-xs text-[#43474f] mb-3">Control whether the student can create their own quizzes</p>
            <div className="space-y-2">
              {([
                { key: "none", label: "Student cannot create quizzes" },
                { key: "oeq-only", label: "Student can create MCQ+OEQ quizzes only" },
                { key: "all", label: "Student can create MCQ or MCQ+OEQ quizzes" },
              ] as const).map(opt => (
                <button
                  key={opt.key}
                  onClick={() => updateStudentSetting("studentQuizMode", opt.key)}
                  className={`w-full text-left px-4 py-3 rounded-xl border-2 text-sm font-medium transition-all ${
                    studentQuizMode === opt.key ? "border-[#003366] bg-[#eff4ff] text-[#003366]" : "border-[#c3c6d1] text-[#43474f]"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <button onClick={() => setShowSettings(false)} className="w-full mt-4 py-3 rounded-xl bg-[#003366] text-white font-bold">Done</button>
        </div>
      </div>
    );
  };

  const AdminNotifModal = () => !showAdminNotifs || adminNotifs.length === 0 ? null : (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60] p-4">
      <div className="bg-white rounded-3xl p-6 max-w-sm w-full shadow-2xl space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-[#003366] flex items-center justify-center">
            <span className="material-symbols-outlined text-white text-lg">chat</span>
          </div>
          <h3 className="font-headline font-extrabold text-[#001e40]">Message from Admin</h3>
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
  );

  // ── Student selector dropdown ──────────────────────────────────────────────

  const StudentDropdown = () => (
    <div className="absolute top-full left-0 right-0 mt-2 bg-white rounded-2xl shadow-xl border border-[#c3c6d1]/30 z-30 overflow-hidden">
      {user.linkedStudents.map(s => (
        <button key={s.id} onClick={() => { setSelectedStudentId(s.id); setShowStudentMenu(false); }}
          className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-[#eff4ff] transition-colors ${s.id === selectedStudentId ? "bg-[#eff4ff]" : ""}`}>
          <div className="w-8 h-8 rounded-full bg-[#003366] flex items-center justify-center text-white text-xs font-bold shrink-0">{initials(s.name)}</div>
          <span className="font-medium text-[#001e40]">{s.name}</span>
          {s.id === selectedStudentId && <span className="material-symbols-outlined text-[#006c49] text-base ml-auto">check</span>}
        </button>
      ))}
      <button onClick={() => { setShowStudentMenu(false); window.open(`/register/student?parentId=${userId}`, "_blank"); }}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[#eff4ff] border-t border-[#c3c6d1]/30">
        <div className="w-8 h-8 rounded-full bg-[#eff4ff] flex items-center justify-center shrink-0">
          <span className="material-symbols-outlined text-[#001e40] text-base">add</span>
        </div>
        <span className="text-sm font-medium text-[#001e40]">Add Student</span>
      </button>
      <button onClick={() => { setShowStudentMenu(false); openLinkModal("share"); }}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[#eff4ff] border-t border-[#c3c6d1]/30">
        <div className="w-8 h-8 rounded-full bg-[#eff4ff] flex items-center justify-center shrink-0">
          <span className="material-symbols-outlined text-[#001e40] text-base">link</span>
        </div>
        <span className="text-sm font-medium text-[#001e40]">Link Student</span>
      </button>
    </div>
  );

  // ── Shared content blocks ─────────────────────────────────────────────────

  const MetricsGrid = () => (
    <div className="space-y-4">
      {showChart ? (
        <div className="bg-white p-5 rounded-[2rem] shadow-[0_20px_40px_rgba(11,28,48,0.06)]">
          <div className="flex justify-between items-start mb-3">
            <div>
              <h3 className="font-headline text-base font-bold text-[#001e40]">Average Performance</h3>
              <p className="text-[#43474f] text-[10px]">Last {chartMaxPts} papers per subject</p>
            </div>
            <p className="font-headline text-2xl font-extrabold text-[#001e40]">
              {overallChartAvg}<span className="text-xs font-normal text-[#006c49] ml-0.5">%</span>
            </p>
          </div>
          <div className="relative min-h-[110px]">
            <svg viewBox="0 0 330 120" className="w-full h-full overflow-visible" preserveAspectRatio="none">
              <text x="22" y="9" textAnchor="end" fontSize="8" fill="#737780" fontFamily="Inter, sans-serif">100</text>
              <text x="22" y="64" textAnchor="end" fontSize="8" fill="#737780" fontFamily="Inter, sans-serif">50</text>
              <text x="22" y="118" textAnchor="end" fontSize="8" fill="#737780" fontFamily="Inter, sans-serif">0</text>
              <line x1="30" y1="5" x2="330" y2="5" stroke="#e5eeff" strokeWidth="0.5" />
              <line x1="30" y1="60" x2="330" y2="60" stroke="#e5eeff" strokeWidth="0.5" />
              <line x1="30" y1="115" x2="330" y2="115" stroke="#e5eeff" strokeWidth="0.5" />
              {chartLines.map(line => {
                const yScale = (pct: number) => 115 - (pct / 100) * 110;
                const pts = line.points;
                const n = pts.length;
                const chartW = 300;
                const offsetX = 30;
                const slotW = chartMaxPts > 1 ? chartW / (chartMaxPts - 1) : chartW;
                const startSlot = chartMaxPts - n;
                const coords = pts.map((pct, i) => ({ x: offsetX + (startSlot + i) * slotW, y: yScale(pct) }));
                const d = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x} ${c.y}`).join(" ");
                return (
                  <g key={line.subject}>
                    <path d={d} fill="none" stroke={line.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                    {coords.map((c, i) => (
                      <circle key={i} cx={c.x} cy={c.y} r={i === n - 1 ? 3.5 : 3} fill={line.color} />
                    ))}
                  </g>
                );
              })}
            </svg>
          </div>
          <div className="mt-3 flex gap-3 border-t border-[#e5eeff] pt-2 flex-wrap">
            {chartLines.map(l => (
              <div key={l.subject} className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full" style={{ background: l.color }} />
                <span className="text-[10px] text-[#43474f] font-medium">{l.label} {l.avg}%</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="bg-white p-6 rounded-[2rem] shadow-[0_20px_40px_rgba(11,28,48,0.06)]">
          <p className="text-xs font-extrabold text-[#006c49] mb-1 tracking-wider uppercase">Avg Score</p>
          {avgScore !== null ? (
            <>
              <div className="flex items-end gap-1">
                <span className="font-headline text-3xl font-extrabold text-[#001e40]">{avgScore}</span>
                <span className="text-lg font-bold text-[#001e40] mb-1">%</span>
              </div>
              <div className="mt-3 w-full h-1.5 bg-[#dce9ff] rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-[#006c49] to-[#4edea3] rounded-full transition-all duration-700" style={{ width: `${avgScore}%` }} />
              </div>
            </>
          ) : (
            <p className="text-sm text-[#43474f] mt-2">{loadingPapers ? "Loading…" : "No data yet"}</p>
          )}
        </div>
      )}
      <div className="bg-white p-6 rounded-[2rem] shadow-[0_20px_40px_rgba(11,28,48,0.06)]">
        <p className="text-xs font-extrabold text-[#d58d00] mb-1 tracking-wider uppercase">Papers</p>
        <div className="flex items-end gap-1">
          <span className="font-headline text-3xl font-extrabold text-[#001e40]">{completedPapers.length}</span>
          <span className="text-sm font-medium text-[#43474f] mb-1">done</span>
        </div>
        {pendingRelease.length > 0 && (
          <button onClick={() => setShowPendingReview(true)} className="text-[10px] mt-2 font-extrabold text-[#ba1a1a] flex items-center gap-1 hover:underline">
            <span className="material-symbols-outlined text-[12px]" style={{ fontVariationSettings: "'FILL' 1" }}>error</span>
            {pendingRelease.length} PENDING REVIEW
          </button>
        )}
      </div>
    </div>
  );

  const AiInsightCard = () => (
    <div className="relative">
      <button onClick={() => fetchInsight(true)} disabled={recLoading} className="absolute -top-3 -right-2 z-10 bg-white/80 backdrop-blur-sm px-3 py-1 rounded-full shadow flex items-center gap-1.5 hover:bg-white transition-colors disabled:opacity-60">
        <span className="material-symbols-outlined text-[#ffb952] text-base" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
        <span className="text-[10px] font-extrabold text-[#001e40] tracking-widest uppercase">AI Insight</span>
      </button>
      <div className="bg-[#003366] text-white p-7 rounded-[2.5rem] relative overflow-hidden flex flex-col">
        <div className="absolute top-0 right-0 w-40 h-40 bg-[#006c49]/20 rounded-full blur-3xl -mr-16 -mt-16" />
        <h3 className="font-headline font-bold text-xl mb-3 pr-8 leading-tight">
          {recLoading ? "Analysing performance…" : `${selectedStudent?.name ?? "Your child"}'s snapshot`}
        </h3>
        <p className="text-[#799dd6] text-sm leading-relaxed mb-4 flex-1">
          {recLoading ? "" : renderBold(aiInsight || insightForCard)}
        </p>
        {!recLoading && (
          <div className="space-y-2 mb-5">
            {/* Quiz activity */}
            <div className="flex items-center gap-2.5 bg-white/10 rounded-xl px-3 py-2">
              <span className="material-symbols-outlined text-[#4edea3] text-base" style={{ fontVariationSettings: "'FILL' 1" }}>quiz</span>
              <span className="text-sm text-white">
                <span className="font-bold">{recentQuizCount}</span>
                <span className="text-[#799dd6]"> quiz{recentQuizCount !== 1 ? "zes" : ""} completed in last 3 days</span>
              </span>
            </div>
            {/* Strong area */}
            {strongTopics.length > 0 && (
              <div className="flex items-center gap-2.5 bg-white/10 rounded-xl px-3 py-2">
                <span className="material-symbols-outlined text-[#4edea3] text-base" style={{ fontVariationSettings: "'FILL' 1" }}>trending_up</span>
                <span className="text-sm text-white">
                  <span className="text-[#799dd6]">Strong: </span>
                  <span className="font-bold">{strongTopics.map(t => t.topic).join(", ")}</span>
                </span>
              </div>
            )}
            {/* Weak area */}
            {weakTopics.length > 0 && (
              <div className="flex items-center gap-2.5 bg-white/10 rounded-xl px-3 py-2">
                <span className="material-symbols-outlined text-[#ffb952] text-base" style={{ fontVariationSettings: "'FILL' 1" }}>trending_down</span>
                <span className="text-sm text-white">
                  <span className="text-[#799dd6]">Needs work: </span>
                  <span className="font-bold">{weakTopics.map(t => t.topic).join(", ")}</span>
                </span>
              </div>
            )}
          </div>
        )}
        <button
          onClick={() => { setAssignMode("focused"); setQuizStudentId(selectedStudentId); setQuizTargetDay(null); setShowQuiz(true); }}
          className="w-full bg-white text-[#001e40] font-bold py-3.5 rounded-xl active:scale-95 transition-transform shadow-lg"
        >
          Assign Focused Practice
        </button>
        <button
          onClick={() => { setAssignMode("quiz"); setQuizStudentId(selectedStudentId); setQuizTargetDay(null); setShowQuiz(true); }}
          className="w-full bg-white/10 text-white font-bold py-3.5 rounded-xl active:scale-95 transition-transform mt-2 border border-white/20"
        >
          Assign Daily Quiz
        </button>
      </div>
    </div>
  );

  const PerformanceCards = () => (
    <div className="space-y-3">
      <div className="bg-[#eff4ff] p-5 rounded-[2rem] flex items-start gap-4">
        <div className="bg-[#006c49]/10 p-3 rounded-2xl shrink-0">
          <span className="material-symbols-outlined text-[#006c49]" style={{ fontVariationSettings: "'FILL' 1" }}>verified</span>
        </div>
        <div className="flex-1">
          <h4 className="font-extrabold text-[#001e40] mb-1">Strong Areas</h4>
          {loadingProgress ? <p className="text-sm text-[#43474f]">Loading…</p>
            : strongTopics.length > 0 ? (
              <>
                <p className="text-sm text-[#43474f] leading-snug">{strongTopics.map(t => `${t.topic} — ${t.pct}%`).join(" · ")}</p>
                <div className="mt-2 flex gap-2 flex-wrap">
                  {strongTopics.map(t => (
                    <span key={t.topic} className="bg-white px-2.5 py-0.5 rounded-full text-[10px] font-extrabold text-[#006c49] border border-[#006c49]/20">{t.pct}%</span>
                  ))}
                </div>
              </>
            ) : <p className="text-sm text-[#43474f]">No data yet — complete more marked papers.</p>}
        </div>
      </div>
      <div className="bg-[#eff4ff] p-5 rounded-[2rem] flex items-start gap-4">
        <div className="bg-[#ffb952]/10 p-3 rounded-2xl shrink-0">
          <span className="material-symbols-outlined text-[#ffb952]" style={{ fontVariationSettings: "'FILL' 1" }}>error</span>
        </div>
        <div className="flex-1">
          <h4 className="font-extrabold text-[#001e40] mb-1">Gaps to Fill</h4>
          {loadingProgress ? <p className="text-sm text-[#43474f]">Loading…</p>
            : weakTopics.length > 0 ? (
              <>
                <p className="text-sm text-[#43474f] leading-snug">{weakTopics.map(t => `${t.topic} — ${t.pct}%`).join(" · ")}</p>
                <div className="mt-2">
                  <span className="bg-white px-2.5 py-0.5 rounded-full text-[10px] font-extrabold text-[#492e00] border border-[#ffb952]/30">REVISION NEEDED</span>
                </div>
              </>
            ) : <p className="text-sm text-[#43474f]">{allTopics.length > 0 ? "No significant gaps found!" : "No topic data yet."}</p>}
        </div>
      </div>
    </div>
  );

  const ActivitiesList = () => (
    <div className="space-y-3">
      {recentActivities.map(paper => {
        const pct = scorePct(paper);
        const isMarking = paper.markingStatus === "in_progress";
        return (
          <div key={paper.id} onClick={() => {
              const isQuizOrFocused = paper.paperType === "quiz" || paper.paperType === "focused";
              if (isQuizOrFocused || paper.completedAt) {
                router.push(`/exam/${paper.id}/review?userId=${userId}`);
              } else {
                const masterId = paper.sourceExamId ?? paper.id;
                router.push(`/exam/${masterId}/overview?userId=${userId}&openClone=${paper.id}`);
              }
            }}
            className={`bg-white p-4 rounded-2xl shadow-[0_4px_20px_rgba(11,28,48,0.05)] flex items-center gap-3 transition-shadow ${isMarking ? "opacity-60" : "cursor-pointer hover:shadow-md"}`}>
            <div className="w-11 h-11 rounded-2xl bg-[#e5eeff] flex items-center justify-center text-[#001e40] shrink-0">
              <span className="material-symbols-outlined text-lg">{activityIcon(paper)}</span>
            </div>
            <div className="flex-1 min-w-0">
              <h5 className="font-bold text-sm text-[#001e40] truncate">{paper.title}</h5>
              <p className="text-xs text-[#43474f]">{isMarking ? "Marking…" : relativeDate(paper.completedAt!)}</p>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {(paper.paperType === "quiz" || paper.paperType === "focused") && (
                <button onClick={(e) => handleDeletePaper(e, paper.id)}
                  className="w-7 h-7 rounded-full flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors">
                  <span className="material-symbols-outlined text-base">close</span>
                </button>
              )}
              {isMarking ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-extrabold text-blue-500">Marking…</span>
                  <button
                    onClick={(e) => handleRemarkPaper(e, paper.id)}
                    title="Force re-mark"
                    className="text-[10px] font-bold text-[#003366] bg-[#dce9ff] hover:bg-[#a7c8ff] px-2 py-0.5 rounded-full transition-colors"
                  >Re-mark</button>
                </div>
              ) : pct !== null ? (
                <span className={`font-extrabold text-sm ${pct >= 75 ? "text-[#006c49]" : pct >= 50 ? "text-[#d58d00]" : "text-[#ba1a1a]"}`}>{pct}%</span>
              ) : (
                <span className="material-symbols-outlined text-[#ba1a1a]" style={{ fontVariationSettings: "'FILL' 1" }}>pending_actions</span>
            )}
            </div>
          </div>
        );
      })}
      {recentActivities.length === 0 && (
        <p className="text-sm text-[#43474f] text-center py-6">No completed papers yet.</p>
      )}
    </div>
  );

  // ── Desktop nav items ──────────────────────────────────────────────────────

  const sideNavItems = [
    { icon: "edit_note", label: "听写", href: `/spelling?userId=${userId}` },
    { icon: "quiz", label: "Quiz", onClick: () => { setAssignMode("quiz"); setQuizStudentId(selectedStudentId); setQuizTargetDay(null); setShowQuiz(true); } },
    { icon: "psychology", label: "Focus Practice", onClick: () => { setAssignMode("focused"); setQuizStudentId(selectedStudentId); setQuizTargetDay(null); setShowQuiz(true); } },
    { icon: "description", label: "Set Papers", onClick: () => setActiveView(v => v === "papers" ? "progress" : "papers"), active: activeView === "papers" },
    { icon: "auto_fix_high", label: "Solver", href: `/solver?userId=${userId}` },
    { icon: "insights", label: "Progress", onClick: () => setActiveView("progress"), active: activeView === "progress" },
  ];

  // ══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════════

  return (
    <div className="min-h-screen bg-[#f8f9ff]">
      {/* Assign toast */}
      {assignToast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-[100] bg-[#001e40] text-white text-sm font-semibold px-5 py-3 rounded-2xl shadow-xl flex items-center gap-2 animate-fade-in">
          <span className="material-symbols-outlined text-[#6cf8bb] text-base" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
          {assignToast}
        </div>
      )}

      {/* Modals */}
      {/* FocusedModal merged into QuizModal */}
      {QuizModal()}
      {FeedbackModal()}
      {/* Settings are in Student Settings section on the page */}
      <AdminNotifModal />

      {/* Link Student Modal */}
      {showLinkModal && (
        <div className="fixed inset-0 bg-black/40 flex items-end lg:items-center justify-center z-50 p-4 pb-20 lg:pb-4" onClick={() => setShowLinkModal(false)}>
          <div className="bg-white rounded-3xl w-full max-w-lg p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h3 className="font-headline font-extrabold text-lg text-[#001e40]">Link with Student</h3>
              <button onClick={() => setShowLinkModal(false)} className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center">
                <span className="material-symbols-outlined text-slate-500 text-base">close</span>
              </button>
            </div>
            <div className="flex gap-1 bg-slate-100 p-1 rounded-xl mb-5">
              {(["share", "enter"] as const).map(t => (
                <button key={t} onClick={() => { setLinkTab(t); if (t === "share" && !myCode) fetchMyCode(); }}
                  className={`flex-1 py-2 rounded-lg text-sm font-bold transition-all ${linkTab === t ? "bg-white text-[#001e40] shadow-sm" : "text-slate-500"}`}>
                  {t === "share" ? "My Code" : "Enter Code"}
                </button>
              ))}
            </div>
            {linkTab === "share" ? (
              <div className="text-center">
                <p className="text-xs text-slate-400 mb-4">Share this code with your student so they can link with you.</p>
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
                <p className="text-xs text-slate-400 mb-3">Enter the code from your student.</p>
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

      {/* Pending Review modal */}
      {showPendingReview && (
        <div className="fixed inset-0 bg-black/50 flex items-end lg:items-center justify-center z-[60] p-4" onClick={() => setShowPendingReview(false)}>
          <div className="bg-white rounded-t-3xl lg:rounded-3xl w-full max-w-md p-6 shadow-2xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-headline text-lg font-extrabold text-[#001e40]">Pending Review</h3>
              <span className="text-xs font-bold text-[#ba1a1a] bg-[#ffdad6] px-2.5 py-1 rounded-full">{pendingRelease.length} papers</span>
            </div>
            <p className="text-sm text-[#43474f] mb-4">These papers have been marked but not yet released to the student.</p>
            <div className="space-y-3 overflow-y-auto flex-1">
              {pendingRelease.map(paper => {
                const pct = scorePct(paper);
                return (
                  <div key={paper.id}
                    onClick={() => {
                      router.push(`/exam/${paper.id}/review?userId=${userId}`);
                      setShowPendingReview(false);
                    }}
                    className="flex items-center gap-4 p-4 bg-[#fff8f6] border border-[#ffdad6] rounded-2xl cursor-pointer hover:border-[#ba1a1a]/40 transition-colors"
                  >
                    <div className="w-10 h-10 rounded-xl bg-[#ffdad6] flex items-center justify-center shrink-0">
                      <span className="material-symbols-outlined text-[#93000a] text-base">{activityIcon(paper)}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-[#001e40] text-sm truncate">{paper.title}</p>
                      <p className="text-xs text-[#43474f]">{paper.completedAt ? relativeDate(paper.completedAt) : "Completed"}</p>
                    </div>
                    {pct !== null && (
                      <span className={`text-sm font-extrabold shrink-0 ${pct >= 75 ? "text-[#006c49]" : pct >= 50 ? "text-[#d58d00]" : "text-[#ba1a1a]"}`}>
                        {pct}%
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            <button onClick={() => setShowPendingReview(false)} className="w-full mt-4 py-3 rounded-xl border-2 border-[#c3c6d1] text-[#001e40] font-bold text-sm">Close</button>
          </div>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* DESKTOP SIDEBAR                                                     */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      <aside className="hidden lg:flex fixed left-0 top-0 w-72 h-screen bg-slate-50 border-r border-[#c3c6d1]/20 flex-col p-6 z-50">
        {/* Logo */}
        <div className="flex items-center gap-3 mb-8">
          <img src="/logo_t.png" alt="Owl" className="w-9 h-9 object-contain" />
          <img src="/markforyou2_t.png" alt="Markforyou" className="h-7 object-contain" />
        </div>

        {/* Student card */}
        <div className="relative mb-8">
          <div className="flex items-center gap-3 p-4 bg-[#d3e4fe] rounded-xl">
            <div className="w-10 h-10 rounded-full bg-[#003366] flex items-center justify-center text-white font-bold text-sm shrink-0">
              {initials(selectedStudent?.name ?? "?")}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-[#43474f] font-medium">Monitoring Progress</p>
              <p className="font-headline font-extrabold text-[#001e40] text-sm truncate">{selectedStudent?.name ?? "—"}</p>
            </div>
            {user.linkedStudents.length >= 1 && (
              <button onClick={() => setShowStudentMenu(!showStudentMenu)} className="w-7 h-7 rounded-full bg-white/60 flex items-center justify-center hover:bg-white">
                <span className="material-symbols-outlined text-[#001e40] text-sm">expand_more</span>
              </button>
            )}
          </div>
          {showStudentMenu && <StudentDropdown />}
        </div>

        {/* Nav links */}
        <nav className="flex-1 space-y-1">
          {sideNavItems.map(item => (
            item.href ? (
              <Link key={item.label} href={item.href}
                className="flex items-center gap-3 px-4 py-3 text-slate-600 hover:bg-slate-100 rounded-xl font-medium transition-all duration-200 hover:translate-x-1">
                <span className="material-symbols-outlined text-xl">{item.icon}</span>
                <span>{item.label}</span>
              </Link>
            ) : (
              <button key={item.label} onClick={item.onClick}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl font-medium transition-all duration-200 hover:translate-x-1 ${item.active ? "bg-[#d3e4fe] text-[#001e40] font-semibold" : "text-slate-600 hover:bg-slate-100"}`}>
                <span className="material-symbols-outlined text-xl" style={item.active ? { fontVariationSettings: "'FILL' 1" } : {}}>{item.icon}</span>
                <span>{item.label}</span>
              </button>
            )
          ))}
        </nav>

        {/* Bottom links */}
        <div className="pt-6 border-t border-[#c3c6d1]/40 space-y-1">
          <button onClick={() => setShowFeedback(true)} className="w-full flex items-center gap-3 px-4 py-3 text-slate-500 hover:bg-slate-100 rounded-xl font-medium transition-all hover:translate-x-1">
            <span className="material-symbols-outlined text-xl">feedback</span>
            <div className="text-left">
              <span className="block text-sm font-medium leading-tight">Give Feedback</span>
              <span className="block text-[10px] text-slate-400 font-semibold uppercase tracking-wide">Beta</span>
            </div>
          </button>
          <a href="/faq" target="_blank" rel="noopener" className="w-full flex items-center gap-3 px-4 py-3 text-slate-500 hover:bg-slate-100 rounded-xl font-medium transition-all hover:translate-x-1">
            <span className="material-symbols-outlined text-xl">help</span>
            <span>FAQ</span>
          </a>
          {hasAvatar && (
            <div className="pt-4 mt-2 border-t border-[#c3c6d1]/40 space-y-1">
              <p className="px-4 text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-1">Admin</p>
              <button onClick={() => router.push(`/exam/upload?userId=${userId}`)} className="w-full flex items-center gap-3 px-4 py-2.5 text-slate-600 hover:bg-red-50 hover:text-red-700 rounded-xl font-medium transition-all hover:translate-x-1">
                <span className="material-symbols-outlined text-xl">upload_file</span>
                <span>Upload Papers</span>
              </button>
              <button onClick={() => router.push(`/flagged?userId=${userId}`)} className="w-full flex items-center gap-3 px-4 py-2.5 text-slate-600 hover:bg-red-50 hover:text-red-700 rounded-xl font-medium transition-all hover:translate-x-1">
                <span className="material-symbols-outlined text-xl">flag</span>
                <span>Flagged Q&amp;A</span>
              </button>
              <button onClick={() => router.push(`/admin/papers?userId=${userId}`)} className="w-full flex items-center gap-3 px-4 py-2.5 text-slate-600 hover:bg-red-50 hover:text-red-700 rounded-xl font-medium transition-all hover:translate-x-1">
                <span className="material-symbols-outlined text-xl">library_books</span>
                <span>Review Papers</span>
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* DESKTOP TOP BAR                                                     */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      <header className="hidden lg:flex fixed top-0 right-0 w-[calc(100%-18rem)] z-40 bg-white/80 backdrop-blur-xl items-center justify-between px-8 py-4 shadow-sm">
        <div className="flex items-center gap-3">
          {hasAvatar && (
            <button onClick={() => setShowParentAvatarPicker(true)} className="w-[4.5rem] h-[4.5rem] rounded-full border-2 border-[#a7c8ff] overflow-hidden flex items-center justify-center bg-white shrink-0 relative hover:border-[#003366] hover:scale-105 transition-all cursor-pointer">
              <video ref={bunnyRef} src={bunnySrc} autoPlay muted playsInline onEnded={nextBunny}
                className="w-full h-full object-contain pointer-events-none" style={{ mixBlendMode: "multiply" }} />
              {nextSrc && <video ref={preloadRef} src={nextSrc} muted playsInline preload="auto" onCanPlayThrough={onPreloadReady} className="absolute inset-0 invisible" />}
            </button>
          )}
          <h1 className="font-headline text-lg font-extrabold text-[#001e40]">
            {activeView === "papers" ? "Set Papers" : activeView === "activities" ? "All Activities" : `${user.name}'s Dashboard`}
          </h1>
        </div>
        <div className="flex items-center gap-5">
          <button className="relative" onClick={() => { if (adminNotifs.length > 0) setShowAdminNotifs(true); }}>
            <span className="material-symbols-outlined text-[#43474f] cursor-pointer hover:text-[#001e40]">notifications</span>
            {adminNotifs.length > 0 && <span className="absolute -top-1 -right-1 w-2 h-2 bg-[#ba1a1a] rounded-full" />}
          </button>
          <div className="flex items-center gap-3">
            <span className="text-sm font-semibold text-[#001e40]">{user.name}</span>
            <div className="relative">
              <button
                onClick={() => setShowProfileMenu(v => !v)}
                className="w-8 h-8 rounded-full bg-[#003366] flex items-center justify-center text-white text-xs font-bold hover:bg-[#003366]/80 transition-colors"
              >
                {initials(user.name)}
              </button>
              {showProfileMenu && (
                <div className="absolute right-0 top-10 bg-white rounded-xl shadow-lg border border-slate-100 py-1 w-40 z-50">
                  {nameLower === "admin" && (
                    <button
                      onClick={() => { setShowProfileMenu(false); router.push(`/admin?userId=${userId}`); }}
                      className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-[#001e40] hover:bg-slate-50 transition-colors"
                    >
                      <span className="material-symbols-outlined text-base">admin_panel_settings</span>
                      Admin Panel
                    </button>
                  )}
                  <button
                    onClick={async () => { setShowProfileMenu(false); try { await fetch("/api/auth", { method: "DELETE" }); } catch {} router.push("/"); }}
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
      </header>

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* MOBILE TOP BAR                                                      */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      <header className="lg:hidden fixed top-0 w-full z-50 bg-[#f8f9ff] flex justify-between items-center px-5 h-16">
        <div className="flex items-center gap-2.5">
          {hasAvatar ? (
            <div className="w-12 h-12 rounded-full border-2 border-[#a7c8ff] overflow-hidden flex items-center justify-center bg-white shrink-0 relative"
              onClick={(e) => { const v = (e.currentTarget.querySelector("video") as HTMLVideoElement); v?.play().catch(() => {}); }}>
              <video src={avatarVideos[0]} autoPlay loop muted playsInline
                className="w-full h-full object-contain" style={{ mixBlendMode: "multiply" }} />
            </div>
          ) : (
            <img src="/logo_t.png" alt="Owl" className="w-7 h-7 object-contain" />
          )}
          <img src="/markforyou2_t.png" alt="Markforyou" className="h-6 object-contain" />
        </div>
        <div className="flex items-center gap-4">
          <button className="relative" onClick={() => { if (adminNotifs.length > 0) setShowAdminNotifs(true); }}>
            <span className="material-symbols-outlined text-[#001e40]">notifications</span>
            {adminNotifs.length > 0 && <span className="absolute -top-1 -right-1 w-2 h-2 bg-[#ba1a1a] rounded-full" />}
          </button>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-[#001e40]">{user.name}</span>
          <div className="relative">
            <button
              onClick={() => setShowProfileMenu(v => !v)}
              className="w-8 h-8 rounded-full bg-[#003366] flex items-center justify-center text-white text-xs font-bold"
            >
              {initials(user.name)}
            </button>
            {showProfileMenu && (
              <div className="absolute right-0 top-10 bg-white rounded-xl shadow-lg border border-slate-100 py-1 w-40 z-50">
                {hasAvatar && (
                  <button
                    onClick={() => { setShowProfileMenu(false); router.push(`/admin?userId=${userId}`); }}
                    className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-[#001e40] hover:bg-slate-50 transition-colors"
                  >
                    <span className="material-symbols-outlined text-base">admin_panel_settings</span>
                    Admin Panel
                  </button>
                )}
                <button
                  onClick={async () => { setShowProfileMenu(false); try { await fetch("/api/auth", { method: "DELETE" }); } catch {} router.push("/"); }}
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
      </header>

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* MAIN CONTENT                                                        */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      <main className="lg:ml-72 pt-20 lg:pt-24 pb-32 lg:pb-12">

        {/* ── Papers / Set Papers view ─────────────────────────────────────── */}
        {activeView === "papers" && (
          <div className="px-5 lg:px-8 max-w-4xl">
            {/* Header */}
            <div className="flex items-center gap-3 mb-6">
              <button onClick={() => setActiveView("progress")} className="p-2 rounded-xl hover:bg-[#e5eeff] transition-colors">
                <span className="material-symbols-outlined text-[#001e40]">arrow_back</span>
              </button>
              <div>
                <h2 className="font-headline font-extrabold text-xl text-[#001e40]">Set Papers</h2>
                {selectedStudent && (
                  <p className="text-xs text-[#43474f] mt-0.5">{selectedStudent.name}</p>
                )}
              </div>
            </div>

            {loadingPapers ? (
              <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-2 border-[#dce9ff] border-t-[#003366]" /></div>
            ) : masterPapers.length === 0 ? (
              <div className="text-center py-16 bg-white rounded-3xl border-2 border-dashed border-[#c3c6d1]">
                <span className="material-symbols-outlined text-4xl text-[#c3c6d1] mb-3 block">description</span>
                <p className="font-bold text-[#001e40]">No papers yet</p>
                <p className="text-sm text-[#43474f] mt-1">Papers uploaded by admin will appear here.</p>
              </div>
            ) : (
              <>
                {/* ── Subject filter ── */}
                <div className="mb-6">
                  <p className="font-headline font-bold text-base text-[#0b1c30] mb-3">Select Subject</p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={() => setSubjectFilter(null)}
                      className={`px-4 py-2.5 rounded-xl text-sm font-semibold transition-all active:scale-95 ${
                        subjectFilter === null
                          ? "bg-[#001e40] text-white shadow-md"
                          : "bg-[#eff4ff] text-[#001e40] hover:bg-[#dce9ff]"
                      }`}
                    >All</button>
                    {availableSubjects.map(s => (
                      <button
                        key={s}
                        onClick={() => setSubjectFilter(subjectFilter === s ? null : s)}
                        className={`px-4 py-2.5 rounded-xl text-sm font-semibold transition-all active:scale-95 flex items-center gap-1.5 ${
                          subjectFilter === s
                            ? "bg-[#001e40] text-white shadow-md"
                            : "bg-[#eff4ff] text-[#001e40] hover:bg-[#dce9ff]"
                        }`}
                      >
                        <span className="material-symbols-outlined text-sm">
                          {s.toLowerCase().includes("math") ? "calculate" : s.toLowerCase().includes("science") ? "science" : "abc"}
                        </span>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>

                {/* ── Exam type filter ── */}
                {availableExamTypes.length > 0 && (
                  <div className="mb-6">
                    <p className="font-headline font-bold text-base text-[#0b1c30] mb-3">Assessment Type</p>
                    {/* Mobile: 2-col grid; Desktop: flex wrap */}
                    <div className="grid grid-cols-2 lg:flex lg:flex-wrap gap-2 lg:gap-2">
                      <button
                        onClick={() => setExamTypeFilter(null)}
                        className={`px-4 py-3.5 lg:py-2.5 rounded-2xl lg:rounded-xl text-xs font-bold uppercase tracking-widest text-center transition-all active:scale-95 ${
                          examTypeFilter === null
                            ? "bg-[#003366] text-[#799dd6] shadow-lg"
                            : "bg-[#eff4ff] text-[#001e40] hover:bg-[#dce9ff] border-2 border-transparent hover:border-[#d5e3ff]"
                        }`}
                      >All</button>
                      {availableExamTypes.map(t => (
                        <button
                          key={t}
                          onClick={() => setExamTypeFilter(examTypeFilter === t ? null : t)}
                          className={`px-4 py-3.5 lg:py-2.5 rounded-2xl lg:rounded-xl text-xs font-bold uppercase tracking-widest text-center transition-all active:scale-95 ${
                            examTypeFilter === t
                              ? "bg-[#003366] text-[#799dd6] shadow-lg"
                              : "bg-[#eff4ff] text-[#001e40] hover:bg-[#dce9ff] border-2 border-transparent hover:border-[#d5e3ff]"
                          }`}
                        >{t}</button>
                      ))}
                    </div>
                  </div>
                )}

                {/* ── Results ── */}
                <div className="flex items-baseline justify-between mb-4">
                  <div>
                    <p className="font-headline font-bold text-lg text-[#0b1c30]">
                      Papers{" "}
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-[#6cf8bb] text-[#00714d] text-sm font-bold ml-1">
                        {filteredPapers.length}
                      </span>
                    </p>
                  </div>
                  {(subjectFilter || examTypeFilter) && (
                    <button
                      onClick={() => { setSubjectFilter(null); setExamTypeFilter(null); }}
                      className="text-xs text-[#006c49] font-semibold hover:underline"
                    >Clear filters</button>
                  )}
                </div>

                {filteredPapers.length === 0 ? (
                  <div className="text-center py-12 bg-white rounded-3xl border-2 border-dashed border-[#c3c6d1]">
                    <span className="material-symbols-outlined text-3xl text-[#c3c6d1] mb-2 block">search_off</span>
                    <p className="text-sm text-[#43474f]">No papers match your filters</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredPapers.map(p => {
                      const subjectIcon = (p.subject ?? "").toLowerCase().includes("math") ? "calculate"
                        : (p.subject ?? "").toLowerCase().includes("science") ? "science" : "description";
                      const isAssigning = assigningPaperId === p.id;
                      async function handleAssign(e: React.MouseEvent) {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!selectedStudentId || isAssigning) return;
                        setAssigningPaperId(p.id);
                        try {
                          const res = await fetch(`/api/exam/${p.id}`, {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ assignedToId: selectedStudentId, instantFeedback: false }),
                          });
                          if (!res.ok) {
                            alert("Failed to assign paper. Please try again.");
                            return;
                          }
                          await refreshPapers();
                          setAssignToast(`Paper assigned to ${selectedStudent?.name ?? "student"}`);
                          setTimeout(() => setAssignToast(null), 3000);
                        } finally {
                          setAssigningPaperId(null);
                        }
                      }
                      async function handleUnassign(e: React.MouseEvent) {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!selectedStudentId || isAssigning) return;
                        if (!confirm(`Remove "${p.title}" from ${selectedStudent?.name ?? "student"}'s queue?`)) return;
                        setAssigningPaperId(p.id);
                        try {
                          const res = await fetch(`/api/exam/${p.id}/unassign`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ studentId: selectedStudentId }),
                          });
                          if (!res.ok) { alert("Failed to unassign paper."); return; }
                          await refreshPapers();
                          setAssignToast(`Paper removed from ${selectedStudent?.name ?? "student"}`);
                          setTimeout(() => setAssignToast(null), 3000);
                        } finally {
                          setAssigningPaperId(null);
                        }
                      }
                      const isAssigned = p.assignmentCount > 0;
                      return (
                        <div
                          key={p.id}
                          className="w-full bg-white rounded-[1.5rem] p-4 flex items-center gap-4 text-left"
                          style={{ boxShadow: "0 4px 20px rgba(11,28,48,0.04)" }}
                        >
                          <div className="w-12 h-12 rounded-2xl bg-[#dce9ff] flex items-center justify-center text-[#001e40] shrink-0">
                            {isAssigning
                              ? <div className="animate-spin rounded-full h-5 w-5 border-2 border-[#dce9ff] border-t-[#003366]" />
                              : <span className="material-symbols-outlined text-[20px]">{subjectIcon}</span>
                            }
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-headline font-bold text-[#001e40] text-sm leading-tight">{p.title}</p>
                            <p className="text-xs text-[#737780] font-medium mt-0.5">
                              {[p.subject, p.examType, p.level].filter(Boolean).join(" · ")}
                            </p>
                          </div>
                          {isAssigned ? (
                            <div className="flex items-center gap-2 shrink-0">
                              <span className="material-symbols-outlined text-[#006c49] text-xl" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
                              <button
                                onClick={handleUnassign}
                                disabled={isAssigning}
                                className="text-xs font-bold text-[#ba1a1a] bg-[#ffdad6] px-3 py-1.5 rounded-xl hover:bg-[#ffc1bb] transition-colors disabled:opacity-50"
                              >Remove</button>
                            </div>
                          ) : (
                            <button
                              onClick={handleAssign}
                              disabled={isAssigning}
                              className="text-xs font-bold text-[#003366] bg-[#dce9ff] px-3 py-1.5 rounded-xl hover:bg-[#c6dbff] transition-colors disabled:opacity-50 shrink-0"
                            >Assign</button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── All Activities view ───────────────────────────────────────────── */}
        {activeView === "activities" && (
          <div className="px-5 lg:px-8 max-w-4xl">
            <div className="flex items-center gap-3 mb-6">
              <button onClick={() => setActiveView("progress")} className="p-2 rounded-xl hover:bg-[#e5eeff] transition-colors">
                <span className="material-symbols-outlined text-[#001e40]">arrow_back</span>
              </button>
              <div>
                <h2 className="font-headline font-extrabold text-xl text-[#001e40]">All Activities</h2>
                {selectedStudent && (
                  <p className="text-xs text-[#43474f] mt-0.5">{selectedStudent.name} &middot; {completedPapers.length} completed</p>
                )}
              </div>
            </div>

            {(() => {
              const unstartedPapers = studentPapers.filter(p => !p.completedAt && (p.paperType === "quiz" || p.paperType === "focused" || p.sourceExamId));
              const allActivities = [...unstartedPapers, ...completedPapers];
              if (allActivities.length === 0) return (
                <div className="text-center py-16 bg-white rounded-3xl border-2 border-dashed border-[#c3c6d1]">
                  <span className="material-symbols-outlined text-4xl text-[#c3c6d1] mb-3 block">history</span>
                  <p className="font-bold text-[#001e40]">No papers yet</p>
                  <p className="text-sm text-[#43474f] mt-1">Assigned and completed papers will appear here.</p>
                </div>
              );
              return (
                <div className="space-y-3">
                  {/* Unstarted papers first */}
                  {unstartedPapers.length > 0 && (
                    <p className="text-xs font-extrabold uppercase tracking-widest text-[#43474f] mb-1 mt-2">Assigned — Not Started</p>
                  )}
                  {unstartedPapers.map(paper => (
                    <div key={paper.id} className="bg-white p-4 rounded-2xl shadow-[0_4px_20px_rgba(11,28,48,0.05)] flex items-center gap-3">
                      <div className="w-11 h-11 rounded-2xl bg-[#ffddb4]/40 flex items-center justify-center text-[#d58d00] shrink-0">
                        <span className="material-symbols-outlined text-lg">assignment</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <h5 className="font-bold text-sm text-[#001e40] truncate">{paper.title}</h5>
                        <p className="text-xs text-[#43474f]">
                          Assigned {relativeDate(paper.createdAt)}
                          {paper.subject && <> &middot; {paper.subject}</>}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button onClick={(e) => handleDeletePaper(e, paper.id)}
                          className="w-8 h-8 rounded-full flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                          title="Delete quiz"
                        >
                          <span className="material-symbols-outlined text-lg">delete</span>
                        </button>
                        <span className="text-[10px] font-extrabold text-[#d58d00] uppercase">Not started</span>
                      </div>
                    </div>
                  ))}
                  {/* Completed papers */}
                  {completedPapers.length > 0 && unstartedPapers.length > 0 && (
                    <p className="text-xs font-extrabold uppercase tracking-widest text-[#43474f] mb-1 mt-4">Completed</p>
                  )}
                  {[...completedPapers]
                    .sort((a, b) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime())
                    .map(paper => {
                      const pct = scorePct(paper);
                      const isMarking = paper.markingStatus === "in_progress";
                      return (
                        <div key={paper.id} onClick={() => {
                            const isQuizOrFocused = paper.paperType === "quiz" || paper.paperType === "focused";
                            if (isQuizOrFocused || paper.completedAt) {
                              router.push(`/exam/${paper.id}/review?userId=${userId}`);
                            } else {
                              const masterId = paper.sourceExamId ?? paper.id;
                              router.push(`/exam/${masterId}/overview?userId=${userId}&openClone=${paper.id}`);
                            }
                          }}
                          className={`bg-white p-4 rounded-2xl shadow-[0_4px_20px_rgba(11,28,48,0.05)] flex items-center gap-3 transition-shadow ${isMarking ? "opacity-60" : "cursor-pointer hover:shadow-md"}`}>
                          <div className="w-11 h-11 rounded-2xl bg-[#e5eeff] flex items-center justify-center text-[#001e40] shrink-0">
                            <span className="material-symbols-outlined text-lg">{activityIcon(paper)}</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <h5 className="font-bold text-sm text-[#001e40] truncate">{paper.title}</h5>
                            <p className="text-xs text-[#43474f]">
                              {isMarking ? "Marking…" : relativeDate(paper.completedAt!)}
                              {paper.subject && <> &middot; {paper.subject}</>}
                            </p>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {(paper.paperType === "quiz" || paper.paperType === "focused" || paper.sourceExamId) && (
                              <button onClick={(e) => handleDeletePaper(e, paper.id)}
                                className="w-7 h-7 rounded-full flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors">
                                <span className="material-symbols-outlined text-base">close</span>
                              </button>
                            )}
                            {isMarking ? (
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs font-extrabold text-blue-500">Marking…</span>
                                <button
                                  onClick={(e) => handleRemarkPaper(e, paper.id)}
                                  title="Force re-mark"
                                  className="text-[10px] font-bold text-[#003366] bg-[#dce9ff] hover:bg-[#a7c8ff] px-2 py-0.5 rounded-full transition-colors"
                                >Re-mark</button>
                              </div>
                            ) : pct !== null ? (
                              <span className={`font-extrabold text-sm ${pct >= 75 ? "text-[#006c49]" : pct >= 50 ? "text-[#d58d00]" : "text-[#ba1a1a]"}`}>{pct}%</span>
                            ) : (
                              <span className="material-symbols-outlined text-[#ba1a1a]" style={{ fontVariationSettings: "'FILL' 1" }}>pending_actions</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                </div>
              );
            })()}
          </div>
        )}

        {/* ── Progress dashboard view ──────────────────────────────────────── */}
        {activeView === "progress" && (
          <>
            {/* ─── MOBILE LAYOUT ─────────────────────────────────────────── */}
            <div className="lg:hidden px-5 max-w-lg mx-auto space-y-8">
              {/* Student selector */}
              <section className="pt-2 relative">
                <div className="flex items-center gap-4">
                  <div className="w-14 h-14 rounded-2xl bg-[#dce9ff] flex items-center justify-center text-[#001e40] font-extrabold text-xl shrink-0">
                    {initials(selectedStudent?.name ?? "?")}
                  </div>
                  <div>
                    <p className="text-[#43474f] text-sm font-medium">Monitoring Progress</p>
                    <h2 className="font-headline font-extrabold text-2xl text-[#001e40] tracking-tight">{selectedStudent?.name ?? "—"}</h2>
                  </div>
                  {user.linkedStudents.length >= 1 && (
                    <button onClick={() => setShowStudentMenu(!showStudentMenu)}
                      className="ml-auto w-10 h-10 rounded-full bg-[#eff4ff] flex items-center justify-center hover:bg-[#dce9ff] transition-colors">
                      <span className="material-symbols-outlined text-[#001e40]">expand_more</span>
                    </button>
                  )}
                </div>
                {showStudentMenu && <div className="mt-2"><StudentDropdown /></div>}
              </section>

              <MetricsGrid />
              <AiInsightCard />

              <section>
                <div className="flex justify-between items-center mb-5">
                  <h3 className="font-headline font-bold text-lg text-[#001e40]">Performance Analysis</h3>
                  <button
                    onClick={() => router.push(`/progress/${selectedStudentId}?parentId=${userId}`)}
                    className="flex items-center gap-1.5 text-sm font-bold text-[#003366] bg-[#eff4ff] px-4 py-2 rounded-xl hover:bg-[#dce9ff] transition-colors"
                  >
                    <span className="material-symbols-outlined text-base">bar_chart</span>
                    Full Report
                  </button>
                </div>
                <PerformanceCards />
              </section>

              {/* This Week scheduler — mobile */}
              <section>
                <h3 className="font-headline font-bold text-lg text-[#001e40] mb-4">This Week</h3>
                <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1">
                  {weekDays.map((day, di) => {
                    const papers = papersByDay[di];
                    const today = isToday(day);
                    const expanded = expandedWeekDay === di;
                    const MAX_VISIBLE = 3;
                    const visiblePapers = expanded ? papers : papers.slice(0, MAX_VISIBLE);
                    const overflow = papers.length - MAX_VISIBLE;
                    return (
                      <div key={di}
                        onDragOver={e => { e.preventDefault(); }}
                        onDrop={e => {
                          e.preventDefault();
                          const id = e.dataTransfer.getData("text/plain");
                          if (id) reschedulePaper(id, day);
                        }}
                        className={`min-w-[5.5rem] flex-shrink-0 rounded-2xl p-2.5 ${today ? "bg-white border-2 border-[#a7c8ff]" : "bg-white border border-slate-100"}`}>
                        <p className={`text-[10px] font-bold text-center mb-1 ${today ? "text-[#003366]" : "text-[#43474f]"}`}>{DAY_LABELS[di]}</p>
                        <p className={`text-xs font-extrabold text-center mb-2 ${today ? "text-[#003366]" : "text-[#001e40]"}`}>{day.getDate()}</p>
                        <div className="space-y-1.5">
                          {visiblePapers.map(p => (
                            <div key={p.id}
                              draggable={!p.completedAt}
                              onDragStart={e => { if (!p.completedAt) e.dataTransfer.setData("text/plain", p.id); }}
                              onClick={() => {
                                if (p.completedAt) router.push(`/exam/${p.id}/review?userId=${userId}`);
                                else setSchedulerPopup({ id: p.id, title: p.title, completed: !!p.completedAt });
                              }} className={`rounded-lg px-1.5 py-1 text-[9px] font-semibold truncate flex items-center gap-1 ${p.completedAt ? "bg-[#d1fae5] text-[#006c49] cursor-pointer" : "bg-[#eff4ff] text-[#001e40] cursor-grab active:cursor-grabbing"}`}>
                              {p.markingStatus === "released" && (
                                <span className="material-symbols-outlined shrink-0 leading-none" style={{ fontVariationSettings: "'FILL' 1", fontSize: "9px" }}>check_circle</span>
                              )}
                              <span className="truncate">{shortenTitle(p.title)}</span>
                            </div>
                          ))}
                          {overflow > 0 && (
                            <button
                              type="button"
                              onClick={() => setExpandedWeekDay(expanded ? null : di)}
                              className="w-full rounded-lg py-0.5 text-[9px] font-bold text-[#003366] hover:bg-[#dce9ff] transition-colors"
                            >
                              {expanded ? "Less" : `+${overflow}`}
                            </button>
                          )}
                          <button onClick={() => { setQuizStudentId(selectedStudentId); setQuizTargetDay(day); setShowQuiz(true); }} className="w-full rounded-lg py-1.5 text-base font-extrabold text-[#003366] bg-[#dce9ff] hover:bg-[#a7c8ff] transition-colors">
                            +
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="mt-8">
                <div className="flex justify-between items-center mb-5">
                  <h3 className="font-headline font-bold text-lg text-[#001e40]">Recent Activities</h3>
                  <button onClick={() => setActiveView("activities")} className="text-xs font-extrabold text-[#003366]">View All</button>
                </div>
                <ActivitiesList />
              </section>

              {/* Spelling tests moved to /spelling page */}

              {/* Student Settings */}
              {selectedStudent && (
                <section className="mt-8">
                  <h3 className="font-headline font-bold text-lg text-[#001e40] mb-4">Student Settings</h3>
                  <div className="bg-white rounded-xl border border-slate-100 shadow-sm p-4 space-y-4">
                    {[
                      { key: "avatar" as const, label: "Avatar", desc: "Show animated avatar on student homepage" },
                      { key: "pvp" as const, label: "Arena Battle", desc: "Students can let their avatars battle in a weekly arena. More quizzes and more correct answers led to stronger avatars." },
                      { key: "skipReviewPerfect" as const, label: "Skip review for 100% score", desc: "Auto-release papers with perfect score without parent review" },
                    ].map(item => {
                      const isOn = selectedStudent?.settings?.[item.key] === true;
                      return (
                        <div key={item.key} className="flex items-center justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-[#001e40]">{item.label}</p>
                            <p className="text-xs text-[#43474f]">{item.desc}</p>
                          </div>
                          <button
                            onClick={async () => {
                              const newVal = !isOn;
                              await fetch("/api/users", {
                                method: "PATCH",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ userId: selectedStudentId, settings: { [item.key]: newVal } }),
                              });
                              // When enabling skipReviewPerfect, release all existing 100% papers
                              if (item.key === "skipReviewPerfect" && newVal && selectedStudentId) {
                                fetch("/api/exam/release-perfect", {
                                  method: "POST",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ studentId: selectedStudentId }),
                                }).then(r => r.json()).then(d => {
                                  if (d.released > 0) refreshPapers();
                                });
                              }
                              if (selectedStudent) {
                                selectedStudent.settings = { ...(selectedStudent.settings ?? {}), [item.key]: newVal };
                                setSettingsTick(t => t + 1);
                              }
                            }}
                            className={`shrink-0 w-12 h-7 rounded-full transition-colors relative ${isOn ? "bg-[#006c49]" : "bg-slate-200"}`}
                          >
                            <span className={`absolute top-0.5 w-6 h-6 rounded-full bg-white shadow transition-transform ${isOn ? "left-5.5 translate-x-0" : "left-0.5"}`}
                              style={isOn ? { left: "1.375rem" } : { left: "0.125rem" }}
                            />
                          </button>
                        </div>
                      );
                    })}

                    {/* Student self-learning mode */}
                    <div className="pt-2 border-t border-[#e5eeff]">
                      <p className="text-sm font-semibold text-[#001e40]">Student self-learning</p>
                      <p className="text-xs text-[#43474f] mb-2">Control whether the student can create their own quizzes</p>
                      <div className="space-y-1.5">
                        {([
                          { key: "none", label: "Cannot create quizzes" },
                          { key: "oeq-only", label: "MCQ+OEQ quizzes only" },
                          { key: "all", label: "MCQ or MCQ+OEQ quizzes" },
                        ] as const).map(opt => {
                          const current = (selectedStudent?.settings as Record<string, unknown> | null)?.studentQuizMode as string ?? "all";
                          return (
                            <button
                              key={opt.key}
                              onClick={async () => {
                                await fetch("/api/users", {
                                  method: "PATCH",
                                  headers: { "Content-Type": "application/json" },
                                  body: JSON.stringify({ userId: selectedStudentId, settings: { studentQuizMode: opt.key } }),
                                });
                                if (selectedStudent) {
                                  selectedStudent.settings = { ...(selectedStudent.settings ?? {}), studentQuizMode: opt.key } as typeof selectedStudent.settings;
                                  setSettingsTick(t => t + 1);
                                }
                              }}
                              className={`w-full text-left px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                                current === opt.key ? "bg-[#eff4ff] text-[#003366] border border-[#003366]" : "bg-slate-50 text-[#43474f] border border-transparent"
                              }`}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </section>
              )}
            </div>

            {/* ─── DESKTOP LAYOUT ────────────────────────────────────────── */}
            <div className="hidden lg:block px-8 pb-12 max-w-7xl">
              {/* Hero row */}
              <div className="grid grid-cols-12 gap-8 mb-10">
                {/* AI insight — 7 cols */}
                <div className="col-span-7 bg-[#003366] rounded-3xl p-8 text-white relative overflow-hidden flex flex-col justify-between min-h-[300px] shadow-xl">
                  <div className="absolute top-0 right-0 w-64 h-64 bg-[#006c49]/20 rounded-full blur-3xl -mr-20 -mt-20" />
                  <div className="flex flex-col flex-1">
                    <div className="flex items-center gap-2 mb-5">
                      <button onClick={() => fetchInsight(true)} disabled={recLoading} className="px-3 py-1 bg-[#006c49]/20 backdrop-blur-md rounded-full border border-[#006c49]/30 flex items-center gap-2 hover:bg-[#006c49]/30 transition-colors cursor-pointer disabled:opacity-60">
                        <span className="material-symbols-outlined text-[#4edea3] text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
                        <span className="text-xs font-extrabold uppercase tracking-wider text-[#4edea3]">AI Smart Insights</span>
                      </button>
                    </div>
                    <h2 className="font-headline text-3xl font-extrabold mb-4 leading-tight">
                      {recLoading ? "Analysing performance…" : `${selectedStudent?.name ?? "Your child"}'s snapshot`}
                    </h2>
                    <p className="text-[#799dd6] text-base leading-relaxed flex-1">{renderBold(aiInsight || insightForCard)}</p>
                  </div>
                  <div className="mt-8 flex gap-3">
                    <button
                      onClick={() => { setAssignMode("focused"); setQuizStudentId(selectedStudentId); setQuizTargetDay(null); setShowQuiz(true); }}
                      className="bg-gradient-to-r from-[#006c49] to-[#4edea3] text-white px-6 py-3 rounded-xl font-bold flex items-center gap-2 hover:-translate-y-0.5 transition-all shadow-lg"
                    >
                      Focused Practice
                      <span className="material-symbols-outlined text-xl">arrow_forward</span>
                    </button>
                    <button
                      onClick={() => { setAssignMode("quiz"); setQuizStudentId(selectedStudentId); setQuizTargetDay(null); setShowQuiz(true); }}
                      className="bg-white/10 text-white px-6 py-3 rounded-xl font-bold flex items-center gap-2 hover:-translate-y-0.5 transition-all border border-white/20"
                    >
                      Daily Quiz
                    </button>
                  </div>
                </div>

                {/* Stats — 5 cols */}
                <div className="col-span-5 flex flex-col gap-5">
                  {/* Performance chart or avg score */}
                  <div className="bg-white rounded-3xl p-6 flex-1 shadow-sm relative overflow-hidden">
                    {showChart ? (<>
                      {/* Chart header */}
                      <div className="flex justify-between items-center mb-4">
                        <div>
                          <h3 className="font-headline text-lg font-bold text-[#001e40]">Average Performance</h3>
                          <p className="text-[#43474f] text-xs">Last {chartMaxPts} papers per subject</p>
                        </div>
                        <div className="text-right">
                          <p className="font-headline text-3xl font-extrabold text-[#001e40]">
                            {overallChartAvg}<span className="text-sm font-normal text-[#006c49] ml-1">%</span>
                          </p>
                        </div>
                      </div>
                      {/* SVG line chart — each subject right-aligned */}
                      <div className="relative min-h-[120px]">
                        <svg viewBox="0 0 330 120" className="w-full h-full overflow-visible" preserveAspectRatio="none">
                          {/* Y-axis labels */}
                          <text x="22" y="9" textAnchor="end" fontSize="8" fill="#737780" fontFamily="Inter, sans-serif">100</text>
                          <text x="22" y="64" textAnchor="end" fontSize="8" fill="#737780" fontFamily="Inter, sans-serif">50</text>
                          <text x="22" y="118" textAnchor="end" fontSize="8" fill="#737780" fontFamily="Inter, sans-serif">0</text>
                          {/* Light grid lines */}
                          <line x1="30" y1="5" x2="330" y2="5" stroke="#e5eeff" strokeWidth="0.5" />
                          <line x1="30" y1="60" x2="330" y2="60" stroke="#e5eeff" strokeWidth="0.5" />
                          <line x1="30" y1="115" x2="330" y2="115" stroke="#e5eeff" strokeWidth="0.5" />
                          {chartLines.map(line => {
                            const yScale = (pct: number) => 115 - (pct / 100) * 110;
                            const pts = line.points;
                            const n = pts.length;
                            const chartW = 300;
                            const offsetX = 30;
                            const slotW = chartMaxPts > 1 ? chartW / (chartMaxPts - 1) : chartW;
                            const startSlot = chartMaxPts - n;
                            const coords = pts.map((pct, i) => ({ x: offsetX + (startSlot + i) * slotW, y: yScale(pct) }));
                            const d = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x} ${c.y}`).join(" ");
                            return (
                              <g key={line.subject}>
                                <path d={d} fill="none" stroke={line.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                                {coords.map((c, i) => (
                                  <circle key={i} cx={c.x} cy={c.y} r={i === n - 1 ? 3.5 : 3} fill={line.color} />
                                ))}
                              </g>
                            );
                          })}
                        </svg>
                      </div>
                      {/* Legend */}
                      <div className="mt-4 flex gap-4 border-t border-[#e5eeff] pt-3">
                        {chartLines.map(l => (
                          <div key={l.subject} className="flex items-center gap-1.5">
                            <div className="w-2 h-2 rounded-full" style={{ background: l.color }} />
                            <span className="text-[10px] text-[#43474f] font-medium">{l.label} {l.avg}%</span>
                          </div>
                        ))}
                      </div>
                    </>) : (<>
                      {/* Simple average (less than 3 papers per subject) */}
                      <div className="flex justify-between items-start">
                        <div>
                          <p className="text-[#43474f] font-medium mb-1">Average Score</p>
                          <h3 className="font-headline text-5xl font-black text-[#001e40]">
                            {avgScore !== null ? <>{avgScore}<span className="text-2xl font-bold">%</span></> : <span className="text-2xl text-[#c3c6d1]">—</span>}
                          </h3>
                        </div>
                        <button
                          onClick={() => router.push(`/progress/${selectedStudentId}?parentId=${userId}`)}
                          className="w-14 h-14 rounded-2xl bg-[#6cf8bb]/30 flex items-center justify-center text-[#006c49] hover:bg-[#6cf8bb]/50 transition-colors cursor-pointer"
                          title="View Full Report"
                        >
                          <span className="material-symbols-outlined text-3xl">trending_up</span>
                        </button>
                      </div>
                      {avgScore !== null && (
                        <div className="mt-5">
                          <div className="flex justify-between text-xs font-extrabold uppercase tracking-wide text-[#43474f] mb-2">
                            <span>Progress</span><span>{avgScore}%</span>
                          </div>
                          <div className="w-full h-3 bg-[#dce9ff] rounded-full overflow-hidden">
                            <div className="h-full bg-gradient-to-r from-[#006c49] to-[#4edea3] rounded-full transition-all duration-700" style={{ width: `${avgScore}%` }} />
                          </div>
                        </div>
                      )}
                    </>)}
                  </div>
                  {/* Papers */}
                  <div className="bg-[#eff4ff] rounded-3xl p-6 flex items-center gap-5 shadow-sm">
                    <div className="flex-1">
                      <p className="text-[#43474f] font-medium mb-1">Completed Papers</p>
                      <h3 className="font-headline text-3xl font-black text-[#001e40]">{completedPapers.length} <span className="text-sm font-semibold text-[#43474f]">Total</span></h3>
                    </div>
                    <div className="w-px h-12 bg-[#c3c6d1]/40" />
                    <button
                      className={`flex-1 text-left rounded-2xl p-2 -m-2 transition-all ${pendingRelease.length > 0 ? "hover:bg-[#ffdad6] cursor-pointer" : "cursor-default"}`}
                      onClick={() => pendingRelease.length > 0 && setShowPendingReview(true)}
                      disabled={pendingRelease.length === 0}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className={`font-medium mb-1 ${pendingRelease.length === 0 ? "text-[#006c49]" : "text-[#ba1a1a]"}`}>Pending Review</p>
                          <h3 className={`font-headline text-3xl font-black ${pendingRelease.length === 0 ? "text-[#006c49]" : "text-[#ba1a1a]"}`}>{pendingRelease.length}</h3>
                        </div>
                        {pendingRelease.length > 0 && (
                          <span className="material-symbols-outlined text-[#ba1a1a]">chevron_right</span>
                        )}
                      </div>
                      {pendingRelease.length > 0 && (
                        <p className="text-[10px] font-bold text-[#ba1a1a]/70 mt-1 uppercase tracking-wider">Tap to review</p>
                      )}
                    </button>
                  </div>
                </div>
              </div>

              {/* This Week scheduler — desktop */}
              <div className="bg-white rounded-3xl p-6 shadow-sm mb-8">
                <h4 className="font-headline text-xl font-extrabold text-[#001e40] mb-5 flex items-center gap-2">
                  <span className="material-symbols-outlined text-[#003366]">calendar_month</span>
                  This Week
                </h4>
                <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
                  {weekDays.map((day, di) => {
                    const papers = papersByDay[di];
                    const today = isToday(day);
                    const expanded = expandedWeekDay === di;
                    const MAX_VISIBLE = 4;
                    const visiblePapers = expanded ? papers : papers.slice(0, MAX_VISIBLE);
                    const overflow = papers.length - MAX_VISIBLE;
                    return (
                      <div key={di}
                        onDragOver={e => { e.preventDefault(); }}
                        onDrop={e => {
                          e.preventDefault();
                          const id = e.dataTransfer.getData("text/plain");
                          if (id) reschedulePaper(id, day);
                        }}
                        className={`rounded-2xl p-3 min-h-[140px] min-w-[10rem] flex-shrink-0 flex flex-col ${today ? "bg-white border-2 border-[#a7c8ff]" : "bg-[#f8f9ff] border border-slate-100"}`}>
                        <p className={`text-[10px] font-bold text-center ${today ? "text-[#003366]" : "text-[#43474f]"}`}>{DAY_LABELS[di]}</p>
                        <p className={`text-sm font-extrabold text-center mb-3 ${today ? "text-[#003366]" : "text-[#001e40]"}`}>{day.getDate()}</p>
                        <div className="space-y-1.5 flex-1">
                          {visiblePapers.map(p => (
                            <div key={p.id}
                              draggable={!p.completedAt}
                              onDragStart={e => { if (!p.completedAt) e.dataTransfer.setData("text/plain", p.id); }}
                              onClick={() => {
                                if (p.completedAt) router.push(`/exam/${p.id}/review?userId=${userId}`);
                                else setSchedulerPopup({ id: p.id, title: p.title, completed: !!p.completedAt });
                              }} className={`rounded-lg px-2 py-1.5 text-[10px] font-semibold truncate hover:opacity-80 transition-opacity flex items-center gap-1 ${p.completedAt ? "bg-[#d1fae5] text-[#006c49] cursor-pointer" : "bg-[#eff4ff] text-[#001e40] shadow-sm cursor-grab active:cursor-grabbing"}`}>
                              {p.markingStatus === "released" && (
                                <span className="material-symbols-outlined text-[10px] shrink-0 leading-none" style={{ fontVariationSettings: "'FILL' 1", fontSize: "10px" }}>check_circle</span>
                              )}
                              <span className="truncate">{shortenTitle(p.title)}</span>
                            </div>
                          ))}
                          {overflow > 0 && (
                            <button
                              type="button"
                              onClick={() => setExpandedWeekDay(expanded ? null : di)}
                              className="w-full rounded-lg px-2 py-1 text-[10px] font-bold text-[#003366] hover:bg-[#dce9ff] transition-colors"
                            >
                              {expanded ? "Show less" : `+${overflow} more`}
                            </button>
                          )}
                        </div>
                        <button onClick={() => { setQuizStudentId(selectedStudentId); setQuizTargetDay(day); setShowQuiz(true); }} className="mt-2 w-full rounded-lg py-2 text-lg font-extrabold text-[#003366] bg-[#dce9ff] hover:bg-[#a7c8ff] transition-colors">
                          +
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Bento grid */}
              <div className="space-y-8">
                <div>
                  {/* Skill analysis */}
                  <div className="bg-white rounded-3xl p-8 shadow-sm">
                    <div className="flex items-center justify-between mb-7">
                      <h4 className="font-headline text-xl font-extrabold text-[#001e40] flex items-center gap-2">
                        <span className="material-symbols-outlined text-[#ffb952]" style={{ fontVariationSettings: "'FILL' 1" }}>analytics</span>
                        Skill Profile Analysis
                      </h4>
                      <button
                        onClick={() => router.push(`/progress/${selectedStudentId}?parentId=${userId}`)}
                        className="flex items-center gap-1.5 text-sm font-bold text-[#003366] bg-[#eff4ff] px-4 py-2 rounded-xl hover:bg-[#dce9ff] transition-colors"
                      >
                        <span className="material-symbols-outlined text-base">bar_chart</span>
                        Full Report
                      </button>
                    </div>
                    {loadingProgress ? (
                      <div className="flex justify-center py-8"><div className="animate-spin rounded-full h-6 w-6 border-2 border-[#dce9ff] border-t-[#003366]" /></div>
                    ) : (
                      <div className="grid grid-cols-2 gap-10">
                        <div>
                          <span className="text-xs font-extrabold uppercase tracking-widest text-[#006c49] mb-4 block">Strong Areas</span>
                          <div className="space-y-3">
                            {strongTopics.length > 0 ? strongTopics.map(t => (
                              <div key={t.topic} className="flex items-center justify-between p-4 bg-[#006c49]/5 rounded-2xl">
                                <div className="flex items-center gap-3">
                                  <div className="w-9 h-9 rounded-full bg-[#6cf8bb]/40 flex items-center justify-center text-[#006c49]">
                                    <span className="material-symbols-outlined text-sm">category</span>
                                  </div>
                                  <div>
                                    <span className="font-bold text-[#001e40] text-sm">{t.topic}</span>
                                    <p className="text-[10px] text-[#43474f]">{t.subject}</p>
                                  </div>
                                </div>
                                <span className="text-sm font-extrabold text-[#006c49]">{t.pct}%</span>
                              </div>
                            )) : <p className="text-sm text-[#43474f] py-2">No data yet.</p>}
                          </div>
                        </div>
                        <div>
                          <span className="text-xs font-extrabold uppercase tracking-widest text-[#ba1a1a] mb-4 block">Gaps to Fill</span>
                          <div className="space-y-3">
                            {weakTopics.length > 0 ? weakTopics.map(t => (
                              <div key={t.topic} className="flex items-center justify-between p-4 bg-[#ba1a1a]/5 rounded-2xl">
                                <div className="flex items-center gap-3">
                                  <div className="w-9 h-9 rounded-full bg-[#ffdad6] flex items-center justify-center text-[#93000a]">
                                    <span className="material-symbols-outlined text-sm">pie_chart</span>
                                  </div>
                                  <div>
                                    <span className="font-bold text-[#001e40] text-sm">{t.topic}</span>
                                    <p className="text-[10px] text-[#43474f]">{t.subject}</p>
                                  </div>
                                </div>
                                <span className="text-sm font-extrabold text-[#ba1a1a]">{t.pct}%</span>
                              </div>
                            )) : <p className="text-sm text-[#43474f] py-2">{allTopics.length > 0 ? "No significant gaps!" : "No data yet."}</p>}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Recent activities */}
                  <div className="bg-white rounded-3xl p-8 shadow-sm">
                    <div className="flex justify-between items-center mb-7">
                      <h4 className="font-headline text-xl font-extrabold text-[#001e40]">Recent Activities</h4>
                      <button onClick={() => setActiveView("activities")} className="text-sm font-extrabold text-[#003366] hover:underline">View All</button>
                    </div>
                    <div className="space-y-5">
                      {recentActivities.length === 0 ? (
                        <p className="text-sm text-[#43474f] text-center py-4">No completed papers yet.</p>
                      ) : recentActivities.map(paper => {
                        const pct = scorePct(paper);
                        const isMarking = paper.markingStatus === "in_progress";
                        return (
                          <div key={paper.id} onClick={() => {
                              if (isMarking) return;
                              const isQuizOrFocused = paper.paperType === "quiz" || paper.paperType === "focused";
                              if (isQuizOrFocused || paper.completedAt) {
                                router.push(`/exam/${paper.id}/review?userId=${userId}`);
                              } else {
                                const masterId = paper.sourceExamId ?? paper.id;
                                router.push(`/exam/${masterId}/overview?userId=${userId}&openClone=${paper.id}`);
                              }
                            }}
                            className={`flex items-center gap-5 transition-opacity ${isMarking ? "opacity-60" : "cursor-pointer group hover:opacity-80"}`}>
                            <div className="w-12 h-12 rounded-2xl bg-[#e5eeff] flex items-center justify-center text-[#003366] shrink-0">
                              <span className="material-symbols-outlined">{activityIcon(paper)}</span>
                            </div>
                            <div className="flex-1 min-w-0">
                              <h5 className="font-bold text-[#001e40] truncate">{paper.title}</h5>
                              <p className="text-sm text-[#43474f]">{isMarking ? "Marking…" : relativeDate(paper.completedAt!)}</p>
                            </div>
                            <div className="text-right shrink-0">
                              {isMarking ? (
                                <div className="flex items-center gap-2">
                                  <span className="text-xs font-extrabold text-blue-500">Marking…</span>
                                  <button
                                    onClick={(e) => handleRemarkPaper(e, paper.id)}
                                    title="Force re-mark"
                                    className="text-[10px] font-bold text-[#003366] bg-[#dce9ff] hover:bg-[#a7c8ff] px-2 py-0.5 rounded-full transition-colors"
                                  >Re-mark</button>
                                </div>
                              ) : (<>
                                <span className="text-xs text-[#43474f] block">{relativeDate(paper.completedAt!)}</span>
                                {pct !== null ? (
                                  <span className={`text-xs font-extrabold ${pct >= 75 ? "text-[#006c49]" : pct >= 50 ? "text-[#d58d00]" : "text-[#ba1a1a]"}`}>
                                    {pct}%
                                  </span>
                                ) : (
                                  <span className="text-xs font-extrabold text-[#d58d00]">PENDING</span>
                                )}
                              </>)}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Spelling tests moved to /spelling page */}

                  {/* Student Settings — Desktop */}
                  {selectedStudent && (
                    <div className="bg-white rounded-3xl p-8 shadow-sm mt-8">
                      <h4 className="font-headline text-xl font-extrabold text-[#001e40] mb-5">Student Settings</h4>
                      <div className="space-y-5">
                        {[
                          { key: "avatar" as const, label: "Avatar", desc: "Show animated avatar on student homepage" },
                          { key: "pvp" as const, label: "Arena Battle", desc: "Students can let their avatars battle in a weekly arena. More quizzes and more correct answers led to stronger avatars." },
                          { key: "skipReviewPerfect" as const, label: "Skip review for 100% score", desc: "Auto-release papers with perfect score without parent review" },
                        ].map(item => {
                          const isOn = selectedStudent?.settings?.[item.key] === true;
                          return (
                            <div key={item.key} className="flex items-center justify-between">
                              <div>
                                <p className="font-semibold text-[#001e40]">{item.label}</p>
                                <p className="text-sm text-[#43474f]">{item.desc}</p>
                              </div>
                              <button
                                onClick={async () => {
                                  const newVal = !isOn;
                                  await fetch("/api/users", {
                                    method: "PATCH",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({ userId: selectedStudentId, settings: { [item.key]: newVal } }),
                                  });
                                  // When enabling skipReviewPerfect, release all existing 100% papers
                                  if (item.key === "skipReviewPerfect" && newVal && selectedStudentId) {
                                    fetch("/api/exam/release-perfect", {
                                      method: "POST",
                                      headers: { "Content-Type": "application/json" },
                                      body: JSON.stringify({ studentId: selectedStudentId }),
                                    }).then(r => r.json()).then(d => {
                                      if (d.released > 0) refreshPapers();
                                    });
                                  }
                                  if (selectedStudent) {
                                    selectedStudent.settings = { ...(selectedStudent.settings ?? {}), [item.key]: newVal };
                                    setSettingsTick(t => t + 1);
                                  }
                                }}
                                className={`w-12 h-7 rounded-full transition-colors relative ${isOn ? "bg-[#006c49]" : "bg-slate-200"}`}
                              >
                                <span className="absolute top-0.5 w-6 h-6 rounded-full bg-white shadow transition-transform"
                                  style={isOn ? { left: "1.375rem" } : { left: "0.125rem" }}
                                />
                              </button>
                            </div>
                          );
                        })}

                        {/* Student self-learning mode */}
                        <div className="pt-3 border-t border-[#e5eeff]">
                          <p className="font-semibold text-[#001e40]">Student self-learning</p>
                          <p className="text-sm text-[#43474f] mb-3">Control whether the student can create their own quizzes</p>
                          <div className="flex gap-2">
                            {([
                              { key: "none", label: "Cannot create quizzes" },
                              { key: "oeq-only", label: "MCQ+OEQ only" },
                              { key: "all", label: "MCQ or MCQ+OEQ" },
                            ] as const).map(opt => {
                              const current = (selectedStudent?.settings as Record<string, unknown> | null)?.studentQuizMode as string ?? "all";
                              return (
                                <button
                                  key={opt.key}
                                  onClick={async () => {
                                    await fetch("/api/users", {
                                      method: "PATCH",
                                      headers: { "Content-Type": "application/json" },
                                      body: JSON.stringify({ userId: selectedStudentId, settings: { studentQuizMode: opt.key } }),
                                    });
                                    if (selectedStudent) {
                                      selectedStudent.settings = { ...(selectedStudent.settings ?? {}), studentQuizMode: opt.key } as typeof selectedStudent.settings;
                                      setSettingsTick(t => t + 1);
                                    }
                                  }}
                                  className={`flex-1 py-2.5 rounded-xl border-2 text-sm font-medium transition-all ${
                                    current === opt.key ? "border-[#003366] bg-[#eff4ff] text-[#003366]" : "border-[#c3c6d1] text-[#43474f]"
                                  }`}
                                >
                                  {opt.label}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </main>

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* MOBILE BOTTOM NAV                                                   */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      <nav className="lg:hidden fixed bottom-0 left-0 w-full z-50 flex justify-around items-center px-4 pb-6 pt-3 bg-white/80 backdrop-blur-xl shadow-[0_-10px_40px_rgba(11,28,48,0.06)] rounded-t-[2rem] border-t border-[#e5eeff]/20">
        {[
          { icon: "edit_note", label: "听写", action: () => router.push(`/spelling?userId=${userId}`), active: false },
          { icon: "psychology", label: "Focus Quiz", action: () => { setAssignMode("focused"); setQuizStudentId(selectedStudentId); setQuizTargetDay(null); setShowQuiz(true); }, active: false },
          { icon: "description", label: "Set Papers", action: () => setActiveView(v => v === "papers" ? "progress" : "papers"), active: activeView === "papers" },
          { icon: "auto_fix_high", label: "Solver", action: () => router.push(`/solver?userId=${userId}`), active: false },
          { icon: "insights", label: "Progress", action: () => setActiveView("progress"), active: activeView === "progress" },
        ].map(item => (
          <button key={item.label} onClick={item.action}
            className={`flex flex-col items-center justify-center px-3 py-1.5 rounded-2xl transition-transform active:scale-90 duration-200 ${item.active ? "bg-[#d3e4fe] text-[#001e40]" : "text-slate-400 hover:text-[#001e40]"}`}>
            <span className="material-symbols-outlined text-2xl mb-0.5" style={item.active ? { fontVariationSettings: "'FILL' 1" } : {}}>{item.icon}</span>
            <span className="text-[11px] font-medium">{item.label}</span>
          </button>
        ))}
      </nav>

      {/* Diagnostic welcome modal */}
      {/* Scheduler paper popup */}
      {schedulerPopup && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-[100] p-4" onClick={() => setSchedulerPopup(null)}>
          <div className="bg-white rounded-2xl p-5 max-w-xs w-full shadow-xl" onClick={e => e.stopPropagation()}>
            <p className="font-bold text-[#001e40] text-sm mb-4 truncate">{schedulerPopup.title}</p>
            <div className="flex gap-3">
              <button
                onClick={async (e) => {
                  const id = schedulerPopup.id;
                  setSchedulerPopup(null);
                  await handleDeletePaper(e as unknown as React.MouseEvent, id);
                }}
                className="flex-1 py-2.5 rounded-xl border-2 border-[#ba1a1a]/30 text-[#ba1a1a] text-sm font-bold hover:bg-red-50 transition-colors flex items-center justify-center gap-1.5"
              >
                <span className="material-symbols-outlined text-base">delete</span>
                Delete
              </button>
              <button
                onClick={() => setSchedulerPopup(null)}
                className="flex-1 py-2.5 rounded-xl border-2 border-slate-200 text-slate-600 text-sm font-bold hover:bg-slate-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Parent avatar picker */}
      {showParentAvatarPicker && (() => {
        const isAdminUser = user.name?.toLowerCase() === "admin";
        const whitetigerUnlockedParent = (user.settings as Record<string, unknown> | null)?.whitetiger === true;
        const parentAvatars = isAdminUser ? [
          { key: "bunny", label: "Bunny" },
          { key: "bear", label: "Bear" },
          { key: "tiger", label: "Tiger" },
          { key: "fox", label: "Fox" },
          { key: "otter", label: "Otter" },
          { key: "uni", label: "Unicorn" },
          { key: "dragon", label: "Dragon" },
          { key: "merlion", label: "Merlion" },
          { key: "qilin", label: "Qilin" },
          ...(whitetigerUnlockedParent ? [{ key: "whitetiger", label: "White Tiger" }] : []),
        ] : [
          { key: "bunny", label: "Bunny" },
          { key: "bear", label: "Bear" },
        ];
        return (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[200] p-4" onClick={() => setShowParentAvatarPicker(false)}>
          <div className="bg-white rounded-3xl p-6 max-w-sm w-full shadow-2xl" onClick={e => e.stopPropagation()}>
            <h2 className="font-headline text-lg font-extrabold text-[#001e40] text-center mb-1">Choose Your Avatar</h2>
            <p className="text-xs text-[#43474f] text-center mb-5">Tap to select</p>
            <div className={`grid ${isAdminUser ? "grid-cols-3" : "grid-cols-2"} gap-3 mb-5`}>
              {parentAvatars.map(animal => {
                const isSelected = (parentAvatarType ?? "bunny") === animal.key;
                return (
                  <button
                    key={animal.key}
                    onClick={async () => {
                      await fetch("/api/users", {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ userId, settings: { avatarType: animal.key } }),
                      });
                      setShowParentAvatarPicker(false);
                      window.location.reload();
                    }}
                    className={`p-3 rounded-2xl border-2 transition-all ${isSelected ? "border-[#006c49] bg-[#006c49]/5 scale-105" : "border-slate-200 hover:border-[#a7c8ff]"}`}
                  >
                    <video src={`/avatars/${animal.key}1.mp4`} autoPlay loop muted playsInline className="w-20 h-20 mx-auto object-contain" style={{ mixBlendMode: "multiply" }} />
                    <p className="text-xs font-bold text-[#001e40] mt-1">{animal.label}</p>
                  </button>
                );
              })}
            </div>
            <button onClick={() => setShowParentAvatarPicker(false)} className="w-full py-2.5 rounded-xl border-2 border-slate-200 text-slate-600 font-bold text-sm">
              Cancel
            </button>
          </div>
        </div>
        );
      })()}

      {showDiagnosticWelcome && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4"
          style={{ background: "rgba(11,28,48,0.4)", backdropFilter: "blur(4px)" }}
        >
          <div className="w-full max-w-md rounded-lg overflow-hidden flex flex-col"
            style={{ background: "#ffffff", boxShadow: "0 20px 40px rgba(11,28,48,0.06)" }}
          >
            <div className="px-6 pt-8 pb-4 flex flex-col items-center text-center">
              <div className="mb-4 w-12 h-12 rounded-full flex items-center justify-center relative"
                style={{ background: "#d3e4fe" }}
              >
                <span className="material-symbols-outlined text-2xl" style={{ color: "#003366", fontVariationSettings: "'FILL' 1" }}>
                  home
                </span>
                <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full"
                  style={{ background: "#006c49", border: "2px solid #ffffff" }}
                />
              </div>
              <h3 className="text-xl font-extrabold tracking-tight" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif", color: "#0b1c30" }}>
                Welcome to your homepage!
              </h3>
            </div>
            <div className="px-8 pb-8 text-center">
              <p className="leading-relaxed" style={{ color: "#43474f", fontSize: "15px" }}>
                Here you can track your student&apos;s progress, as well as assign him <strong className="font-bold text-[#0b1c30]">daily quizzes</strong>, <strong className="font-bold text-[#0b1c30]">focused practices</strong> or full papers. There&apos;s also a <strong className="font-bold text-[#0b1c30]">weekly panel</strong> for you to set assignments for the week.
              </p>
            </div>
            <div className="px-8 pb-8">
              <button
                onClick={() => setShowDiagnosticWelcome(false)}
                className="w-full py-4 px-6 text-white font-bold rounded-lg transition-all duration-200 active:scale-95 flex items-center justify-center"
                style={{
                  fontFamily: "'Plus Jakarta Sans', sans-serif",
                  background: "linear-gradient(to right, #001e40, #003366)",
                  boxShadow: "0 4px 12px rgba(0,30,64,0.15)",
                }}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
