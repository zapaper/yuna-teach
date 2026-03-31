"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExamPaperSummary, User } from "@/types";
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
  if (s.includes("english")) return "translate";
  if (s.includes("science")) return "science";
  return "description";
}

function scorePct(paper: ExamPaperSummary) {
  if (paper.score === null || !paper.totalMarks) return null;
  const total = parseFloat(paper.totalMarks);
  return total > 0 ? Math.round((paper.score / total) * 100) : null;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ParentDashboard({ userId, user }: { userId: string; user: User }) {
  const router = useRouter();

  // Data
  const [examPapers, setExamPapers] = useState<ExamPaperSummary[]>([]);
  const [loadingPapers, setLoadingPapers] = useState(true);
  const [progressData, setProgressData] = useState<ProgressData | null>(null);
  const [loadingProgress, setLoadingProgress] = useState(false);
  const [aiInsight, setAiInsight] = useState("");
  const [recActions, setRecActions] = useState<RecAction[]>([]);
  const [recLoading, setRecLoading] = useState(false);

  // UI state
  const [selectedStudentId, setSelectedStudentId] = useState(user.linkedStudents[0]?.id ?? "");
  const [showStudentMenu, setShowStudentMenu] = useState(false);
  const [activeView, setActiveView] = useState<"progress" | "papers">("progress");

  // Modals
  const [showFocused, setShowFocused] = useState(false);
  const [focusedSubject, setFocusedSubject] = useState<"math" | "science">("math");
  const [focusedType, setFocusedType] = useState<"mcq" | "mcq-oeq">("mcq");
  const [recActing, setRecActing] = useState<string | null>(null);
  const [showQuiz, setShowQuiz] = useState(false);
  const [quizStudentId, setQuizStudentId] = useState(user.linkedStudents[0]?.id ?? "");
  const [quizType, setQuizType] = useState<"mcq" | "mcq-oeq">("mcq");
  const [quizSubject, setQuizSubject] = useState<"math" | "science">("math");
  const [creatingQuiz, setCreatingQuiz] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState("");
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [sendingFeedback, setSendingFeedback] = useState(false);
  const [adminNotifs, setAdminNotifs] = useState<AdminNotif[]>([]);
  const [showAdminNotifs, setShowAdminNotifs] = useState(false);
  const [showPendingReview, setShowPendingReview] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);

  // Filters for papers view
  const [subjectFilter, setSubjectFilter] = useState<string | null>(null);
  const [examTypeFilter, setExamTypeFilter] = useState<string | null>(null);
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

  useEffect(() => {
    if (!selectedStudentId) return;
    setLoadingProgress(true);
    setProgressData(null);
    fetch(`/api/student-progress?parentId=${userId}&studentId=${selectedStudentId}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setProgressData(d))
      .catch(() => {})
      .finally(() => setLoadingProgress(false));
  }, [userId, selectedStudentId]);

  const recFetchedRef = useRef(false);
  useEffect(() => {
    if (!hasStudents || recFetchedRef.current) return;
    const key = `recs-fetched-${userId}`;
    if (localStorage.getItem(key) === new Date().toDateString()) return;
    recFetchedRef.current = true;
    setRecLoading(true);
    fetch(`/api/parent-recommendations?parentId=${userId}&hour=${new Date().getHours()}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.greeting) setAiInsight(d.greeting);
        if (d?.actions?.length) setRecActions(d.actions);
        if (d?.greeting || d?.actions?.length) localStorage.setItem(key, new Date().toDateString());
      })
      .catch(() => {})
      .finally(() => { recFetchedRef.current = false; setRecLoading(false); });
  }, [userId, hasStudents]);

  useEffect(() => {
    fetch(`/api/notifications?userId=${userId}`)
      .then(r => r.ok ? r.json() : [])
      .then((data: AdminNotif[]) => { if (data.length > 0) { setAdminNotifs(data); setShowAdminNotifs(true); } })
      .catch(() => {});
  }, [userId]);

  // ── Derived metrics ───────────────────────────────────────────────────────

  const studentPapers = examPapers.filter(p => p.assignedToId === selectedStudentId);
  const completedPapers = studentPapers.filter(p => p.completedAt);
  const pendingRelease = completedPapers.filter(p => p.markingStatus !== "released");
  const scoredPapers = completedPapers.filter(p => p.score !== null && p.totalMarks && parseFloat(p.totalMarks) > 0);
  const avgScore = scoredPapers.length > 0
    ? Math.round(scoredPapers.reduce((s, p) => s + (p.score! / parseFloat(p.totalMarks!) * 100), 0) / scoredPapers.length)
    : null;
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
    || (avgScore !== null
      ? `${selectedStudent?.name ?? "Your child"} has averaged ${avgScore}% across ${completedPapers.length} completed ${completedPapers.length === 1 ? "paper" : "papers"}.`
      : `Welcome! Start by assigning a past-year paper or a focused practice test.`);

  // Weekly schedule helpers
  const todayDate = new Date();
  const dayOfWeek = todayDate.getDay();
  const monday = new Date(todayDate);
  monday.setDate(todayDate.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
  const weekDays = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(monday); d.setDate(monday.getDate() + i); return d;
  });
  const DAY_LABELS = ["MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const isToday = (d: Date) => d.toDateString() === todayDate.toDateString();

  // Master papers (not assigned = available to assign)
  const masterPapers = examPapers.filter(p => !p.assignedToId && p.paperType === null);

  // ── Early: no students ────────────────────────────────────────────────────

  if (!hasStudents) {
    return (
      <div className="min-h-screen bg-[#f8f9ff] flex flex-col items-center justify-center p-8 text-center">
        <div className="w-16 h-16 rounded-3xl bg-[#003366] flex items-center justify-center mb-6">
          <span className="material-symbols-outlined text-white text-3xl" style={{ fontVariationSettings: "'FILL' 1" }}>family_restroom</span>
        </div>
        <h2 className="font-headline text-2xl font-extrabold text-[#001e40] mb-3">No Student Linked Yet</h2>
        <p className="text-[#43474f] mb-6 max-w-xs text-sm leading-relaxed">Create your child&apos;s account to start tracking their progress and assigning practice papers.</p>
        <button
          onClick={() => window.open(`/register/student?parentId=${userId}`, "_blank")}
          className="px-6 py-3 rounded-xl bg-[#003366] text-white font-bold hover:bg-[#001e40] transition-colors shadow-lg"
        >
          Add Student
        </button>
        <Link href="/" className="mt-4 text-sm text-[#43474f] underline">Back to home</Link>
      </div>
    );
  }

  // ── Modals ────────────────────────────────────────────────────────────────

  const FocusedModal = () => {
    if (!showFocused) return null;
    const subjectTopics = allTopics
      .filter(t => t.subject.toLowerCase().includes(focusedSubject === "math" ? "math" : "science") && t.pct < 65)
      .slice(0, 3);
    const targetStudentId = focusedGapRec?.studentId ?? selectedStudentId ?? user.linkedStudents[0]?.id;
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
            <div className="space-y-2">
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
            <p className="text-sm text-[#43474f] py-3 text-center">No weak topics for this subject yet. Complete more papers to get recommendations.</p>
          )}

          <button onClick={() => setShowFocused(false)} className="w-full mt-4 py-3 rounded-xl border-2 border-[#c3c6d1] text-[#001e40] font-bold text-sm">Close</button>
        </div>
      </div>
    );
  };

  const QuizModal = () => !showQuiz ? null : (
    <div className="fixed inset-0 bg-black/50 flex items-end lg:items-center justify-center z-[60] p-4" onClick={() => setShowQuiz(false)}>
      <div className="bg-white rounded-t-3xl lg:rounded-3xl w-full max-w-sm p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
        <h3 className="font-headline text-lg font-extrabold text-[#001e40] mb-4">Assign Daily Quiz</h3>
        {user.linkedStudents.length > 1 && (
          <>
            <p className="text-xs font-extrabold text-[#43474f] uppercase tracking-wider mb-2">Student</p>
            <div className="flex gap-2 mb-4 flex-wrap">
              {user.linkedStudents.map(s => (
                <button key={s.id} onClick={() => setQuizStudentId(s.id)}
                  className={`px-3 py-1.5 rounded-xl border-2 text-sm font-medium transition-all ${quizStudentId === s.id ? "border-[#006c49] bg-[#6cf8bb]/20 text-[#006c49]" : "border-[#c3c6d1] text-[#43474f]"}`}>
                  {s.name}
                </button>
              ))}
            </div>
          </>
        )}
        <p className="text-xs font-extrabold text-[#43474f] uppercase tracking-wider mb-2">Subject</p>
        <div className="flex gap-2 mb-4">
          {(["math", "science"] as const).map(s => (
            <button key={s} onClick={() => setQuizSubject(s)}
              className={`flex-1 py-2.5 rounded-xl border-2 text-sm font-medium ${quizSubject === s ? "border-[#006c49] bg-[#6cf8bb]/20 text-[#006c49]" : "border-[#c3c6d1] text-[#43474f]"}`}>
              {s === "math" ? "Mathematics" : "Science"}
            </button>
          ))}
        </div>
        <p className="text-xs font-extrabold text-[#43474f] uppercase tracking-wider mb-2">Type</p>
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
        <div className="flex gap-3">
          <button onClick={() => setShowQuiz(false)} className="flex-1 py-3 rounded-xl border-2 border-[#c3c6d1] text-[#001e40] font-bold">Cancel</button>
          <button
            disabled={creatingQuiz || !quizStudentId}
            onClick={async () => {
              setCreatingQuiz(true);
              try {
                const res = await fetch("/api/daily-quiz", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ userId: quizStudentId, quizType, subject: quizSubject }),
                });
                const data = await res.json();
                if (!res.ok) { alert(data.error || "Failed"); return; }
                setShowQuiz(false);
                await refreshPapers();
              } catch { alert("Something went wrong"); }
              finally { setCreatingQuiz(false); }
            }}
            className="flex-1 py-3 rounded-xl bg-[#006c49] text-white font-bold disabled:opacity-50">
            {creatingQuiz ? "Creating..." : "Assign"}
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
            <h3 className="font-headline font-extrabold text-[#001e40] mb-4">Feedback / Support</h3>
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
    </div>
  );

  // ── Shared content blocks ─────────────────────────────────────────────────

  const MetricsGrid = () => (
    <div className="grid grid-cols-2 gap-4">
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
      <div className="absolute -top-3 -right-2 z-10 bg-white/80 backdrop-blur-sm px-3 py-1 rounded-full shadow flex items-center gap-1.5">
        <span className="material-symbols-outlined text-[#ffb952] text-base" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
        <span className="text-[10px] font-extrabold text-[#001e40] tracking-widest uppercase">AI Insight</span>
      </div>
      <div className="bg-[#003366] text-white p-7 rounded-[2.5rem] relative overflow-hidden">
        <div className="absolute top-0 right-0 w-40 h-40 bg-[#006c49]/20 rounded-full blur-3xl -mr-16 -mt-16" />
        <h3 className="font-headline font-bold text-xl mb-3 pr-8 leading-tight">
          {recLoading ? "Analysing performance…" : focusedGapRec
            ? `Recommended: ${focusedGapRec.gaps?.[0]?.topics?.[0] ?? "Focused Practice"}`
            : "Your child's progress overview"}
        </h3>
        <p className="text-[#799dd6] text-sm leading-relaxed mb-4">
          {recLoading ? "" : insightForCard}
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
          onClick={() => setShowFocused(true)}
          className="w-full bg-white text-[#001e40] font-bold py-3.5 rounded-xl active:scale-95 transition-transform shadow-lg"
        >
          Assign Focused Practice
        </button>
        <button
          onClick={() => setShowQuiz(true)}
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
        return (
          <div key={paper.id} onClick={() => router.push(`/exam/${paper.id}/overview?userId=${userId}`)}
            className="bg-white p-4 rounded-2xl shadow-[0_4px_20px_rgba(11,28,48,0.05)] flex items-center gap-3 cursor-pointer hover:shadow-md transition-shadow">
            <div className="w-11 h-11 rounded-2xl bg-[#e5eeff] flex items-center justify-center text-[#001e40] shrink-0">
              <span className="material-symbols-outlined text-lg">{activityIcon(paper)}</span>
            </div>
            <div className="flex-1 min-w-0">
              <h5 className="font-bold text-sm text-[#001e40] truncate">{paper.title}</h5>
              <p className="text-xs text-[#43474f]">{relativeDate(paper.completedAt!)}</p>
            </div>
            {pct !== null ? (
              <p className={`font-extrabold text-sm shrink-0 ${pct >= 75 ? "text-[#006c49]" : pct >= 50 ? "text-[#d58d00]" : "text-[#ba1a1a]"}`}>{pct}%</p>
            ) : (
              <span className="material-symbols-outlined text-[#ba1a1a] shrink-0" style={{ fontVariationSettings: "'FILL' 1" }}>pending_actions</span>
            )}
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
    { icon: "edit_note", label: "听写", href: `/scan?userId=${userId}` },
    { icon: "psychology", label: "Focus Quiz", onClick: () => setShowFocused(true) },
    { icon: "description", label: "Set Papers", onClick: () => setActiveView(v => v === "papers" ? "progress" : "papers"), active: activeView === "papers" },
    { icon: "auto_fix_high", label: "Solver", href: `/solver?userId=${userId}` },
    { icon: "insights", label: "Progress", onClick: () => setActiveView("progress"), active: activeView === "progress" },
  ];

  // ══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════════

  return (
    <div className="min-h-screen bg-[#f8f9ff]">
      {/* Modals */}
      <FocusedModal />
      <QuizModal />
      <FeedbackModal />
      <AdminNotifModal />

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
                    onClick={() => { const isQuizOrFocused = paper.paperType === "quiz" || paper.paperType === "focused"; router.push(isQuizOrFocused ? `/exam/${paper.id}/review?userId=${userId}` : `/exam/${paper.id}/overview?userId=${userId}`); setShowPendingReview(false); }}
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
          <img src="/logo.png" alt="Owl" className="w-9 h-9 object-contain" />
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
            {user.linkedStudents.length > 1 && (
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
          <Link href="/" className="flex items-center gap-3 px-4 py-3 text-slate-500 hover:bg-slate-100 rounded-xl font-medium transition-all hover:translate-x-1">
            <span className="material-symbols-outlined text-xl">settings</span>
            <span>Settings</span>
          </Link>
          <button onClick={() => setShowFeedback(true)} className="w-full flex items-center gap-3 px-4 py-3 text-slate-500 hover:bg-slate-100 rounded-xl font-medium transition-all hover:translate-x-1">
            <span className="material-symbols-outlined text-xl">help</span>
            <span>Support</span>
          </button>
        </div>
      </aside>

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* DESKTOP TOP BAR                                                     */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      <header className="hidden lg:flex fixed top-0 right-0 w-[calc(100%-18rem)] z-40 bg-white/80 backdrop-blur-xl items-center justify-between px-8 py-4 shadow-sm">
        <h1 className="font-headline text-lg font-extrabold text-[#001e40]">
          {activeView === "papers" ? "Set Papers" : "Parent Dashboard"}
        </h1>
        <div className="flex items-center gap-5">
          <div className="relative">
            <span className="material-symbols-outlined text-[#43474f] cursor-pointer hover:text-[#001e40]">notifications</span>
            {adminNotifs.length > 0 && <span className="absolute -top-1 -right-1 w-2 h-2 bg-[#ba1a1a] rounded-full" />}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-[#43474f]">{user.name}</span>
            <div className="relative">
              <button
                onClick={() => setShowProfileMenu(v => !v)}
                className="w-8 h-8 rounded-full bg-[#003366] flex items-center justify-center text-white text-xs font-bold hover:bg-[#003366]/80 transition-colors"
              >
                {initials(user.name)}
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
      </header>

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* MOBILE TOP BAR                                                      */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      <header className="lg:hidden fixed top-0 w-full z-50 bg-[#f8f9ff] flex justify-between items-center px-5 h-16">
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="Owl" className="w-7 h-7 object-contain" />
          <img src="/markforyou2_t.png" alt="Markforyou" className="h-6 object-contain" />
        </div>
        <div className="flex items-center gap-4">
          <div className="relative">
            <span className="material-symbols-outlined text-[#001e40]">notifications</span>
            {adminNotifs.length > 0 && <span className="absolute -top-1 -right-1 w-2 h-2 bg-[#ba1a1a] rounded-full" />}
          </div>
          <div className="relative">
            <button
              onClick={() => setShowProfileMenu(v => !v)}
              className="w-8 h-8 rounded-full bg-[#003366] flex items-center justify-center text-white text-xs font-bold"
            >
              {initials(user.name)}
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
      </header>

      {/* ════════════════════════════════════════════════════════════════════ */}
      {/* MAIN CONTENT                                                        */}
      {/* ════════════════════════════════════════════════════════════════════ */}
      <main className="lg:ml-72 pt-20 lg:pt-24 pb-32 lg:pb-12">

        {/* ── Papers view ─────────────────────────────────────────────────── */}
        {activeView === "papers" && (
          <div className="px-5 lg:px-8 max-w-4xl">
            <div className="flex items-center gap-3 mb-6">
              <button onClick={() => setActiveView("progress")} className="p-2 rounded-xl hover:bg-[#e5eeff] transition-colors">
                <span className="material-symbols-outlined text-[#001e40]">arrow_back</span>
              </button>
              <h2 className="font-headline font-extrabold text-xl text-[#001e40]">Exam Papers</h2>
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
              <div className="space-y-4">
                {masterPapers.map(p => (
                  <ExamPaperCard key={p.id} paper={p} userId={userId} userRole="PARENT"
                    onDelete={id => setExamPapers(prev => prev.filter(x => x.id !== id))} />
                ))}
              </div>
            )}
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
                  {user.linkedStudents.length > 1 && (
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
                <h3 className="font-headline font-bold text-lg mb-5 text-[#001e40]">Performance Analysis</h3>
                <PerformanceCards />
              </section>

              <section>
                <div className="flex justify-between items-center mb-5">
                  <h3 className="font-headline font-bold text-lg text-[#001e40]">Recent Activities</h3>
                  <button onClick={() => setActiveView("papers")} className="text-xs font-extrabold text-[#003366]">View All</button>
                </div>
                <ActivitiesList />
              </section>
            </div>

            {/* ─── DESKTOP LAYOUT ────────────────────────────────────────── */}
            <div className="hidden lg:block px-8 pb-12 max-w-7xl">
              {/* Hero row */}
              <div className="grid grid-cols-12 gap-8 mb-10">
                {/* AI insight — 7 cols */}
                <div className="col-span-7 bg-[#003366] rounded-3xl p-8 text-white relative overflow-hidden flex flex-col justify-between min-h-[300px] shadow-xl">
                  <div className="absolute top-0 right-0 w-64 h-64 bg-[#006c49]/20 rounded-full blur-3xl -mr-20 -mt-20" />
                  <div>
                    <div className="flex items-center gap-2 mb-5">
                      <div className="px-3 py-1 bg-[#006c49]/20 backdrop-blur-md rounded-full border border-[#006c49]/30 flex items-center gap-2">
                        <span className="material-symbols-outlined text-[#4edea3] text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>auto_awesome</span>
                        <span className="text-xs font-extrabold uppercase tracking-wider text-[#4edea3]">AI Smart Insights</span>
                      </div>
                    </div>
                    <h2 className="font-headline text-3xl font-extrabold mb-4 leading-tight">
                      {recLoading ? "Analysing performance…" : focusedGapRec
                        ? `Focus recommended: ${focusedGapRec.gaps?.[0]?.topics?.[0] ?? "Weak areas"}`
                        : `${selectedStudent?.name ?? "Your child"}'s progress overview`}
                    </h2>
                    <p className="text-[#799dd6] text-base max-w-md leading-relaxed">{insightForCard}</p>
                  </div>
                  <div className="mt-8 flex gap-3">
                    <button
                      onClick={() => setShowFocused(true)}
                      className="bg-gradient-to-r from-[#006c49] to-[#4edea3] text-white px-6 py-3 rounded-xl font-bold flex items-center gap-2 hover:-translate-y-0.5 transition-all shadow-lg"
                    >
                      Focused Practice
                      <span className="material-symbols-outlined text-xl">arrow_forward</span>
                    </button>
                    <button
                      onClick={() => setShowQuiz(true)}
                      className="bg-white/10 text-white px-6 py-3 rounded-xl font-bold flex items-center gap-2 hover:-translate-y-0.5 transition-all border border-white/20"
                    >
                      Daily Quiz
                    </button>
                  </div>
                </div>

                {/* Stats — 5 cols */}
                <div className="col-span-5 flex flex-col gap-5">
                  {/* Avg score */}
                  <div className="bg-white rounded-3xl p-6 flex-1 shadow-sm relative overflow-hidden">
                    <div className="flex justify-between items-start">
                      <div>
                        <p className="text-[#43474f] font-medium mb-1">Average Score</p>
                        <h3 className="font-headline text-5xl font-black text-[#001e40]">
                          {avgScore !== null ? <>{avgScore}<span className="text-2xl font-bold">%</span></> : <span className="text-2xl text-[#c3c6d1]">—</span>}
                        </h3>
                      </div>
                      <div className="w-14 h-14 rounded-2xl bg-[#6cf8bb]/30 flex items-center justify-center text-[#006c49]">
                        <span className="material-symbols-outlined text-3xl">trending_up</span>
                      </div>
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
                  </div>
                  {/* Papers */}
                  <div className="bg-[#eff4ff] rounded-3xl p-6 flex items-center gap-5 shadow-sm">
                    <div className="flex-1">
                      <p className="text-[#43474f] font-medium mb-1">Completed Papers</p>
                      <h3 className="font-headline text-3xl font-black text-[#001e40]">{completedPapers.length} <span className="text-sm font-semibold text-[#43474f]">Total</span></h3>
                    </div>
                    <div className="w-px h-12 bg-[#c3c6d1]/40" />
                    <button className="flex-1 text-left hover:opacity-80 transition-opacity" onClick={() => pendingRelease.length > 0 && setShowPendingReview(true)}>
                      <p className={`font-medium mb-1 ${pendingRelease.length === 0 ? "text-[#006c49]" : "text-[#ba1a1a]"}`}>Pending Review</p>
                      <h3 className={`font-headline text-3xl font-black ${pendingRelease.length === 0 ? "text-[#006c49]" : "text-[#ba1a1a]"}`}>{pendingRelease.length}</h3>
                    </button>
                  </div>
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
                      <button onClick={() => setActiveView("papers")} className="text-sm font-extrabold text-[#003366] hover:underline">View All</button>
                    </div>
                    <div className="space-y-5">
                      {recentActivities.length === 0 ? (
                        <p className="text-sm text-[#43474f] text-center py-4">No completed papers yet.</p>
                      ) : recentActivities.map(paper => {
                        const pct = scorePct(paper);
                        return (
                          <div key={paper.id} onClick={() => router.push(`/exam/${paper.id}/overview?userId=${userId}`)}
                            className="flex items-center gap-5 cursor-pointer group hover:opacity-80 transition-opacity">
                            <div className="w-12 h-12 rounded-2xl bg-[#e5eeff] flex items-center justify-center text-[#003366] shrink-0">
                              <span className="material-symbols-outlined">{activityIcon(paper)}</span>
                            </div>
                            <div className="flex-1 min-w-0">
                              <h5 className="font-bold text-[#001e40] truncate">{paper.title}</h5>
                              <p className="text-sm text-[#43474f]">{relativeDate(paper.completedAt!)}</p>
                            </div>
                            <div className="text-right shrink-0">
                              <span className="text-xs text-[#43474f] block">{relativeDate(paper.completedAt!)}</span>
                              {pct !== null ? (
                                <span className={`text-xs font-extrabold ${pct >= 75 ? "text-[#006c49]" : pct >= 50 ? "text-[#d58d00]" : "text-[#ba1a1a]"}`}>
                                  {pct >= 75 ? "PASSED" : pct >= 50 ? "REVIEWING" : "NEEDS WORK"}
                                </span>
                              ) : (
                                <span className="text-xs font-extrabold text-[#d58d00]">PENDING</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
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
          { icon: "edit_note", label: "听写", action: () => router.push(`/scan?userId=${userId}`), active: false },
          { icon: "psychology", label: "Focus Quiz", action: () => setShowFocused(true), active: false },
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
    </div>
  );
}
