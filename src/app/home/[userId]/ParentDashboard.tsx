"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExamPaperSummary, SpellingTestSummary, User } from "@/types";
import { isAdmin as adminCheck } from "@/lib/admin";
import ExamPaperCard from "@/components/ExamPaperCard";
import DocumentScanner from "@/components/DocumentScanner";
import ScannerErrorBoundary from "@/components/ScannerErrorBoundary";
import ReviseWorkModal from "@/components/ReviseWorkModal";
import TrialReminder from "@/components/TrialReminder";
import ChangePasswordModal from "@/components/ChangePasswordModal";
import { isNative } from "@/lib/native";
import { printPdf } from "@/lib/print-pdf";

// On native iOS the WebView can't open a new tab, so any
// "switch to child account" flow has to log out the parent and
// redirect to the login screen instead. The parent re-authenticates
// as the child (they set the child's password at signup, so they
// have it). Web keeps the multi-tab flow because it's friendlier.
async function switchToStudentAccount(studentId: string, nextSearch = "") {
  if (!isNative()) {
    window.open(`/home/${studentId}${nextSearch}`, "_blank");
    return;
  }
  try {
    await fetch("/api/auth", { method: "DELETE" });
  } catch {
    /* non-fatal — login page will overwrite cookie anyway */
  }
  const next = encodeURIComponent(`/home/${studentId}${nextSearch}`);
  window.location.href = `/login?next=${next}`;
}

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

export default function ParentDashboard({ userId, user, initialStudentId, initialView, initialOpenQuiz, diagnosticWelcome, diagnosticChoice, firstAssignStudentId }: { userId: string; user: User; initialStudentId?: string; initialView?: string; initialOpenQuiz?: boolean; diagnosticWelcome?: boolean; diagnosticChoice?: string; firstAssignStudentId?: string }) {
  const router = useRouter();
  const avatarTypeMap: Record<string, string[]> = Object.fromEntries(
    ["bunny","bear","tiger","fox","otter","uni","dragon","merlion","qilin","whitetiger"].map(k => [
      k,
      [1,2,3,4].map(n => `/avatars/${k}${n}.mp4`),
    ])
  );
  const defaultAvatarMap: Record<string, string> = { admin: "bunny", papa: "bear" };
  const nameLower = user.name?.toLowerCase() ?? "";
  const isAdminUser = adminCheck(user);
  // `user.name` is the immutable login username; `displayName` is the
  // mutable label shown in greetings/headers. Falls back to the
  // username when no override has been set.
  const displayName = user.displayName ?? user.name;
  const parentAvatarType = (user.settings as Record<string, unknown> | null)?.avatarType as string | undefined ?? defaultAvatarMap[nameLower] ?? null;
  const avatarVideos = parentAvatarType ? (avatarTypeMap[parentAvatarType] ?? null) : null;
  const hasAvatar = !!avatarVideos;
  const [showParentAvatarPicker, setShowParentAvatarPicker] = useState(false);
  const [schedulerPopup, setSchedulerPopup] = useState<{ id: string; title: string; completed: boolean; paperType: string | null; subject: string | null } | null>(null);
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
  // In-app document scanner. Holds the assigned-paper context the
  // parent is scanning a completed paper for; null = scanner closed.
  const [scannerTarget, setScannerTarget] = useState<{
    masterPaperId: string;
    studentId: string;
    studentName: string | null;
    paperTitle: string;
  } | null>(null);

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
  const [quizSubject, setQuizSubject] = useState<"math" | "science" | "english" | "chinese">("math");
  // If the parent switches to a P3 student while English is selected,
  // reset to Math — P3 English isn't supported yet. Chinese is admin-
  // only, so if admin switches between students just keep their pick.
  useEffect(() => {
    const quizStudent = user.linkedStudents.find(s => s.id === quizStudentId);
    if (quizStudent?.level === 3) {
      setQuizSubject(prev => (prev === "english" ? "math" : prev));
    }
  }, [quizStudentId, user.linkedStudents]);
  const [englishSections, setEnglishSections] = useState<Set<string>>(new Set(["grammar-mcq", "vocab-mcq", "vocab-cloze"]));
  // Chinese (admin only) — same shape as englishSections. Section
  // keys are the labels stored on the master's chineseSections
  // metadata so a daily-quiz pool can filter by exact match.
  const [chineseSections, setChineseSections] = useState<Set<string>>(new Set(["语文应用 MCQ", "短文填空", "阅读理解 MCQ", "完成对话", "阅读理解 A", "阅读理解 B OEQ"]));
  const [assignMode, setAssignMode] = useState<"quiz" | "focused">("quiz");
  // Revision mode: when the student's settings.allowRevision is on and
  // they're at P >= 2, the parent can flip to one level below for the
  // upcoming quiz / focused practice. Resets to false whenever the
  // modal opens or the student changes (see effect below).
  const [revisionMode, setRevisionMode] = useState(false);
  useEffect(() => { setRevisionMode(false); }, [showQuiz, quizStudentId]);
  // Revise-Work modal (admin-only). Drives the per-subject mistake
  // summary + compile flow.
  const [showReviseModal, setShowReviseModal] = useState(false);
  const [activityLimit, setActivityLimit] = useState(20);
  const [focusedTopic, setFocusedTopic] = useState("");
  const [customTopic, setCustomTopic] = useState("");
  const [customActing, setCustomActing] = useState(false);
  const [customError, setCustomError] = useState("");
  const [creatingQuiz, setCreatingQuiz] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState("");
  // Onboarding's 'Scan and email' choice routes here with
  // ?diagnostic=scan-email. Show a one-shot popup explaining the email
  // address + offering a fallback to the platform-quiz path.
  const [showScanEmailPopup, setShowScanEmailPopup] = useState(diagnosticChoice === "scan-email");
  // Onboarding's 'platform-quiz' choice routes here when the parent
  // re-enters with an existing studentId — otherwise the new
  // onboarding flow creates the quiz directly and lands here with
  // ?firstAssignStudent=<id>. The picker is preserved as a fallback.
  const [showOnboardingQuizPicker, setShowOnboardingQuizPicker] = useState(
    diagnosticChoice === "platform-quiz" && !!initialStudentId,
  );
  const [onboardingQuizSubject, setOnboardingQuizSubject] = useState<"math" | "science" | "english" | null>(null);
  const [onboardingQuizType, setOnboardingQuizType] = useState<"mcq" | "mcq-oeq">("mcq");
  const [onboardingQuizDifficulty, setOnboardingQuizDifficulty] = useState<"adaptive" | "standard">(() => {
    const s = user.linkedStudents.find(x => x.id === initialStudentId)?.settings as { questionDifficulty?: string } | undefined;
    return s?.questionDifficulty === "adaptive" ? "adaptive" : "standard";
  });
  const [onboardingQuizLoading, setOnboardingQuizLoading] = useState(false);
  // First-time-assign popup. After the parent assigns their first
  // daily quiz / focused practice, ask if they want to open the
  // child's homepage in a new tab to follow along. Tracked on the
  // parent record so the popup never fires twice.
  const [firstAssignPrompt, setFirstAssignPrompt] = useState<{ studentId: string; studentName: string } | null>(null);
  // In-session guard. The server-side firstAssignDone flag protects
  // across page reloads, but within a single session the `user` prop
  // is stale (it's a snapshot from page load). Without this ref the
  // second assignment of the session re-checks the stale prop and
  // re-fires the prompt.
  const firstAssignShownRef = useRef(false);
  function maybeShowFirstAssignPrompt(studentIdHit: string) {
    if (firstAssignShownRef.current) return;
    const settings = (user.settings ?? {}) as { firstAssignDone?: boolean };
    if (settings.firstAssignDone) return;
    const child = user.linkedStudents.find(s => s.id === studentIdHit);
    if (!child) return;
    firstAssignShownRef.current = true;
    setFirstAssignPrompt({ studentId: studentIdHit, studentName: child.name });
    // Mirror the change onto the in-memory user prop so any later
    // re-render in this session also sees firstAssignDone=true.
    user.settings = { ...(user.settings ?? {}), firstAssignDone: true };
    // Persist so we never prompt again, even if this tab refreshes
    // before the parent dismisses.
    fetch("/api/users", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, settings: { firstAssignDone: true } }),
    }).catch(() => { /* non-fatal */ });
  }

  async function startOnboardingQuiz() {
    if (!initialStudentId || !onboardingQuizSubject) return;
    setOnboardingQuizLoading(true);
    try {
      // Persist the difficulty choice on the student so it applies to
      // every quiz/focused practice from here on.
      await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: initialStudentId, settings: { questionDifficulty: onboardingQuizDifficulty } }),
      }).catch(() => { /* non-fatal */ });

      const body: Record<string, unknown> = {
        userId,
        studentId: initialStudentId,
        quizType: onboardingQuizType,
        subject: onboardingQuizSubject,
      };
      if (onboardingQuizSubject === "english") {
        const sections = ["grammar-mcq", "vocab-mcq"];
        if (onboardingQuizType === "mcq-oeq") sections.push("editing", "comprehension-cloze");
        body.englishSections = sections;
      }
      const res = await fetch("/api/daily-quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Failed to create quiz");
        return;
      }
      await res.json();
      // Close the picker and trigger the existing first-time-assign
      // prompt asking whether to open the child's homepage in a new
      // tab. Parent stays on the dashboard.
      setShowOnboardingQuizPicker(false);
      maybeShowFirstAssignPrompt(initialStudentId);
      // Strip the diagnostic params from the URL so a refresh doesn't
      // re-show the picker.
      router.replace(`/home/${userId}`);
    } catch {
      alert("Something went wrong. Please try again.");
    } finally {
      setOnboardingQuizLoading(false);
    }
  }
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

  // Onboarding lands here with ?firstAssignStudent=<id> after the
  // parent creates their first student + diagnostic quiz inline. Fire
  // the existing first-time-assign prompt so the parent can choose to
  // open the child's homepage in a new tab. Strip the param so a
  // refresh doesn't re-fire.
  useEffect(() => {
    if (!firstAssignStudentId) return;
    maybeShowFirstAssignPrompt(firstAssignStudentId);
    router.replace(`/home/${userId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstAssignStudentId]);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [sendingFeedback, setSendingFeedback] = useState(false);
  const [adminNotifs, setAdminNotifs] = useState<AdminNotif[]>([]);
  const [showAdminNotifs, setShowAdminNotifs] = useState(false);
  const [showPendingReview, setShowPendingReview] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showUnlinkPicker, setShowUnlinkPicker] = useState(false);
  // Rename modal — click on user.name in the header opens this. Submitting
  // hits PATCH /api/users with { displayName }. The login username
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
  // Independent filter for the All Activities view — kept separate so a
  // parent narrowing one view doesn't accidentally affect the other.
  const [activitiesSubjectFilter, setActivitiesSubjectFilter] = useState<"math" | "science" | "english" | null>(null);
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

  // Re-pull the papers list when the parent comes back to the tab (focus or
  // visibilitychange). Without this, a paper the student just completed
  // stays as 'Not started' on the parent dashboard until manual refresh —
  // the initial fetch is the only one we'd otherwise do.
  useEffect(() => {
    function onActive() {
      if (document.visibilityState === "visible") refreshPapers();
    }
    window.addEventListener("focus", onActive);
    document.addEventListener("visibilitychange", onActive);
    return () => {
      window.removeEventListener("focus", onActive);
      document.removeEventListener("visibilitychange", onActive);
    };
  }, [refreshPapers]);

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

  // Fingerprint of the student's completed quizzes — when a new quiz is
  // submitted or its markingStatus flips (pending→complete→released), this
  // string changes and busts the insight cache. Without this, a fresh quiz
  // result done after the parent first opens the dashboard would be ignored
  // until the next day, so the AI insight stayed stale.
  const studentQuizFingerprint = useMemo(() => {
    if (!selectedStudentId) return "";
    const parts = examPapers
      .filter(p => p.assignedToId === selectedStudentId && p.completedAt)
      .map(p => `${p.id}:${p.completedAt}:${p.markingStatus ?? ""}`)
      .sort();
    return parts.join("|");
  }, [examPapers, selectedStudentId]);

  const recFetchingRef = useRef<string | null>(null);
  function fetchInsight(forceRefresh = false) {
    if (!selectedStudentId || recFetchingRef.current === selectedStudentId) return;
    // Hash the fingerprint into a short stable suffix for the cache key.
    let fpHash = 0;
    for (let i = 0; i < studentQuizFingerprint.length; i++) {
      fpHash = (fpHash * 31 + studentQuizFingerprint.charCodeAt(i)) | 0;
    }
    const fpKey = (fpHash >>> 0).toString(36);
    const key = `recs-fetched-${selectedStudentId}-${fpKey}`;
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
  useEffect(() => { fetchInsight(); }, [userId, selectedStudentId, studentQuizFingerprint]);

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
      const res = await fetch(`/api/exam/${paperId}?userId=${userId}`, { method: "DELETE" });
      if (!res.ok) {
        // Surface the failure instead of silently dropping the row —
        // the previous catch-all hid 403s on revision papers etc and
        // the parent had no idea why nothing changed.
        const body = await res.text().catch(() => "");
        alert(`Delete failed (HTTP ${res.status}): ${body || "no message"}`);
        return;
      }
      setExamPapers(prev => prev.filter(p => p.id !== paperId));
    } catch (err) {
      alert(`Delete failed: ${err instanceof Error ? err.message : "network error"}`);
    }
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
      // The home page listens for postMessage('student-linked') and
      // re-fetches the user record (which is where linkedStudents lives
      // — router.refresh() alone doesn't help on this fully-client page).
      setTimeout(() => {
        setShowLinkModal(false);
        window.postMessage({ type: "student-linked" }, "*");
      }, 1500);
    } catch { setEnterError("Something went wrong"); }
    finally { setEnterLoading(false); }
  }

  // ── Derived metrics ───────────────────────────────────────────────────────

  const studentPapers = examPapers.filter(p => p.assignedToId === selectedStudentId);
  // Compiled "revise work" papers are a curated set of past mistakes,
  // not a fresh attempt. Exclude them from completedPapers entirely
  // so they don't inflate the count or pull on the average. They
  // still appear elsewhere (recent activities, dedicated section)
  // for the parent to navigate to.
  const completedPapers = studentPapers.filter(p => p.completedAt && !p.isRevision);
  // Pending Review = "AI marked it, you haven't pressed 'Mark as
  // Reviewed' yet". Includes instant-feedback papers (daily quizzes,
  // focused tests, scan-submits) — even though the student already
  // saw results inline, the parent still needs a centralised place
  // to track which auto-graded papers they've personally
  // acknowledged. markingStatus stays "complete" until release.
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
  // Aligned threshold: anything ≤ 75% is weak, > 75% is strong. Sort weak
  // ascending (weakest first) and strong descending (strongest first).
  allTopics.sort((a, b) => b.pct - a.pct);
  const strongTopics = allTopics.filter(t => t.pct > 75).slice(0, 2);
  const weakTopics = [...allTopics].filter(t => t.pct <= 75).sort((a, b) => a.pct - b.pct).slice(0, 2);

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
  // English exam papers are temporarily disabled from the parent Set Papers flow.
  // Defence-in-depth: even though paperType==null already excludes focused/quiz,
  // also exclude by title prefix in case any drifted into paperType=null via
  // an old admin tool or data import.
  const masterPapers = examPapers.filter(p =>
    !p.assignedToId
    && p.paperType === null
    && !(p.subject ?? "").toLowerCase().includes("english")
    && !p.title.startsWith("[Synthetic Bank]")
    // \bFocused\b catches both 'P5 Focused: Fractions' (current format)
    // and legacy 'Focused Test on Fractions' style titles. \bFocus\b
    // catches the human-typed 'Focus on Fractions'. Daily Quiz too.
    && !/\bFocus(ed)?\b/i.test(p.title)
    && !/Daily Quiz/i.test(p.title)
  );

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
                  <p className="text-sm font-semibold text-[#001e40] mb-4">Share this code with your child so they can link their account with yours.</p>
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
      .filter(t => t.subject.toLowerCase().includes(focusedSubject === "math" ? "math" : "science") && t.pct <= 75)
      .sort((a, b) => a.pct - b.pct)
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
        const data = await res.json();
        if (!res.ok) { setCustomError(data.error ?? "No questions found"); return; }
        if (Array.isArray(data.warnings) && data.warnings.length > 0) alert(data.warnings.join("\n"));
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
                          const res = await fetch("/api/focused-test", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ parentId: userId, studentId: targetStudentId, subject: t.subject, topic: t.topic, type: focusedType }),
                          });
                          const data = await res.json().catch(() => ({}));
                          if (Array.isArray(data.warnings) && data.warnings.length > 0) alert(data.warnings.join("\n"));
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
        {/* Revision-from-previous-level toggle. Only renders when the
            parent has opted in via student settings AND the student is
            at P2 or higher (so there is a "below" level to revise
            from). Selecting it flips the API to relax filters and
            prefer EOY/Prelim papers from the lower level. */}
        {(() => {
          const allowRev = ((selectedStudent?.settings as Record<string, unknown> | null | undefined)?.allowRevision === true);
          const lvl = selectedStudent?.level ?? 0;
          if (!allowRev || lvl < 2) return null;
          return (
            <div className="flex gap-2 mb-4">
              <button onClick={() => setRevisionMode(false)}
                className={`flex-1 py-2 rounded-xl text-xs font-bold border-2 ${!revisionMode ? "border-[#003366] bg-[#eff4ff] text-[#003366]" : "border-[#c3c6d1] text-[#43474f]"}`}>
                Current level (P{lvl})
              </button>
              <button onClick={() => setRevisionMode(true)}
                className={`flex-1 py-2 rounded-xl text-xs font-bold border-2 ${revisionMode ? "border-[#003366] bg-[#eff4ff] text-[#003366]" : "border-[#c3c6d1] text-[#43474f]"}`}>
                Revise P{lvl - 1}
              </button>
            </div>
          );
        })()}
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
          {(() => {
            // P3 English isn't supported yet — hide the option for P3
            // students. If quizSubject was already "english" when the
            // parent switched to a P3 student, the auto-correct effect
            // below resets it. Chinese is admin-only.
            const quizStudent = user.linkedStudents.find(s => s.id === quizStudentId);
            const isP3 = quizStudent?.level === 3;
            const base: Array<"math" | "science" | "english"> = isP3 ? ["math", "science"] : ["math", "science", "english"];
            const subjects: Array<"math" | "science" | "english" | "chinese"> = isAdminUser ? [...base, "chinese"] : base;
            return subjects.map(s => (
              <button key={s} onClick={() => setQuizSubject(s)}
                className={`flex-1 py-2.5 rounded-xl border-2 text-sm font-medium ${quizSubject === s ? "border-[#006c49] bg-[#6cf8bb]/20 text-[#006c49]" : "border-[#c3c6d1] text-[#43474f]"}`}>
                {s === "math" ? "Math" : s === "science" ? "Science" : s === "english" ? "English" : "华文"}
              </button>
            ));
          })()}
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
            .filter(t => t.subject.toLowerCase().includes(quizSubject === "math" ? "math" : "science") && t.pct <= 75)
            .sort((a, b) => a.pct - b.pct)
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
        {quizSubject === "chinese" ? (
          // Chinese (admin-only) — mirror the English sections
          // checklist. Section keys are the exact normalised labels
          // the extraction pipeline writes to chineseSections, so the
          // backend can filter the question pool by direct match.
          <div className="mb-5">
            <p className="text-[10px] text-[#43474f] mb-3">Select sections to include:</p>
            <div className="space-y-2">
              {[
                { key: "语文应用 MCQ", label: "一 语文应用 (MCQ)" },
                { key: "短文填空", label: "二 短文填空" },
                { key: "阅读理解 MCQ", label: "三 阅读理解一 MCQ" },
                { key: "完成对话", label: "四 完成对话" },
                { key: "阅读理解 A", label: "五 阅读理解二 A (MCQ + 长 OEQ)" },
                { key: "阅读理解 B OEQ", label: "五 阅读理解二 B (OEQ)" },
              ].map(s => (
                <label key={s.key} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={chineseSections.has(s.key)}
                    onChange={() => {
                      setChineseSections(prev => {
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
        ) : quizSubject !== "english" ? (<>
          <div className="flex gap-2 mb-5">
            <button onClick={() => setQuizType("mcq")}
              className={`flex-1 py-2.5 rounded-xl border-2 text-sm font-medium ${quizType === "mcq" ? "border-[#006c49] bg-[#6cf8bb]/20 text-[#006c49]" : "border-[#c3c6d1] text-[#43474f]"}`}>
              MCQ Only
            </button>
            <button onClick={() => setQuizType("mcq-oeq")}
              className={`flex-1 py-2.5 rounded-xl border-2 text-sm font-medium ${quizType === "mcq-oeq" ? "border-[#006c49] bg-[#6cf8bb]/20 text-[#006c49]" : "border-[#c3c6d1] text-[#43474f]"}`}>
              MCQ + Written
            </button>
          </div>
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
        <div className="flex flex-col gap-3">
        <div className="flex gap-3">
          <button onClick={() => { setShowQuiz(false); setQuizTargetDay(null); }} className="flex-1 py-3 rounded-xl border-2 border-[#c3c6d1] text-[#001e40] font-bold">Cancel</button>
          <button
            disabled={creatingQuiz || !quizStudentId || (assignMode === "focused" && quizSubject !== "english" && !focusedTopic) || (assignMode === "focused" && quizSubject === "english" && englishSections.size !== 1)}
            onClick={async () => {
              setCreatingQuiz(true);
              try {
                const scheduledForIso = quizTargetDay ? (() => { const d = new Date(quizTargetDay); d.setHours(9, 0, 0, 0); return d.toISOString(); })() : undefined;
                // Revision-mode level — one below the student's current
                // level, only when the parent picked the toggle.
                const revisionLevel = revisionMode && selectedStudent?.level && selectedStudent.level >= 2
                  ? selectedStudent.level - 1
                  : null;
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
                        ...(revisionLevel ? { revisionLevel } : {}),
                        ...(scheduledForIso ? { scheduledFor: scheduledForIso } : {}),
                      }),
                    });
                    const data = await res.json();
                    if (!res.ok) { alert(data.error || "Failed"); return; }
                    setShowQuiz(false); setQuizTargetDay(null);
                    maybeShowFirstAssignPrompt(quizStudentId);
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
                      ...(revisionLevel ? { revisionLevel } : {}),
                      ...(scheduledForIso ? { scheduledFor: scheduledForIso } : {}),
                    }),
                  });
                  const data = await res.json();
                  if (!res.ok) { alert(data.error || "Failed"); return; }
                  if (Array.isArray(data.warnings) && data.warnings.length > 0) alert(data.warnings.join("\n"));
                  setShowQuiz(false); setQuizTargetDay(null); setFocusedTopic("");
                  maybeShowFirstAssignPrompt(quizStudentId);
                  await refreshPapers();
                  return;
                }
                const res = await fetch("/api/daily-quiz", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    // Chinese assignments need to identify the admin
                    // ACTOR (not the target student) so the route's
                    // admin gate passes. Send admin id as userId and
                    // the student as studentId. Other subjects keep
                    // the existing student-as-userId pattern.
                    ...(quizSubject === "chinese"
                      ? { userId, studentId: quizStudentId }
                      : { userId: quizStudentId }),
                    quizType: quizSubject === "english" || quizSubject === "chinese" ? "mcq" : quizType,
                    subject: quizSubject,
                    ...(quizSubject === "english" && englishSections.size > 0 ? { englishSections: [...englishSections] } : {}),
                    ...(quizSubject === "chinese" && chineseSections.size > 0 ? { chineseSections: [...chineseSections] } : {}),
                    ...(revisionLevel ? { revisionLevel } : {}),
                    ...(scheduledForIso ? { scheduledFor: scheduledForIso } : {}),
                  }),
                });
                const data = await res.json();
                if (!res.ok) { alert(data.error || "Failed"); return; }
                setShowQuiz(false);
                setQuizTargetDay(null);
                maybeShowFirstAssignPrompt(quizStudentId);
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
        <button
          key={s.id}
          onClick={() => { setSelectedStudentId(s.id); setShowStudentMenu(false); }}
          className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-[#eff4ff] transition-colors ${s.id === selectedStudentId ? "bg-[#eff4ff]" : ""}`}
        >
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
      {user.linkedStudents.length > 0 && (
        <button onClick={() => { setShowStudentMenu(false); setShowUnlinkPicker(true); }}
          className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[#ffdad6]/40 border-t border-[#c3c6d1]/30 text-[#ba1a1a]">
          <div className="w-8 h-8 rounded-full bg-[#ffdad6]/40 flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-[#ba1a1a] text-base">link_off</span>
          </div>
          <span className="text-sm font-medium">Unlink Student</span>
        </button>
      )}
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
              // Don't navigate while the AI marker is still running —
              // the review page would 404 / show partial data and the
              // parent ends up refreshing in confusion. Same guard as
              // the completed-list cards lower down.
              if (isMarking) return;
              const isQuizOrFocused = paper.paperType === "quiz" || paper.paperType === "focused";
              if (isQuizOrFocused || paper.completedAt) {
                router.push(`/exam/${paper.id}/review?userId=${userId}`);
              } else {
                const masterId = paper.sourceExamId ?? paper.id;
                router.push(`/exam/${masterId}/overview?userId=${userId}&openClone=${paper.id}`);
              }
            }}
            className={`bg-white p-4 rounded-2xl shadow-[0_4px_20px_rgba(11,28,48,0.05)] flex items-center gap-3 transition-shadow ${isMarking ? "opacity-60 cursor-not-allowed" : "cursor-pointer hover:shadow-md"}`}>
            <div className="w-11 h-11 rounded-2xl bg-[#e5eeff] flex items-center justify-center text-[#001e40] shrink-0">
              <span className="material-symbols-outlined text-lg">{activityIcon(paper)}</span>
            </div>
            <div className="flex-1 min-w-0">
              <h5 className="font-bold text-sm text-[#001e40] truncate">{paper.title}</h5>
              <p className="text-xs text-[#43474f]">
                {isMarking ? "Marking…" : relativeDate(paper.completedAt!)}
                {paper.questionCount > 0 && <> &middot; {paper.questionCount}q</>}
              </p>
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
              {paper.markingStatus === "released" && (
                <span
                  title="Reviewed and released"
                  className="material-symbols-outlined text-[#006c49] text-base ml-1"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >check_circle</span>
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

  const sideNavItems: { icon: string; label: string; onClick?: () => void; href?: string; active?: boolean }[] = [
    { icon: "insights", label: "Progress", onClick: () => setActiveView("progress"), active: activeView === "progress" },
    { icon: "quiz", label: "Quiz", onClick: () => { setAssignMode("quiz"); setQuizStudentId(selectedStudentId); setQuizTargetDay(null); setShowQuiz(true); } },
    { icon: "psychology", label: "Focus Practice", onClick: () => { setAssignMode("focused"); setQuizStudentId(selectedStudentId); setQuizTargetDay(null); setShowQuiz(true); } },
    { icon: "description", label: "Set Papers", onClick: () => setActiveView(v => v === "papers" ? "progress" : "papers"), active: activeView === "papers" },
    // The "Revise work" modal scans the selected student's last 100
    // papers, surfaces per-subject mistakes, and compiles a review
    // or practice paper out of them. Sits after Set Papers in the
    // side nav. Mobile lives under Performance Analysis instead of
    // the bottom bar (full).
    {
      icon: "history_edu",
      label: "Revise Work",
      onClick: () => setShowReviseModal(true),
    },
    { icon: "edit_note", label: "听写", href: `/spelling?userId=${userId}` },
    { icon: "auto_fix_high", label: "Solver", href: `/solver?userId=${userId}` },
  ];

  // ══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════════

  return (
    <div className="min-h-screen bg-[#f8f9ff]">
      <TrialReminder
        userId={userId}
        subscriptionStatus={user.subscriptionStatus}
        trialEndsAtIso={user.trialEndsAt}
      />
      <ChangePasswordModal
        open={showChangePassword}
        onClose={() => setShowChangePassword(false)}
      />
      {showUnlinkPicker && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center px-4 bg-black/40 backdrop-blur-sm"
          onClick={() => setShowUnlinkPicker(false)}
        >
          <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-extrabold text-[#001e40] mb-1">Unlink a student</h2>
            <p className="text-xs text-[#43474f] mb-4 leading-relaxed">
              Pick which student to remove from your dashboard. Their account and progress are kept — you can re-link any time with an invite code.
            </p>
            <div className="flex flex-col gap-2 mb-4">
              {user.linkedStudents.map((s) => (
                <button
                  key={s.id}
                  onClick={async () => {
                    if (!confirm(`Unlink ${s.name}?`)) return;
                    try {
                      const r = await fetch(`/api/link?parentId=${userId}&studentId=${s.id}`, { method: "DELETE" });
                      if (r.ok) window.location.reload();
                    } catch { /* ignore */ }
                  }}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-xl border border-[#c3c6d1] hover:border-[#ba1a1a] hover:bg-[#ffdad6]/30 transition-colors text-left"
                >
                  <div className="w-8 h-8 rounded-full bg-[#003366] flex items-center justify-center text-white text-xs font-bold shrink-0">{initials(s.name)}</div>
                  <span className="font-medium text-[#001e40] flex-1">{s.name}</span>
                  <span className="material-symbols-outlined text-[#ba1a1a]/70 text-base">link_off</span>
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowUnlinkPicker(false)}
              className="w-full py-3 rounded-xl bg-[#003366] text-white text-sm font-bold hover:bg-[#002145]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
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
            {activeView === "papers" ? "Set Papers" : activeView === "activities" ? "All Activities" : `${displayName}'s Dashboard`}
          </h1>
        </div>
        <div className="flex items-center gap-5">
          <button className="relative" onClick={() => { if (adminNotifs.length > 0) setShowAdminNotifs(true); }}>
            <span className="material-symbols-outlined text-[#43474f] cursor-pointer hover:text-[#001e40]">notifications</span>
            {adminNotifs.length > 0 && <span className="absolute -top-1 -right-1 w-2 h-2 bg-[#ba1a1a] rounded-full" />}
          </button>
          <div className="flex items-center gap-3">
            <button
              onClick={() => { setRenameValue(displayName); setRenameError(null); setShowRename(true); }}
              className="text-sm font-semibold text-[#001e40] hover:underline cursor-pointer"
              title="Click to change your name"
            >{displayName}</button>
            <div className="relative">
              <button
                onClick={() => setShowProfileMenu(v => !v)}
                className="w-8 h-8 rounded-full bg-[#003366] flex items-center justify-center text-white text-xs font-bold hover:bg-[#003366]/80 transition-colors"
              >
                {initials(displayName)}
              </button>
              {showProfileMenu && (
                <div className="absolute right-0 top-10 bg-white rounded-xl shadow-lg border border-slate-100 py-1 w-44 z-50">
                  {isAdminUser && (
                    <button
                      onClick={() => { setShowProfileMenu(false); router.push(`/admin?userId=${userId}`); }}
                      className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-[#001e40] hover:bg-slate-50 transition-colors"
                    >
                      <span className="material-symbols-outlined text-base">admin_panel_settings</span>
                      Admin Panel
                    </button>
                  )}
                  <button
                    onClick={() => { setShowProfileMenu(false); router.push(`/account/${userId}`); }}
                    className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-[#001e40] hover:bg-slate-50 transition-colors"
                  >
                    <span className="material-symbols-outlined text-base">manage_accounts</span>
                    Account
                  </button>
                  <button
                    onClick={() => { setShowProfileMenu(false); setShowChangePassword(true); }}
                    className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-[#001e40] hover:bg-slate-50 transition-colors"
                  >
                    <span className="material-symbols-outlined text-base">lock_reset</span>
                    Change password
                  </button>
                  <button
                    onClick={async () => { setShowProfileMenu(false); try { await fetch("/api/auth", { method: "DELETE" }); } catch {} /* hard reload so the rendered React tree is discarded — router.push leaves stale state mounted */ window.location.href = "/"; }}
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
      {/* Top bar is intentionally NOT sticky/floating on the iOS
          app — only the bottom nav stays fixed. Sticky logo bar
          ate too much vertical space in the WebView; scrolling
          with the content is cleaner. */}
      <header className="lg:hidden w-full bg-[#f8f9ff] flex justify-between items-center px-5 h-16">
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
            <button
              onClick={() => { setRenameValue(displayName); setRenameError(null); setShowRename(true); }}
              className="text-sm font-semibold text-[#001e40] hover:underline cursor-pointer"
              title="Click to change your name"
            >{displayName}</button>
          <div className="relative">
            <button
              onClick={() => setShowProfileMenu(v => !v)}
              className="w-8 h-8 rounded-full bg-[#003366] flex items-center justify-center text-white text-xs font-bold"
            >
              {initials(displayName)}
            </button>
            {showProfileMenu && (
              <div className="absolute right-0 top-10 bg-white rounded-xl shadow-lg border border-slate-100 py-1 w-44 z-50">
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
                  onClick={() => { setShowProfileMenu(false); router.push(`/account/${userId}`); }}
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-[#001e40] hover:bg-slate-50 transition-colors"
                >
                  <span className="material-symbols-outlined text-base">manage_accounts</span>
                  Account
                </button>
                <button
                  onClick={() => { setShowProfileMenu(false); setShowChangePassword(true); }}
                  className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-[#001e40] hover:bg-slate-50 transition-colors"
                >
                  <span className="material-symbols-outlined text-base">lock_reset</span>
                  Change password
                </button>
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
      {/* `pt-20` on mobile used to push content below a sticky
          header, but the header is now in normal flow (see the
          comment above <header>). That 80 px of top padding became
          dead space on the iOS app — a noticeable gap between the
          MarkForYou logo bar and the "Monitoring Progress" card.
          Removed for mobile; desktop pt-24 stays because there's no
          mobile header on that breakpoint and the spacing reads as
          breathing room. */}
      <main className="lg:ml-72 pt-2 lg:pt-24 pb-32 lg:pb-12">

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
                      const lastAssignedIso = selectedStudentId ? p.lastAssignedByStudent?.[selectedStudentId] : null;
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
                            {lastAssignedIso && (
                              <p className="text-[11px] text-[#43474f] mt-1">
                                Last assigned {relativeDate(lastAssignedIso)}
                              </p>
                            )}
                          </div>
                          <button
                            onClick={handleAssign}
                            disabled={isAssigning}
                            className="text-xs font-bold text-[#003366] bg-[#dce9ff] px-3 py-1.5 rounded-xl hover:bg-[#c6dbff] transition-colors disabled:opacity-50 shrink-0"
                          >Assign</button>
                          {p.paperType !== "quiz" && p.paperType !== "focused" && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!selectedStudentId) return;
                                const url = `/api/exam/${p.id}/print?studentId=${selectedStudentId}&userId=${userId}`;
                                printPdf(url);
                              }}
                              disabled={!selectedStudentId}
                              title="Open the print dialog for this student's copy"
                              className="text-xs font-bold text-[#001e40] bg-white border border-[#c3c6d1] px-3 py-1.5 rounded-xl hover:bg-slate-50 transition-colors disabled:opacity-50 shrink-0 inline-flex items-center gap-1"
                            >
                              <span className="material-symbols-outlined text-base">print</span>
                              Print
                            </button>
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
              // Subject filter — applied to both unstarted and completed lists.
              // 'math' / 'science' / 'english' match anywhere in the subject
              // string ('Mathematics', 'Science', 'English' etc.).
              const matchesSubject = (p: ExamPaperSummary) => {
                if (!activitiesSubjectFilter) return true;
                const s = (p.subject ?? "").toLowerCase();
                return s.includes(activitiesSubjectFilter);
              };
              const unstartedPapers = studentPapers
                .filter(p => !p.completedAt && (p.paperType === "quiz" || p.paperType === "focused" || p.sourceExamId))
                .filter(matchesSubject);
              const filteredCompleted = completedPapers.filter(matchesSubject);
              const allActivities = [...unstartedPapers, ...filteredCompleted];
              return (
                <div className="space-y-3">
                  {/* Subject filter pills */}
                  <div className="flex gap-2 mb-2 flex-wrap">
                    {([
                      { key: null, label: "All" },
                      { key: "math", label: "Math" },
                      { key: "science", label: "Science" },
                      { key: "english", label: "English" },
                    ] as { key: "math" | "science" | "english" | null; label: string }[]).map(opt => (
                      <button
                        key={opt.label}
                        onClick={() => setActivitiesSubjectFilter(opt.key)}
                        className={`px-3 py-1.5 rounded-xl text-xs font-bold uppercase tracking-wider transition-all ${
                          activitiesSubjectFilter === opt.key
                            ? "bg-[#003366] text-[#799dd6] shadow-sm"
                            : "bg-[#eff4ff] text-[#001e40] hover:bg-[#dce9ff]"
                        }`}
                      >{opt.label}</button>
                    ))}
                  </div>

                  {allActivities.length === 0 && (
                    <div className="text-center py-16 bg-white rounded-3xl border-2 border-dashed border-[#c3c6d1]">
                      <span className="material-symbols-outlined text-4xl text-[#c3c6d1] mb-3 block">history</span>
                      <p className="font-bold text-[#001e40]">No papers match</p>
                      <p className="text-sm text-[#43474f] mt-1">
                        {activitiesSubjectFilter ? "Try switching to a different subject or clear the filter." : "Assigned and completed papers will appear here."}
                      </p>
                    </div>
                  )}

                  {/* Unstarted papers first */}
                  {unstartedPapers.length > 0 && (
                    <p className="text-xs font-extrabold uppercase tracking-widest text-[#43474f] mb-1 mt-2">Assigned — Not Started</p>
                  )}
                  {unstartedPapers.map(paper => (
                    <div
                      key={paper.id}
                      onClick={() => setSchedulerPopup({ id: paper.id, title: paper.title, completed: false, paperType: paper.paperType, subject: paper.subject ?? null })}
                      className="bg-white p-4 rounded-2xl shadow-[0_4px_20px_rgba(11,28,48,0.05)] flex items-center gap-3 cursor-pointer hover:shadow-md transition-shadow"
                    >
                      <div className="w-11 h-11 rounded-2xl bg-[#ffddb4]/40 flex items-center justify-center text-[#d58d00] shrink-0">
                        <span className="material-symbols-outlined text-lg">assignment</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <h5 className="font-bold text-sm text-[#001e40] truncate">{paper.title}</h5>
                        <p className="text-xs text-[#43474f]">
                          Assigned {relativeDate(paper.createdAt)}
                          {paper.subject && <> &middot; {paper.subject}</>}
                          {paper.questionCount > 0 && <> &middot; {paper.questionCount}q</>}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {/* Scan-only quick action (mobile/tablet)
                            for every assigned paper regardless of
                            type. Now that the printable renders
                            clean-extract content with bounds, the
                            scan-back marking flow works uniformly
                            for regular / quiz / focused. */}
                        {paper.assignedToId && !(paper.subject ?? "").toLowerCase().includes("english") && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setScannerTarget({
                                masterPaperId: paper.id,
                                studentId: paper.assignedToId!,
                                studentName: paper.assignedToName ?? null,
                                paperTitle: paper.title,
                              });
                            }}
                            className="lg:hidden w-8 h-8 rounded-full flex items-center justify-center text-slate-300 hover:text-[#006c49] hover:bg-[#e8fff3] transition-colors"
                            title="Scan completed paper"
                          >
                            <span className="material-symbols-outlined text-lg">photo_camera</span>
                          </button>
                        )}
                        <button onClick={(e) => handleDeletePaper(e, paper.id)}
                          className="w-8 h-8 rounded-full flex items-center justify-center text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                          title="Delete quiz"
                        >
                          <span className="material-symbols-outlined text-lg">delete</span>
                        </button>
                        <span className="text-[10px] font-extrabold text-[#d58d00] uppercase hidden sm:inline">Not started</span>
                      </div>
                    </div>
                  ))}
                  {/* Completed papers */}
                  {filteredCompleted.length > 0 && unstartedPapers.length > 0 && (
                    <p className="text-xs font-extrabold uppercase tracking-widest text-[#43474f] mb-1 mt-4">Completed</p>
                  )}
                  {[...filteredCompleted]
                    .sort((a, b) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime())
                    .slice(0, activityLimit)
                    .map(paper => {
                      const pct = scorePct(paper);
                      const isMarking = paper.markingStatus === "in_progress";
                      // iOS WebView has been unreliable with
                      // <div onClick> as a tap target — parents
                      // reported having to press many times to open a
                      // completed paper. role="button" + a native
                      // active state (tap-highlight + touch-action)
                      // makes the outer card a proper interactive
                      // element so iOS treats it as a primary tap
                      // target instead of a passive container.
                      return (
                        <div key={paper.id}
                          role="button"
                          tabIndex={isMarking ? -1 : 0}
                          onClick={() => {
                            if (isMarking) return;
                            const isQuizOrFocused = paper.paperType === "quiz" || paper.paperType === "focused";
                            if (isQuizOrFocused || paper.completedAt) {
                              router.push(`/exam/${paper.id}/review?userId=${userId}`);
                            } else {
                              const masterId = paper.sourceExamId ?? paper.id;
                              router.push(`/exam/${masterId}/overview?userId=${userId}&openClone=${paper.id}`);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (isMarking) return;
                            if (e.key !== "Enter" && e.key !== " ") return;
                            e.preventDefault();
                            const isQuizOrFocused = paper.paperType === "quiz" || paper.paperType === "focused";
                            if (isQuizOrFocused || paper.completedAt) {
                              router.push(`/exam/${paper.id}/review?userId=${userId}`);
                            } else {
                              const masterId = paper.sourceExamId ?? paper.id;
                              router.push(`/exam/${masterId}/overview?userId=${userId}&openClone=${paper.id}`);
                            }
                          }}
                          style={{ WebkitTapHighlightColor: "rgba(11,28,48,0.08)", touchAction: "manipulation" }}
                          className={`bg-white p-4 rounded-2xl shadow-[0_4px_20px_rgba(11,28,48,0.05)] flex items-center gap-3 transition-shadow select-none ${isMarking ? "opacity-60 cursor-not-allowed" : "cursor-pointer hover:shadow-md active:bg-slate-50 active:scale-[0.99]"}`}>
                          <div className="w-11 h-11 rounded-2xl bg-[#e5eeff] flex items-center justify-center text-[#001e40] shrink-0">
                            <span className="material-symbols-outlined text-lg">{activityIcon(paper)}</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <h5 className="font-bold text-sm text-[#001e40] truncate">{paper.title}</h5>
                            <p className="text-xs text-[#43474f]">
                              {isMarking ? "Marking…" : relativeDate(paper.completedAt!)}
                              {paper.subject && <> &middot; {paper.subject}</>}
                              {paper.questionCount > 0 && <> &middot; {paper.questionCount}q</>}
                            </p>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            {(paper.paperType === "quiz" || paper.paperType === "focused" || paper.paperType === "diagnostic" || paper.sourceExamId) && (
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
                            {paper.markingStatus === "released" && (
                              <span
                                title="Reviewed and released"
                                className="material-symbols-outlined text-[#006c49] text-base ml-1"
                                style={{ fontVariationSettings: "'FILL' 1" }}
                              >check_circle</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  {filteredCompleted.length > activityLimit && (
                    <button onClick={() => setActivityLimit(l => l + 20)} className="w-full py-3 text-sm font-bold text-[#003366] bg-[#eff4ff] rounded-2xl hover:bg-[#dce9ff] transition-colors">
                      See more ({filteredCompleted.length - activityLimit} remaining)
                    </button>
                  )}
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

              {/* Big green "open child's homepage" button — sits
                  directly below the smart-insights card so parents
                  can hand the device over to the child in one tap.
                  Hidden when no student is selected. */}
              {selectedStudent && (
                <button
                  onClick={async () => {
                    if (isNative()) {
                      try { await fetch("/api/auth", { method: "DELETE" }); } catch { /* non-fatal */ }
                      const next = encodeURIComponent(`/home/${selectedStudent.id}`);
                      window.location.href = `/login?next=${next}`;
                      return;
                    }
                    window.open(`/home/${selectedStudent.id}`, "_blank", "noopener");
                  }}
                  className="w-full mt-2 py-4 rounded-2xl bg-gradient-to-r from-[#006c49] to-[#4edea3] text-white font-headline font-bold text-base shadow-lg hover:shadow-xl active:scale-[0.99] transition-all flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined">{isNative() ? "login" : "open_in_new"}</span>
                  {isNative()
                    ? `Log in as ${selectedStudent.name}`
                    : `Open ${selectedStudent.name}'s homepage in new tab`}
                </button>
              )}

              <section>
                <div className="flex flex-wrap justify-between items-center gap-2 mb-5">
                  <h3 className="font-headline font-bold text-lg text-[#001e40] shrink-0">Performance Analysis</h3>
                  <div className="flex items-center gap-2 shrink-0">
                    {/* Mobile: bottom bar is full so the "Revise Work"
                        entry lives here, beside Full Report. Icon-only
                        on the narrowest phones so both chips fit on
                        one row beside the heading. */}
                    <button
                      onClick={() => setShowReviseModal(true)}
                      title="Revise work — compile recent mistakes"
                      className="flex items-center gap-1.5 text-sm font-bold text-[#003366] bg-[#eff4ff] px-3 py-2 rounded-xl hover:bg-[#dce9ff] transition-colors"
                    >
                      <span className="material-symbols-outlined text-base">history_edu</span>
                      <span>Revise</span>
                    </button>
                    <button
                      onClick={() => router.push(`/progress/${selectedStudentId}?parentId=${userId}`)}
                      title="Full performance report"
                      className="flex items-center gap-1.5 text-sm font-bold text-[#003366] bg-[#eff4ff] px-3 py-2 rounded-xl hover:bg-[#dce9ff] transition-colors"
                    >
                      <span className="material-symbols-outlined text-base">bar_chart</span>
                      <span>Report</span>
                    </button>
                  </div>
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
                                else setSchedulerPopup({ id: p.id, title: p.title, completed: !!p.completedAt, paperType: p.paperType, subject: p.subject ?? null });
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
                    <QuestionDifficultySetting
                      student={selectedStudent}
                      studentId={selectedStudentId}
                      onChange={() => setSettingsTick(t => t + 1)}
                    />
                    {([
                      { key: "avatar" as const, label: "Avatar", desc: "Show animated avatar on student homepage" },
                      { key: "habitats" as const, label: "Allow collection of pets and habitats", desc: "Student unlocks habitats and pets as they earn points and crystals. Crystals are only earned when parent reviews their work.", defaultOn: true },
                      { key: "pvp" as const, label: "Arena Battle", desc: "Students can let their avatars battle in a weekly arena. More quizzes and more correct answers led to stronger avatars." },
                      { key: "skipReviewPerfect" as const, label: "Skip review for 100% score", desc: "Auto-release papers with perfect score without parent review" },
                      {
                        key: "includeAiQuestions" as const,
                        label: "Include AI generated questions.",
                        desc: "Our AI studies the top school questions and MOE syllabus to generate simple variants. A human expert vets each question.",
                        labelOff: "Exclude AI generated questions from quizzes.",
                        descOff: "Only questions from top schools.",
                        defaultOn: true,
                      },
                      {
                        key: "allowRevision" as const,
                        label: "Allow revision from previous level",
                        desc: "When on, daily-quiz / focused-practice setup gains a level toggle so you can pull from one level below (e.g. P4 for a P5 student). Revision quizzes use all difficulties and prefer EOY / Prelim papers.",
                      },
                    ] as Array<{ key: string; label: string; desc: string; labelOff?: string; descOff?: string; defaultOn?: boolean }>).map(item => {
                      const stored = (selectedStudent?.settings as Record<string, unknown> | null | undefined)?.[item.key];
                      const isOn = item.defaultOn ? stored !== false : stored === true;
                      const label = !isOn && item.labelOff ? item.labelOff : item.label;
                      const desc = !isOn && item.descOff ? item.descOff : item.desc;
                      return (
                        <div key={item.key} className="flex items-center justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-[#001e40]">{label}</p>
                            <p className="text-xs text-[#43474f]">{desc}</p>
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
                                else setSchedulerPopup({ id: p.id, title: p.title, completed: !!p.completedAt, paperType: p.paperType, subject: p.subject ?? null });
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

              {/* Big green "open child's homepage" CTA — same as
                  the mobile placement, sits below the hero grid
                  so parents can hand the device over in one click. */}
              {selectedStudent && (
                <button
                  onClick={async () => {
                    if (isNative()) {
                      try { await fetch("/api/auth", { method: "DELETE" }); } catch { /* non-fatal */ }
                      const next = encodeURIComponent(`/home/${selectedStudent.id}`);
                      window.location.href = `/login?next=${next}`;
                      return;
                    }
                    window.open(`/home/${selectedStudent.id}`, "_blank", "noopener");
                  }}
                  className="w-full mb-10 py-5 rounded-2xl bg-gradient-to-r from-[#006c49] to-[#4edea3] text-white font-headline font-bold text-lg shadow-lg hover:shadow-xl active:scale-[0.99] transition-all flex items-center justify-center gap-2"
                >
                  <span className="material-symbols-outlined text-2xl">{isNative() ? "login" : "open_in_new"}</span>
                  {isNative()
                    ? `Log in as ${selectedStudent.name}`
                    : `Open ${selectedStudent.name}'s homepage in new tab`}
                </button>
              )}

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
                              <p className="text-sm text-[#43474f]">
                                {isMarking ? "Marking…" : relativeDate(paper.completedAt!)}
                                {paper.questionCount > 0 && <> &middot; {paper.questionCount}q</>}
                              </p>
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
                                {paper.markingStatus === "released" && (
                                  <span
                                    title="Reviewed and released"
                                    className="material-symbols-outlined text-[#006c49] text-base ml-1 align-middle"
                                    style={{ fontVariationSettings: "'FILL' 1" }}
                                  >check_circle</span>
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
                        <QuestionDifficultySetting
                          student={selectedStudent}
                          studentId={selectedStudentId}
                          onChange={() => setSettingsTick(t => t + 1)}
                        />
                        {[
                          { key: "avatar" as const, label: "Avatar", desc: "Show animated avatar on student homepage" },
                          { key: "habitats" as const, label: "Allow collection of pets and habitats", desc: "Student unlocks habitats and pets as they earn points and crystals. Crystals are only earned when parent reviews their work.", defaultOn: true },
                          { key: "pvp" as const, label: "Arena Battle", desc: "Students can let their avatars battle in a weekly arena. More quizzes and more correct answers led to stronger avatars." },
                          { key: "skipReviewPerfect" as const, label: "Skip review for 100% score", desc: "Auto-release papers with perfect score without parent review" },
                          { key: "allowRevision" as const, label: "Allow revision from previous level", desc: "When on, daily-quiz / focused-practice setup gains a level toggle so you can pull from one level below (e.g. P4 for a P5 student). Revision quizzes use all difficulties and prefer EOY / Prelim papers." },
                        ].map(item => {
                          const stored = selectedStudent?.settings?.[item.key];
                          const isOn = "defaultOn" in item && item.defaultOn ? stored !== false : stored === true;
                          return (
                            <div key={item.key} className="flex items-start justify-between gap-4">
                              <div className="flex-1 min-w-0">
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
                                className={`shrink-0 mt-1 w-12 h-7 rounded-full transition-colors relative ${isOn ? "bg-[#006c49]" : "bg-slate-200"}`}
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
          { icon: "insights", label: "Progress", action: () => setActiveView("progress"), active: activeView === "progress" },
          { icon: "psychology", label: "Focus Quiz", action: () => { setAssignMode("focused"); setQuizStudentId(selectedStudentId); setQuizTargetDay(null); setShowQuiz(true); }, active: false },
          { icon: "description", label: "Set Papers", action: () => setActiveView(v => v === "papers" ? "progress" : "papers"), active: activeView === "papers" },
          { icon: "edit_note", label: "听写", action: () => router.push(`/spelling?userId=${userId}`), active: false },
          { icon: "auto_fix_high", label: "Solver", action: () => router.push(`/solver?userId=${userId}`), active: false },
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
      {schedulerPopup && (() => {
        // The popup only opens for not-yet-completed papers (line ~2483
        // / ~2811), so Print + Scan are always relevant. Print stamps
        // the per-student print code via the existing route. Scan (the
        // in-app camera flow) is mobile/tablet only — desktop hides it
        // with lg:hidden. Both depend on knowing which student the
        // scheduler is currently filtered to (selectedStudentId).
        const popup = schedulerPopup;
        // English printable is disabled for now (the writing-comprehension
        // layout doesn't translate cleanly to lined/boxed A4) — hide
        // both Print and Scan in the popup for English papers.
        const isEnglishPopup = (popup.subject ?? "").toLowerCase().includes("english");
        return (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-[100] p-4" onClick={() => setSchedulerPopup(null)}>
          <div className="bg-white rounded-2xl p-5 max-w-xs w-full shadow-xl" onClick={e => e.stopPropagation()}>
            <p className="font-bold text-[#001e40] text-sm mb-4 truncate">{popup.title}</p>
            {!popup.completed && selectedStudentId && (
              <div className="flex flex-col gap-2 mb-3">
                {!isEnglishPopup && (
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setSchedulerPopup(null);
                      // Quiz / focused use the focused-test printable
                      // route (which works for any paper id with
                      // clean-extracted questions); regular papers use
                      // the original print route that stamps a
                      // student-specific code for the email-scan path.
                      const printUrl = popup.paperType === "quiz" || popup.paperType === "focused"
                        ? `/api/focused-test/${popup.id}/printable?studentId=${selectedStudentId}&userId=${userId}`
                        : `/api/exam/${popup.id}/print?studentId=${selectedStudentId}&userId=${userId}`;
                      printPdf(printUrl);
                    }}
                    className="flex-1 py-2.5 rounded-xl border-2 border-[#001e40]/20 text-[#001e40] text-sm font-bold hover:bg-[#eff4ff] transition-colors flex items-center justify-center gap-1.5"
                  >
                    <span className="material-symbols-outlined text-base">print</span>
                    Print
                  </button>
                  <button
                    onClick={() => {
                      setSchedulerPopup(null);
                      setScannerTarget({
                        masterPaperId: popup.id,
                        studentId: selectedStudentId,
                        studentName: selectedStudent?.name ?? null,
                        paperTitle: popup.title,
                      });
                    }}
                    className="lg:hidden flex-1 py-2.5 rounded-xl border-2 border-[#006c49]/30 text-[#006c49] text-sm font-bold hover:bg-[#e8fff3] transition-colors flex items-center justify-center gap-1.5"
                  >
                    <span className="material-symbols-outlined text-base">photo_camera</span>
                    Scan
                  </button>
                </div>
                )}
                {/* Open in child's tab — quiz/focused take place at
                    /quiz/<id> (canvas workspace), regular papers
                    open the /exam/<id> overview/review. iOS branch
                    logs the parent out and bounces to /login because
                    WebView can't open a new tab. */}
                <button
                  onClick={async () => {
                    setSchedulerPopup(null);
                    const isQuizOrFocused = popup.paperType === "quiz" || popup.paperType === "focused";
                    const childPath = isQuizOrFocused ? `/quiz/${popup.id}` : `/exam/${popup.id}`;
                    if (isNative()) {
                      try { await fetch("/api/auth", { method: "DELETE" }); } catch { /* non-fatal */ }
                      window.location.href = `/login?next=${encodeURIComponent(childPath)}`;
                      return;
                    }
                    window.open(`${childPath}?userId=${selectedStudentId}`, "_blank", "noopener");
                  }}
                  className="py-2.5 rounded-xl bg-[#001e40] text-white text-sm font-bold hover:bg-[#003366] transition-colors flex items-center justify-center gap-1.5"
                >
                  <span className="material-symbols-outlined text-base">{isNative() ? "login" : "open_in_new"}</span>
                  {isNative() ? "Log in as student" : "Open in child's tab"}
                </button>
              </div>
            )}
            <div className="flex gap-3">
              <button
                onClick={async (e) => {
                  const id = popup.id;
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
        );
      })()}

      {/* Parent avatar picker */}
      {showParentAvatarPicker && (() => {
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

      {firstAssignPrompt && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4" style={{ background: "rgba(11,28,48,0.4)", backdropFilter: "blur(4px)" }}>
          <div className="w-full max-w-sm rounded-3xl overflow-hidden flex flex-col bg-white shadow-2xl">
            <div className="px-6 pt-7 pb-3 flex flex-col items-center text-center">
              <div className="mb-4 w-14 h-14 rounded-2xl flex items-center justify-center bg-[#dce9ff]">
                <span className="material-symbols-outlined text-[#003366] text-3xl" style={{ fontVariationSettings: "'FILL' 1" }}>open_in_new</span>
              </div>
              <h3 className="font-headline text-lg font-extrabold text-[#0b1c30] mb-2">First assignment sent! 🎉</h3>
              <p className="text-sm text-[#43474f] leading-relaxed">
                {isNative()
                  ? <>Log in as <strong className="text-[#001e40]">{firstAssignPrompt.studentName}</strong> on this device to start the quiz.</>
                  : <>Open <strong className="text-[#001e40]">{firstAssignPrompt.studentName}</strong>&apos;s homepage in a new tab so they can start the quiz.</>}
              </p>
            </div>
            <div className="px-6 pt-4 pb-6 flex flex-col gap-2">
              <button
                onClick={() => {
                  const sid = firstAssignPrompt.studentId;
                  setFirstAssignPrompt(null);
                  void switchToStudentAccount(sid, "?firstQuiz=1");
                }}
                className="w-full py-3 rounded-2xl bg-[#001e40] text-white font-bold hover:bg-[#003366] transition-colors"
              >
                {isNative() ? "Log in as student" : "Open in new tab"}
              </button>
              <button
                onClick={() => setFirstAssignPrompt(null)}
                className="w-full py-3 rounded-2xl border-2 border-[#c3c6d1] text-[#001e40] font-semibold hover:bg-[#eff4ff] transition-colors text-sm"
              >
                Not now
              </button>
            </div>
          </div>
        </div>
      )}

      {showScanEmailPopup && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4" style={{ background: "rgba(11,28,48,0.4)", backdropFilter: "blur(4px)" }}>
          <div className="w-full max-w-md rounded-3xl overflow-hidden flex flex-col bg-white shadow-2xl">
            <div className="px-6 pt-7 pb-4 flex flex-col items-center text-center">
              <div className="mb-4 w-14 h-14 rounded-2xl flex items-center justify-center bg-[#dce9ff]">
                <span className="material-symbols-outlined text-[#003366] text-3xl" style={{ fontVariationSettings: "'FILL' 1" }}>home</span>
              </div>
              <h3 className="font-headline text-xl font-extrabold text-[#0b1c30]">Welcome to your homepage</h3>
            </div>
            <div className="px-7 pb-2 text-[#43474f] text-sm leading-relaxed space-y-3">
              <p>
                This is the parent homepage — you can assign quizzes and papers from here whenever you&apos;re ready.
              </p>
              <p>
                Or just send your child&apos;s most recent test (graded or ungraded) to:
              </p>
              <p className="text-center font-mono font-bold text-[#003366] bg-[#f0f5ff] rounded-xl py-3 select-all">
                diagnose@inbound.markforyou.com
              </p>
              <p>
                We&apos;ll auto-mark it, find the gaps, and take it from there. Since you have one child linked, the diagnosis tags to them automatically.
              </p>
            </div>
            <div className="px-7 pt-5 pb-7 flex flex-col gap-2">
              <button
                onClick={() => {
                  setShowScanEmailPopup(false);
                  router.replace(`/home/${userId}`);
                }}
                className="w-full py-3.5 rounded-2xl bg-[#001e40] text-white font-bold hover:bg-[#003366] transition-colors"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}

      {showOnboardingQuizPicker && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4" style={{ background: "rgba(11,28,48,0.4)", backdropFilter: "blur(4px)" }}>
          <div className="w-full max-w-md rounded-3xl overflow-hidden flex flex-col bg-white shadow-2xl">
            <div className="px-6 pt-7 pb-3 flex flex-col items-center text-center">
              <div className="mb-4 w-14 h-14 rounded-2xl flex items-center justify-center bg-[#dce9ff]">
                <span className="material-symbols-outlined text-[#003366] text-3xl" style={{ fontVariationSettings: "'FILL' 1" }}>quiz</span>
              </div>
              <h3 className="font-headline text-xl font-extrabold text-[#0b1c30]">Start a diagnostic quiz</h3>
              <p className="text-xs text-[#43474f] mt-2 px-2">
                Pick a subject to set the first quiz for your child.
              </p>
            </div>
            <div className="px-6 pb-2 space-y-4">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-[#43474f] mb-2">1. Subject</p>
                <div className="flex flex-wrap gap-2">
                  {(() => {
                    const onboardingStudent = user.linkedStudents.find(s => s.id === initialStudentId);
                    const isP3 = onboardingStudent?.level === 3;
                    const subjects = isP3 ? (["math", "science"] as const) : (["math", "science", "english"] as const);
                    return subjects;
                  })().map(subj => {
                    const isSelected = onboardingQuizSubject === subj;
                    return (
                      <button
                        key={subj}
                        onClick={() => setOnboardingQuizSubject(subj)}
                        disabled={onboardingQuizLoading}
                        className="px-4 py-2 rounded-full text-sm font-semibold transition-colors flex items-center gap-1.5 disabled:opacity-50"
                        style={{
                          background: isSelected ? "#003366" : "#f0f5ff",
                          color: isSelected ? "#ffffff" : "#003366",
                          border: isSelected ? "1px solid #003366" : "1px solid #dce9ff",
                        }}
                      >
                        {subj === "english" ? (
                          <span className="font-extrabold text-base leading-none">A</span>
                        ) : (
                          <span className="material-symbols-outlined text-sm">
                            {subj === "math" ? "functions" : "science"}
                          </span>
                        )}
                        {subj.charAt(0).toUpperCase() + subj.slice(1)}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-[#43474f] mb-2">2. Difficulty</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setOnboardingQuizDifficulty("adaptive")}
                    className="flex-1 py-2 rounded-lg text-xs font-semibold transition-colors"
                    style={{
                      background: onboardingQuizDifficulty === "adaptive" ? "#003366" : "#f0f5ff",
                      color: onboardingQuizDifficulty === "adaptive" ? "#ffffff" : "#003366",
                      border: onboardingQuizDifficulty === "adaptive" ? "1px solid #003366" : "1px solid #dce9ff",
                    }}
                  >
                    Progressive (start easier)
                  </button>
                  <button
                    onClick={() => setOnboardingQuizDifficulty("standard")}
                    className="flex-1 py-2 rounded-lg text-xs font-semibold transition-colors"
                    style={{
                      background: onboardingQuizDifficulty === "standard" ? "#003366" : "#f0f5ff",
                      color: onboardingQuizDifficulty === "standard" ? "#ffffff" : "#003366",
                      border: onboardingQuizDifficulty === "standard" ? "1px solid #003366" : "1px solid #dce9ff",
                    }}
                  >
                    Top schools difficulty
                  </button>
                </div>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wider text-[#43474f] mb-2">3. Question type</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setOnboardingQuizType("mcq")}
                    className="flex-1 py-2 rounded-lg text-xs font-semibold transition-colors"
                    style={{
                      background: onboardingQuizType === "mcq" ? "#003366" : "#f0f5ff",
                      color: onboardingQuizType === "mcq" ? "#ffffff" : "#003366",
                      border: onboardingQuizType === "mcq" ? "1px solid #003366" : "1px solid #dce9ff",
                    }}
                  >
                    MCQ Only
                  </button>
                  <button
                    onClick={() => setOnboardingQuizType("mcq-oeq")}
                    className="flex-1 py-2 rounded-lg text-xs font-semibold transition-colors"
                    style={{
                      background: onboardingQuizType === "mcq-oeq" ? "#003366" : "#f0f5ff",
                      color: onboardingQuizType === "mcq-oeq" ? "#ffffff" : "#003366",
                      border: onboardingQuizType === "mcq-oeq" ? "1px solid #003366" : "1px solid #dce9ff",
                    }}
                  >
                    {onboardingQuizSubject === "english" ? "MCQ + Cloze" : "MCQ + written"}
                  </button>
                </div>
              </div>
            </div>
            <div className="px-6 pt-5 pb-6 flex flex-col gap-2">
              <button
                onClick={startOnboardingQuiz}
                disabled={!onboardingQuizSubject || onboardingQuizLoading}
                className="w-full py-3.5 rounded-2xl bg-[#001e40] text-white font-bold hover:bg-[#003366] transition-colors disabled:opacity-50"
              >
                {onboardingQuizLoading ? "Creating quiz..." : "Start Quiz"}
              </button>
              <button
                onClick={() => {
                  setShowOnboardingQuizPicker(false);
                  router.replace(`/home/${userId}`);
                }}
                className="w-full py-2.5 rounded-2xl border border-[#dce9ff] text-[#43474f] font-semibold hover:bg-[#f0f5ff] transition-colors text-sm"
              >
                Skip for now
              </button>
            </div>
          </div>
        </div>
      )}

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
              <h3 className="font-headline text-xl font-extrabold tracking-tight" style={{ color: "#0b1c30" }}>
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
                className="font-headline w-full py-4 px-6 text-white font-bold rounded-lg transition-all duration-200 active:scale-95 flex items-center justify-center"
                style={{
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

      {/* In-app document scanner overlay (parent-only, mobile/tablet).
          Wrapped in an error boundary so a single render crash inside
          the scanner doesn't blow up the whole dashboard with the
          generic Next.js "Application error" page. */}
      {scannerTarget && (
        <ScannerErrorBoundary onReset={() => { setScannerTarget(null); refreshPapers(); }}>
          <DocumentScanner
            parentId={userId}
            masterPaperId={scannerTarget.masterPaperId}
            studentId={scannerTarget.studentId}
            studentName={scannerTarget.studentName}
            paperTitle={scannerTarget.paperTitle}
            onClose={() => { setScannerTarget(null); refreshPapers(); }}
          />
        </ScannerErrorBoundary>
      )}

      {/* Revise-Work modal (admin only — gated at the buttons that
          open it). Auto-targets the currently selected student. */}
      {showReviseModal && selectedStudent && (
        <ReviseWorkModal
          studentId={selectedStudent.id}
          studentName={selectedStudent.displayName ?? selectedStudent.name}
          onClose={() => { setShowReviseModal(false); refreshPapers(); }}
        />
      )}
    </div>
  );
}

// ── Questions Difficulty setting — first item in Student Settings ──────────
// Slider of four stops: Easier / Adaptive / Standard / Hard. Default is
// Standard (= "Top schools" — current app behaviour with no difficulty
// filter). Backend reads user.settings.questionDifficulty and applies the
// filter in /api/focused-test and /api/daily-quiz.
type DifficultyMode = "easier" | "adaptive" | "standard" | "hard";
const DIFFICULTY_OPTIONS: { key: DifficultyMode; label: string; desc: string }[] = [
  { key: "easier",   label: "Easier questions", desc: "Prioritises Lv 1–3 questions (Lv 4 if fewer are available)." },
  { key: "adaptive", label: "Start easy, raise with progress", desc: "Easier questions at first. Once the student averages >80% across 3 recent tests in a subject, that subject opens up to the full range." },
  { key: "standard", label: "Top schools standard", desc: "Draws from every difficulty level — matches top-school exam papers." },
  { key: "hard",     label: "Only hard questions", desc: "Prioritises Lv 3–5 (Lv 1–2 if insufficient)." },
];

function QuestionDifficultySetting({ student, studentId, onChange }: { student: { settings?: unknown } | null; studentId: string | null; onChange: () => void }) {
  const current = (((student?.settings as Record<string, unknown> | null) ?? {}).questionDifficulty as DifficultyMode | undefined) ?? "standard";
  const currentIdx = Math.max(0, DIFFICULTY_OPTIONS.findIndex(o => o.key === current));
  const currentOpt = DIFFICULTY_OPTIONS[currentIdx];

  async function select(mode: DifficultyMode) {
    if (!studentId || mode === current) return;
    // Check the response — the previous "fire-and-forget" pattern
    // hid silent 403s, so a difficulty change appeared to save
    // (local state flipped) but reverted after a refresh because
    // the server never wrote anything.
    const res = await fetch("/api/users", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: studentId, settings: { questionDifficulty: mode } }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(`Couldn't save difficulty change: ${data?.error ?? `error ${res.status}`}`);
      return;
    }
    if (student) {
      student.settings = { ...((student.settings as Record<string, unknown> | null) ?? {}), questionDifficulty: mode };
    }
    onChange();
  }

  return (
    <div className="pb-3 border-b border-[#e5eeff]">
      <p className="text-sm font-semibold text-[#001e40]">Questions difficulty</p>
      <p className="text-xs text-[#43474f] mb-3">{currentOpt.desc}</p>
      <div className="grid grid-cols-4 gap-1.5">
        {DIFFICULTY_OPTIONS.map((opt, i) => {
          const active = current === opt.key;
          return (
            <button
              key={opt.key}
              onClick={() => select(opt.key)}
              className={`text-[10px] font-semibold leading-tight py-2 px-1 rounded-lg border-2 transition-all text-center ${active ? "border-[#003366] bg-[#eff4ff] text-[#003366]" : "border-[#c3c6d1] text-[#43474f] hover:border-[#a7c8ff]"}`}
              title={opt.desc}
            >
              {opt.label}
              {i === 0 && <span className="block text-[9px] text-[#006c49] mt-0.5">easiest</span>}
              {i === DIFFICULTY_OPTIONS.length - 1 && <span className="block text-[9px] text-[#ba1a1a] mt-0.5">hardest</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
