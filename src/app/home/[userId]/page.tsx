"use client";

import { useEffect, useState, use, useCallback, useRef } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import TestCard from "@/components/TestCard";
import ExamPaperCard from "@/components/ExamPaperCard";
import { SpellingTestSummary, ExamPaperSummary, User } from "@/types";

export default function HomePage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = use(params);
  const router = useRouter();
  const searchParams = useSearchParams();
  const refreshKey = searchParams.get("t") || "";
  const [user, setUser] = useState<User | null>(null);
  const [tests, setTests] = useState<SpellingTestSummary[]>([]);
  const [examPapers, setExamPapers] = useState<ExamPaperSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [subjectFilter, setSubjectFilter] = useState<string | null>(null);
  const [examTypeFilter, setExamTypeFilter] = useState<string | null>(null);
  const [levelFilter, setLevelFilter] = useState<string | null>(null);

  // Invite / link state
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [generatingCode, setGeneratingCode] = useState(false);
  const [connectCode, setConnectCode] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState("");
  const [connectSuccess, setConnectSuccess] = useState("");
  const [showInvite, setShowInvite] = useState(false);
  const [showConnect, setShowConnect] = useState(false);

  const fetchData = useRef<() => Promise<void>>(undefined);
  fetchData.current = async () => {
    try {
      const [usersRes, testsRes, examsRes] = await Promise.all([
        fetch("/api/users"),
        fetch(`/api/tests?userId=${userId}`),
        fetch(`/api/exam?userId=${userId}`),
      ]);
      const [usersData, testsData, examsData] = await Promise.all([
        usersRes.json(),
        testsRes.json(),
        examsRes.json(),
      ]);

      const foundUser = usersData.users.find(
        (u: User) => u.id === userId
      );
      setUser(foundUser || null);
      setTests(testsData.tests);
      setExamPapers(examsData.papers);
    } catch (err) {
      console.error("Failed to fetch data:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData.current?.();

    // Refetch when tab becomes visible (e.g. after upload/create redirects back)
    function onVisible() {
      if (document.visibilityState === "visible") fetchData.current?.();
    }
    // Refetch when student is linked from the register page (opened in new tab)
    function onMessage(e: MessageEvent) {
      if (e.data?.type === "student-linked") fetchData.current?.();
    }
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("message", onMessage);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("message", onMessage);
    };
  }, [userId, refreshKey]);

  // Poll for extraction status updates
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    const anyProcessing = examPapers.some(
      (p) => p.extractionStatus === "processing"
    );
    if (!anyProcessing) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current) return; // already polling
    pollRef.current = setInterval(async () => {
      try {
        const role = user?.role || "STUDENT";
        const res = await fetch(
          `/api/exam?userId=${userId}&role=${role}`
        );
        const data = await res.json();
        setExamPapers(data.papers);
      } catch {
        /* ignore */
      }
    }, 5000);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [examPapers, userId, user?.role]);

  async function handleDelete(id: string) {
    try {
      await fetch(`/api/tests/${id}`, { method: "DELETE" });
      setTests((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      console.error("Failed to delete test:", err);
    }
  }

  async function handleDeleteExam(id: string) {
    try {
      await fetch(`/api/exam/${id}?userId=${userId}`, { method: "DELETE" });
      setExamPapers((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      console.error("Failed to delete exam:", err);
    }
  }

  const isParent = user?.role === "PARENT";
  const isAdmin = user?.name?.toLowerCase() === "admin";
  const hasLinkedStudents = (user?.linkedStudents?.length ?? 0) > 0;
  const [showLinkPrompt, setShowLinkPrompt] = useState(false);
  const [showAllPapers, setShowAllPapers] = useState(false);
  const [showQuizSetup, setShowQuizSetup] = useState(false);
  const [quizType, setQuizType] = useState<"mcq" | "mcq-oeq">("mcq");
  const [quizSubject, setQuizSubject] = useState<"math" | "science">("math");
  const [creatingQuiz, setCreatingQuiz] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState("");
  const [sendingFeedback, setSendingFeedback] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [showGuide, setShowGuide] = useState(false);

  // Parent recommendations / chat panel
  type SubjectGap = { subject: string; topics: string[] };
  type RecAction = { type: string; studentId?: string; studentName?: string; studentLevel?: number | null; gaps?: SubjectGap[]; students?: { id: string; name: string; level: number | null }[]; examType?: string };
  type ChatMsg = { role: "ai" | "user"; text: string };
  const [chatMessages, setChatMessages] = useState<ChatMsg[]>([]);
  const [chatPhase, setChatPhase] = useState<"initial" | "focused" | null>(null);
  const [focusedRec, setFocusedRec] = useState<RecAction | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatSummaries, setChatSummaries] = useState("");
  const [recActions, setRecActions] = useState<RecAction[]>([]);
  const [recActing, setRecActing] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Parent quiz assignment
  const [showParentQuiz, setShowParentQuiz] = useState(false);
  const [parentQuizStudent, setParentQuizStudent] = useState<string>("");
  const [parentQuizType, setParentQuizType] = useState<"mcq" | "mcq-oeq">("mcq");
  const [parentQuizSubject, setParentQuizSubject] = useState<"math" | "science">("math");
  const [creatingParentQuiz, setCreatingParentQuiz] = useState(false);
  const [guidePage, setGuidePage] = useState(0);
  const GUIDE_PAGES = 5; // 0: welcome, 1: spelling, 2: exam papers, 3: focused practice, 4: daily quiz

  // Badge system
  const [quizBadge, setQuizBadge] = useState<{ badge: string; image: string; count: number; streak: number } | null>(null);
  const [badgeToast, setBadgeToast] = useState(false);

  // Fetch quiz badge for students
  useEffect(() => {
    if (!user || isAdmin || isParent) return;
    fetch(`/api/user/${userId}/quiz-badge`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.badge) setQuizBadge({ badge: data.badge, image: data.badgeImage, count: data.completedQuizzes, streak: data.streak ?? 0 });
      })
      .catch(() => {});
  }, [user, userId, isAdmin, isParent]);

  // Fetch parent recommendations (once per day, or on demand via Tips)
  const recFetchingRef = useRef(false);
  const fetchRecommendations = useCallback((force = false) => {
    if (recFetchingRef.current) return;
    const key = `recs-fetched-${userId}`;
    const today = new Date().toDateString();
    if (!force && localStorage.getItem(key) === today) return;
    recFetchingRef.current = true;
    const hour = new Date().getHours();
    fetch(`/api/parent-recommendations?parentId=${userId}&hour=${hour}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.greeting) {
          setChatMessages([{ role: "ai", text: data.greeting }]);
          setChatPhase("initial");
        }
        if (data?.actions?.length) setRecActions(data.actions);
        if (data?.summaries) setChatSummaries(data.summaries);
        if (data?.greeting || data?.actions?.length) localStorage.setItem(key, today);
      })
      .catch(() => {})
      .finally(() => { recFetchingRef.current = false; });
  }, [userId]);
  useEffect(() => {
    if (!user || !isParent || !hasLinkedStudents) return;
    fetchRecommendations(false);
  }, [user, isParent, hasLinkedStudents, fetchRecommendations]);

  // Show guide on first visit for parents
  useEffect(() => {
    if (!user || user.role !== "PARENT") return;
    const key = `guide-dismissed-${userId}`;
    if (!localStorage.getItem(key)) {
      setShowGuide(true);
    }
  }, [user, userId]);

  function dismissGuide() {
    localStorage.setItem(`guide-dismissed-${userId}`, "1");
    setShowGuide(false);
    setGuidePage(0);
  }

  async function handleGenerateCode() {
    setGeneratingCode(true);
    try {
      const res = await fetch("/api/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      const data = await res.json();
      setInviteCode(data.code);
      setShowInvite(true);
    } finally {
      setGeneratingCode(false);
    }
  }

  async function handleConnect() {
    if (!connectCode.trim()) return;
    setConnecting(true);
    setConnectError("");
    setConnectSuccess("");
    try {
      const res = await fetch("/api/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: connectCode.trim(), userId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setConnectError(data.error || "Failed to connect");
        return;
      }
      setConnectSuccess(`Connected to ${data.linkedUser.name}!`);
      setConnectCode("");
      // Refresh user data to show new link
      const usersRes = await fetch("/api/users");
      const usersData = await usersRes.json();
      const foundUser = usersData.users.find((u: User) => u.id === userId);
      setUser(foundUser || null);
    } catch {
      setConnectError("Something went wrong");
    } finally {
      setConnecting(false);
    }
  }

  function handleFocusedSelect(rec: RecAction) {
    setChatMessages(prev => [
      ...prev,
      { role: "user", text: `Focused practice for ${rec.studentName}` },
      { role: "ai", text: `Sure! Based on ${rec.studentName}'s recent results, here are the topics scoring below 75%. Tap Go to create a focused 10-question practice test:` },
    ]);
    setFocusedRec(rec);
    setChatPhase("focused");
  }

  function handleExamComingChat(rec: RecAction) {
    setChatMessages(prev => [
      ...prev,
      { role: "user", text: `Practice ${rec.examType} papers` },
      { role: "ai", text: `I've filtered the exam papers list for ${rec.examType} — you can assign a past-year paper from there.` },
    ]);
    setShowAllPapers(true);
    if (rec.examType) setExamTypeFilter(rec.examType!);
    setChatPhase(null);
    setTimeout(() => document.getElementById("exam-papers-section")?.scrollIntoView({ behavior: "smooth" }), 200);
  }

  function handleDailyQuizChat() {
    const quizRec = recActions.find(r => r.type === "daily-quiz");
    const firstStudent = quizRec?.students?.[0] ?? recActions.find(r => r.type === "focused-gap");
    setChatMessages(prev => [...prev, { role: "user", text: "Assign daily quiz" }]);
    if (firstStudent && "id" in firstStudent) setParentQuizStudent((firstStudent as { id: string }).id);
    else if (firstStudent && "studentId" in firstStudent && firstStudent.studentId) setParentQuizStudent(firstStudent.studentId);
    setShowParentQuiz(true);
    setChatPhase(null);
  }

  async function handleChatSend() {
    if (!chatInput.trim() || chatLoading) return;
    const userText = chatInput.trim();
    setChatInput("");
    const nextMessages: ChatMsg[] = [...chatMessages, { role: "user", text: userText }];
    setChatMessages(nextMessages);
    setChatPhase(null);
    setChatLoading(true);
    try {
      const res = await fetch("/api/parent-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          parentId: userId,
          messages: nextMessages.map(m => ({ role: m.role === "ai" ? "assistant" : "user", content: m.text })),
          studentSummaries: chatSummaries,
        }),
      });
      const data = await res.json();
      if (data?.reply) setChatMessages(prev => [...prev, { role: "ai", text: data.reply }]);
    } catch { /* ignore */ }
    finally { setChatLoading(false); }
  }

  // Auto-scroll chat to bottom when messages change
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, chatLoading]);

  return (
    <div className="p-6 pb-28 animate-fade-in-up">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => router.push("/")}
          className="flex items-center gap-1 text-slate-500 hover:text-slate-700"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m15 18-6-6 6-6" />
          </svg>
          Switch User
        </button>
        {isParent && (
          <button
            onClick={() => setShowGuide(true)}
            className="w-8 h-8 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center text-sm font-bold hover:bg-primary-200 transition-colors"
            title="Help Guide"
          >
            ?
          </button>
        )}
      </div>

      <div className="text-center mb-6">
        <p className="text-sm text-slate-400 mb-0.5">
          {(() => {
            const h = new Date().getHours();
            return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
          })()},{" "}
          {new Date().toLocaleDateString("en-SG", { weekday: "long", day: "numeric", month: "short" })}
        </p>
        <h1 className="text-2xl font-bold text-slate-800">
          {user?.name || "Home"}
        </h1>
        {user?.role === "STUDENT" && user.level ? (
          <p className="text-slate-500 text-sm mt-0.5">Primary {user.level}</p>
        ) : null}
        {quizBadge && (
          <div className="flex flex-col items-center mt-2">
            <button
              onClick={() => {
                setBadgeToast(true);
                setTimeout(() => setBadgeToast(false), 2500);
              }}
              className="flex items-center gap-2 hover:scale-110 transition-transform"
            >
              <img src={quizBadge.image} alt={quizBadge.badge} className="w-7 h-7 object-contain" />
              {quizBadge.streak > 0 && (
                <span className="text-xs font-bold text-amber-500">{quizBadge.streak}-day streak</span>
              )}
            </button>
            {badgeToast && (
              <span className="mt-1 text-xs font-medium text-primary-600 animate-fade-in-up">
                {quizBadge.badge}: completed {quizBadge.count} quizzes
              </span>
            )}
          </div>
        )}

        {/* Linked users info */}
        {isParent && user?.linkedStudents && user.linkedStudents.length > 0 ? (
          <div className="flex flex-col items-center gap-1 mt-3">
            <div className="flex flex-wrap justify-center items-center gap-2">
              {user.linkedStudents.map((s) => (
                <Link key={s.id} href={`/progress/${s.id}?parentId=${userId}`}
                  className="inline-flex items-center px-4 py-2 rounded-full bg-primary-100 text-primary-800 text-base font-bold hover:bg-primary-200 transition-colors shadow-sm">
                  {s.name}
                </Link>
              ))}
              <button
                onClick={() => {
                  if (!showInvite) handleGenerateCode();
                  else setShowInvite(false);
                }}
                disabled={generatingCode}
                className="w-8 h-8 rounded-full bg-slate-100 text-slate-400 hover:bg-primary-100 hover:text-primary-600 flex items-center justify-center text-lg font-bold transition-colors disabled:opacity-50"
                title="Add another student"
              >
                +
              </button>
            </div>
            <button
              onClick={() => fetchRecommendations(true)}
              className="text-xs text-primary-500 hover:text-primary-700 underline mt-0.5"
            >
              Tips
            </button>
          </div>
        ) : null}
        {!isParent && (
          <p className="text-slate-400 text-xs mt-2">
            {user?.linkedParents && user.linkedParents.length > 0
              ? <>Linked to: {user.linkedParents.map((p) => p.name).join(", ")} &middot; </>
              : null}
            <button
              onClick={() => { setShowConnect(!showConnect); setConnectError(""); setConnectSuccess(""); }}
              className="text-primary-500 hover:text-primary-700 font-medium"
            >
              {showConnect ? "Cancel" : "Connect to Parent"}
            </button>
          </p>
        )}
      </div>



      {/* Invite / Connect section */}
      <div className="mb-6">
        {isParent ? (
          <>
            {/* Show full-width Invite button only if no students linked yet */}
            {!hasLinkedStudents && (
              <button
                onClick={() => {
                  if (!showInvite) handleGenerateCode();
                  else setShowInvite(false);
                }}
                disabled={generatingCode}
                className="w-full py-3 rounded-xl border-2 border-primary-200 text-primary-600 font-semibold hover:bg-primary-50 transition-colors disabled:opacity-50"
              >
                {generatingCode ? "Generating..." : showInvite ? "Hide Code" : "Invite Student"}
              </button>
            )}
            {showInvite && inviteCode ? (
              <div className="mt-3 rounded-2xl bg-primary-50 border border-primary-100 p-4 text-center">
                <p className="text-xs text-slate-400 mb-2">Share this code with your student</p>
                <p className="text-3xl font-mono font-bold text-primary-700 tracking-widest">{inviteCode}</p>
                <p className="text-xs text-slate-400 mt-2">Expires in 24 hours</p>
              </div>
            ) : null}
          </>
        ) : (
          <>
            {showConnect ? (
              <div className="rounded-2xl bg-slate-50 border border-slate-100 p-4">
                <p className="text-xs text-slate-400 mb-2">Enter the code from your parent</p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={connectCode}
                    onChange={(e) => { setConnectCode(e.target.value.toUpperCase()); setConnectError(""); }}
                    placeholder="Enter code"
                    maxLength={6}
                    className="flex-1 px-4 py-2.5 rounded-xl border-2 border-slate-200 focus:border-primary-400 focus:outline-none text-center font-mono text-lg tracking-widest uppercase"
                  />
                  <button
                    onClick={handleConnect}
                    disabled={connecting || connectCode.length < 6}
                    className="px-5 py-2.5 rounded-xl bg-primary-600 text-white font-semibold disabled:opacity-50"
                  >
                    {connecting ? "..." : "Link"}
                  </button>
                </div>
                {connectError ? <p className="text-xs text-red-500 mt-2">{connectError}</p> : null}
                {connectSuccess ? <p className="text-xs text-green-500 mt-2">{connectSuccess}</p> : null}
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* Admin keeps full-width action buttons */}
      {isAdmin && (
        <div className="space-y-3 mb-8">
          <Link href={`/scan?userId=${userId}`} className="block w-full bg-accent-orange text-white rounded-2xl py-4 px-6 text-lg font-semibold text-center shadow-lg active:scale-[0.98] transition-transform">
            Scan Spelling / 听写
          </Link>
          <Link href={`/exam/upload?userId=${userId}`} className="block w-full bg-purple-500 text-white rounded-2xl py-4 px-6 text-lg font-semibold text-center shadow-lg active:scale-[0.98] transition-transform">
            Upload Exam Paper
          </Link>
          <Link href="/flagged" className="block w-full bg-amber-500 text-white rounded-2xl py-4 px-6 text-lg font-semibold text-center shadow-lg active:scale-[0.98] transition-transform">
            Review Flagged Q&amp;A
          </Link>
        </div>
      )}

      {/* Student action buttons */}
      {!isAdmin && !isParent && (
        <div className="space-y-3 mb-6">
          <button
            onClick={() => setShowQuizSetup(true)}
            className="block w-full bg-emerald-500 text-white rounded-2xl py-4 px-6 text-lg font-semibold text-center shadow-lg active:scale-[0.98] transition-transform"
          >
            Daily 20min Quiz
          </button>
        </div>
      )}

      {/* Prompt to create student account */}
      {showLinkPrompt ? (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-xl">
            <h3 className="font-semibold text-lg mb-2">No Student Linked</h3>
            <p className="text-slate-600 text-sm mb-4">
              To assign papers, you will need to create an account for your child. Agree to proceed?
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowLinkPrompt(false)}
                className="flex-1 py-2.5 px-4 rounded-xl border border-slate-200 text-slate-600 font-medium hover:bg-slate-50"
              >
                No
              </button>
              <button
                onClick={() => {
                  setShowLinkPrompt(false);
                  window.open(`/register/student?parentId=${userId}`, "_blank");
                }}
                className="flex-1 py-2.5 px-4 rounded-xl bg-primary-600 text-white font-medium hover:bg-primary-700"
              >
                Yes
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* AI Chat Panel for parents */}
      {isParent && chatMessages.length > 0 && (
        <div className="mb-6 rounded-2xl border border-primary-100 overflow-hidden bg-white shadow-sm">
          {/* Message thread */}
          <div className="p-4 space-y-3 max-h-72 overflow-y-auto">
            {chatMessages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-primary-500 text-white rounded-tr-sm"
                    : "bg-primary-50 text-slate-700 rounded-tl-sm"
                }`}>
                  {msg.text}
                </div>
              </div>
            ))}

            {/* Thinking indicator */}
            {chatLoading && (
              <div className="flex justify-start">
                <div className="bg-primary-50 rounded-2xl rounded-tl-sm px-4 py-2 text-slate-400 text-sm">
                  <span className="animate-pulse">...</span>
                </div>
              </div>
            )}

            {/* Initial-phase option buttons */}
            {!chatLoading && chatPhase === "initial" && (
              <div className="flex flex-wrap gap-2 pt-1">
                {recActions.filter(r => r.type === "focused-gap").map((rec, i) => (
                  <button key={`fp-${i}`} onClick={() => handleFocusedSelect(rec)}
                    className="px-3 py-1.5 rounded-xl bg-primary-500 text-white text-sm font-medium hover:bg-primary-600 active:scale-95 transition-transform">
                    Focused practice for {rec.studentName}
                  </button>
                ))}
                {recActions.filter(r => r.type === "exam-coming").map((rec, i) => (
                  <button key={`ec-${i}`} onClick={() => handleExamComingChat(rec)}
                    className="px-3 py-1.5 rounded-xl bg-purple-500 text-white text-sm font-medium hover:bg-purple-600 active:scale-95 transition-transform">
                    Practice {rec.examType} papers
                  </button>
                ))}
                <button onClick={handleDailyQuizChat}
                  className="px-3 py-1.5 rounded-xl bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 active:scale-95 transition-transform">
                  Assign daily quiz
                </button>
              </div>
            )}

            {/* Focused-phase topic list */}
            {!chatLoading && chatPhase === "focused" && focusedRec && (
              <div className="space-y-1.5 pt-1">
                {(focusedRec.gaps ?? []).flatMap((gap: SubjectGap, gi: number) =>
                  gap.topics.map((topic: string, ti: number) => {
                    const key = `${gi}-${ti}`;
                    return (
                      <div key={key} className="flex items-center gap-2">
                        <span className="flex-1 text-sm text-slate-700">
                          • <strong>{topic}</strong> <span className="text-slate-400">({gap.subject})</span>
                        </span>
                        <button
                          disabled={recActing === key}
                          onClick={async () => {
                            setRecActing(key);
                            try {
                              await fetch("/api/focused-test", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ parentId: userId, studentId: focusedRec.studentId, subject: gap.subject, topic }),
                              });
                              setFocusedRec(prev => {
                                if (!prev) return null;
                                const newGaps = (prev.gaps ?? []).map((g: SubjectGap, gj: number) =>
                                  gj !== gi ? g : { ...g, topics: g.topics.filter((_: string, tj: number) => tj !== ti) }
                                ).filter((g: SubjectGap) => g.topics.length > 0);
                                return { ...prev, gaps: newGaps };
                              });
                              fetchData.current?.();
                            } finally { setRecActing(null); }
                          }}
                          className="px-3 py-1 rounded-lg bg-primary-500 text-white text-xs font-medium hover:bg-primary-600 disabled:opacity-50 shrink-0"
                        >
                          {recActing === key ? "..." : "Go →"}
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            )}

            <div ref={chatEndRef} />
          </div>

          {/* Chat input */}
          <div className="border-t border-slate-100 p-3 flex gap-2 bg-slate-50/50">
            <input
              type="text"
              value={chatInput}
              onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleChatSend(); }}
              placeholder="Ask me anything..."
              className="flex-1 px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:border-primary-300 bg-white"
            />
            <button
              onClick={handleChatSend}
              disabled={!chatInput.trim() || chatLoading}
              className="px-4 py-2 rounded-xl bg-primary-500 text-white text-sm font-medium hover:bg-primary-600 disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </div>
      )}

      {/* Parent quiz assignment modal */}
      {showParentQuiz && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={() => setShowParentQuiz(false)}>
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-lg mb-3">Assign Daily Quiz</h3>

            {/* Student selector */}
            {user?.linkedStudents && user.linkedStudents.length > 1 && (
              <>
                <label className="text-sm font-medium text-slate-600 mb-2 block">Student</label>
                <div className="flex gap-2 mb-4 flex-wrap">
                  {user.linkedStudents.map(s => (
                    <button key={s.id} onClick={() => setParentQuizStudent(s.id)}
                      className={`px-3 py-1.5 rounded-xl border-2 text-sm font-medium transition-all ${
                        parentQuizStudent === s.id ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-slate-100 text-slate-600 hover:border-slate-200"
                      }`}>
                      {s.name}
                    </button>
                  ))}
                </div>
              </>
            )}

            <label className="text-sm font-medium text-slate-600 mb-2 block">Subject</label>
            <div className="flex gap-2 mb-4">
              {(["math", "science"] as const).map(s => (
                <button key={s} onClick={() => setParentQuizSubject(s)}
                  className={`flex-1 py-2 rounded-xl border-2 text-sm font-medium transition-all ${
                    parentQuizSubject === s ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-slate-100 text-slate-600"
                  }`}>
                  {s === "math" ? "Mathematics" : "Science"}
                </button>
              ))}
            </div>

            <label className="text-sm font-medium text-slate-600 mb-2 block">Type</label>
            <div className="flex gap-2 mb-5">
              <button onClick={() => setParentQuizType("mcq")}
                className={`flex-1 py-2 rounded-xl border-2 text-sm font-medium transition-all ${
                  parentQuizType === "mcq" ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-slate-100 text-slate-600"
                }`}>MCQ Only</button>
              <button onClick={() => setParentQuizType("mcq-oeq")}
                className={`flex-1 py-2 rounded-xl border-2 text-sm font-medium transition-all ${
                  parentQuizType === "mcq-oeq" ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-slate-100 text-slate-600"
                }`}>MCQ + Written</button>
            </div>

            <div className="flex gap-3">
              <button onClick={() => setShowParentQuiz(false)}
                className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-600 font-medium hover:bg-slate-50">
                Cancel
              </button>
              <button
                disabled={creatingParentQuiz || !parentQuizStudent}
                onClick={async () => {
                  setCreatingParentQuiz(true);
                  try {
                    const res = await fetch("/api/daily-quiz", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ userId: parentQuizStudent, quizType: parentQuizType, subject: parentQuizSubject }),
                    });
                    const data = await res.json();
                    if (!res.ok) { alert(data.error || "Failed"); return; }
                    setShowParentQuiz(false);
                    fetchData.current?.();
                  } catch { alert("Something went wrong"); }
                  finally { setCreatingParentQuiz(false); }
                }}
                className="flex-1 py-2.5 rounded-xl bg-emerald-500 text-white font-medium hover:bg-emerald-600 disabled:opacity-50">
                {creatingParentQuiz ? "Creating..." : "Assign Quiz"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Test list */}
      <div>
        <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">
          Recent Spelling / 听写
        </h2>

        {loading ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-4 border-primary-200 border-t-primary-500" />
          </div>
        ) : tests.length === 0 ? (
          <div className="text-center py-10 rounded-2xl bg-slate-50 border-2 border-dashed border-slate-200">
            <div className="w-12 h-12 rounded-full bg-orange-100 flex items-center justify-center mx-auto mb-3">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-orange-500"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19v20H6.5a2.5 2.5 0 0 1 0-5H19" /></svg>
            </div>
            <p className="text-slate-600 font-medium">No spelling tests yet</p>
            <p className="text-slate-400 text-sm mt-1 mb-3">Take a photo of your spelling list to get started</p>
            <Link href={`/scan?userId=${userId}`} className="inline-block px-4 py-2 rounded-xl bg-accent-orange text-white text-sm font-medium hover:opacity-90">
              Scan Spelling List
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {tests.map((test) => (
              <TestCard
                key={test.id}
                test={test}
                userId={userId}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>

      {/* Exam papers list */}
      <ExamPapersSection
        examPapers={examPapers}
        loading={loading}
        isParent={isParent}
        isAdmin={isAdmin}
        userId={userId}
        userRole={user?.role}
        showAllPapers={showAllPapers}
        setShowAllPapers={setShowAllPapers}
        levelFilter={levelFilter} setLevelFilter={setLevelFilter}
        subjectFilter={subjectFilter} setSubjectFilter={setSubjectFilter}
        examTypeFilter={examTypeFilter} setExamTypeFilter={setExamTypeFilter}
        onDeleteExam={handleDeleteExam}
        onStartQuiz={() => setShowQuizSetup(true)}
      />

      {/* Quiz setup modal */}
      {showQuizSetup && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-xl">
            <h3 className="font-semibold text-lg mb-1">Daily 20min Quiz</h3>

            <label className="text-sm font-medium text-slate-600 mb-2 block">Subject</label>
            <div className="flex gap-2 mb-4">
              {(["math", "science"] as const).map(s => (
                <button
                  key={s}
                  onClick={() => setQuizSubject(s)}
                  className={`flex-1 py-2 rounded-xl border-2 text-sm font-medium transition-all ${
                    quizSubject === s ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-slate-100 text-slate-600 hover:border-slate-200"
                  }`}
                >
                  {s === "math" ? "Mathematics" : "Science"}
                </button>
              ))}
            </div>

            <label className="text-sm font-medium text-slate-600 mb-2 block">Quiz Type</label>
            <div className="space-y-2 mb-5">
              <button
                onClick={() => setQuizType("mcq")}
                className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all text-left ${
                  quizType === "mcq" ? "border-emerald-500 bg-emerald-50" : "border-slate-100 hover:border-slate-200"
                }`}
              >
                <span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                  quizType === "mcq" ? "border-emerald-500" : "border-slate-300"
                }`}>
                  {quizType === "mcq" && <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />}
                </span>
                <div>
                  <p className={`text-sm font-medium ${quizType === "mcq" ? "text-emerald-700" : "text-slate-700"}`}>MCQ Only</p>
                  <p className="text-xs text-slate-400">20 multiple choice questions</p>
                </div>
              </button>
              <button
                onClick={() => setQuizType("mcq-oeq")}
                className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all text-left ${
                  quizType === "mcq-oeq" ? "border-emerald-500 bg-emerald-50" : "border-slate-100 hover:border-slate-200"
                }`}
              >
                <span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                  quizType === "mcq-oeq" ? "border-emerald-500" : "border-slate-300"
                }`}>
                  {quizType === "mcq-oeq" && <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />}
                </span>
                <div>
                  <p className={`text-sm font-medium ${quizType === "mcq-oeq" ? "text-emerald-700" : "text-slate-700"}`}>MCQ + Written</p>
                  <p className="text-xs text-slate-400">10 MCQ + 5 open-ended questions</p>
                </div>
              </button>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setShowQuizSetup(false)}
                className="flex-1 py-2.5 px-4 rounded-xl border border-slate-200 text-slate-600 font-medium hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  setCreatingQuiz(true);
                  try {
                    const res = await fetch("/api/daily-quiz", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ userId, quizType, subject: quizSubject }),
                    });
                    const data = await res.json();
                    if (!res.ok) {
                      alert(data.error || "Failed to create quiz");
                      return;
                    }
                    router.push(`/quiz/${data.id}?userId=${userId}`);
                  } catch {
                    alert("Something went wrong");
                  } finally {
                    setCreatingQuiz(false);
                  }
                }}
                disabled={creatingQuiz}
                className="flex-1 py-2.5 px-4 rounded-xl bg-emerald-500 text-white font-medium hover:bg-emerald-600 disabled:opacity-50"
              >
                {creatingQuiz ? "Creating..." : "Start Quiz"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Feedback button */}
      <div className="text-center py-6">
        <button
          onClick={() => { setShowFeedback(true); setFeedbackSent(false); setFeedbackMsg(""); }}
          className="text-xs text-slate-400 hover:text-slate-500 transition-colors"
        >
          Feedback / Feature Request
        </button>
      </div>

      {/* Feedback modal */}
      {showFeedback && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl p-6 max-w-sm w-full shadow-xl">
            {feedbackSent ? (
              <>
                <p className="text-center text-slate-700 font-medium mb-4">Thank you for your feedback!</p>
                <button
                  onClick={() => setShowFeedback(false)}
                  className="w-full py-2.5 rounded-xl bg-primary-500 text-white font-medium"
                >
                  Close
                </button>
              </>
            ) : (
              <>
                <h3 className="font-semibold text-lg mb-3">Feedback / Feature Request</h3>
                <textarea
                  value={feedbackMsg}
                  onChange={(e) => setFeedbackMsg(e.target.value)}
                  placeholder="Tell us what you think or what you'd like to see..."
                  rows={4}
                  className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:border-primary-400 mb-3"
                />
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowFeedback(false)}
                    className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-600 font-medium hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={async () => {
                      if (!feedbackMsg.trim()) return;
                      setSendingFeedback(true);
                      try {
                        await fetch("/api/feedback", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ userId, message: feedbackMsg }),
                        });
                        setFeedbackSent(true);
                      } catch { /* ignore */ }
                      finally { setSendingFeedback(false); }
                    }}
                    disabled={sendingFeedback || !feedbackMsg.trim()}
                    className="flex-1 py-2.5 rounded-xl bg-primary-500 text-white font-medium hover:bg-primary-600 disabled:opacity-50"
                  >
                    {sendingFeedback ? "Sending..." : "Send"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Parent Welcome Guide (multi-page) */}
      {showGuide && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4" onClick={dismissGuide}>
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-xl max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>

            {/* Page dots */}
            <div className="flex justify-center gap-1.5 mb-4">
              {Array.from({ length: GUIDE_PAGES }).map((_, i) => (
                <button key={i} onClick={() => setGuidePage(i)}
                  className={`w-2 h-2 rounded-full transition-colors ${i === guidePage ? "bg-primary-500" : "bg-slate-200"}`} />
              ))}
            </div>

            {guidePage === 0 && (
              <>
                <div className="text-center mb-5">
                  <div className="w-14 h-14 rounded-full bg-primary-100 flex items-center justify-center mx-auto mb-3">
                    <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary-600">
                      <path d="M12 3 2 12h3v8h6v-6h2v6h6v-8h3Z" />
                    </svg>
                  </div>
                  <h2 className="text-xl font-bold text-slate-800">Welcome to Mark for You!</h2>
                </div>
                <p className="text-sm text-slate-600 leading-relaxed mb-4">
                  This is your AI assistant to help you be super effective and efficient in guiding your child&apos;s work.
                  We encourage you to stay in charge of your child&apos;s learning, but let the AI do the tedious work for you.
                </p>
                <div className="bg-blue-50 rounded-xl p-4 mb-4">
                  <p className="text-sm text-slate-700 leading-relaxed">
                    <strong>We recommend you start by</strong> creating a child account, linking it, and letting your child do <strong>1–2 daily quizzes</strong> (20 mins each).
                    From there the AI will automatically mark and diagnose gaps to improve.
                    You can then move on to <strong>customised focused practice</strong> or <strong>assign past-year papers</strong>.
                  </p>
                </div>
              </>
            )}

            {guidePage === 1 && (
              <>
                <div className="text-center mb-5">
                  <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-3">
                    <span className="text-2xl">&#x1F4D6;</span>
                  </div>
                  <h2 className="text-xl font-bold text-slate-800">Spelling / &#x542C;&#x5199;</h2>
                  <p className="text-xs text-slate-400 mt-1">Feature Guide</p>
                </div>
                <div className="space-y-3 mb-6">
                  <div className="flex gap-3 items-start">
                    <span className="w-6 h-6 rounded-full bg-green-100 text-green-600 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">1</span>
                    <p className="text-sm text-slate-600">Your child can <strong>take a picture of their spelling list</strong>. The AI will read and generate the list automatically.</p>
                  </div>
                  <div className="flex gap-3 items-start">
                    <span className="w-6 h-6 rounded-full bg-green-100 text-green-600 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">2</span>
                    <p className="text-sm text-slate-600"><strong>Tap each word</strong> for the AI to read out the &#x62FC;&#x97F3;, meaning and a short example sentence.</p>
                  </div>
                  <div className="flex gap-3 items-start">
                    <span className="w-6 h-6 rounded-full bg-green-100 text-green-600 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">3</span>
                    <p className="text-sm text-slate-600">Press <strong>&ldquo;Begin Test&rdquo;</strong> for the AI to read out the &#x542C;&#x5199; slowly, one word at a time.</p>
                  </div>
                  <div className="flex gap-3 items-start">
                    <span className="w-6 h-6 rounded-full bg-green-100 text-green-600 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">4</span>
                    <p className="text-sm text-slate-600">We encourage you to <strong>check your child for any &#x9519;&#x5B57;</strong> and go through their mistakes with them.</p>
                  </div>
                </div>
              </>
            )}

            {guidePage === 2 && (
              <>
                <div className="text-center mb-5">
                  <div className="w-14 h-14 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-3">
                    <span className="text-2xl">&#x1F4DD;</span>
                  </div>
                  <h2 className="text-xl font-bold text-slate-800">Assign Past Year Papers</h2>
                  <p className="text-xs text-slate-400 mt-1">Feature Guide</p>
                </div>
                <p className="text-sm text-slate-600 leading-relaxed mb-4">
                  These are past year papers from top schools. The AI will automatically mark and grade within 5 minutes of submission.
                </p>
                <div className="space-y-3 mb-6">
                  <div className="flex gap-3 items-start">
                    <span className="text-lg shrink-0 mt-0.5">&#x270D;&#xFE0F;</span>
                    <p className="text-sm text-slate-600">We encourage students to <strong>write with a stylus on the tablet</strong>. It takes a couple of minutes to get used to it.</p>
                  </div>
                  <div className="flex gap-3 items-start">
                    <span className="text-lg shrink-0 mt-0.5">&#x1F5A8;&#xFE0F;</span>
                    <p className="text-sm text-slate-600">You can also choose to <strong>download &rarr; print &rarr; write &rarr; scan &rarr; submit</strong> the paper. If so, please make sure you scan the cover pages as well.</p>
                  </div>
                  <div className="flex gap-3 items-start">
                    <span className="text-lg shrink-0 mt-0.5">&#x1F469;&#x200D;&#x1F3EB;</span>
                    <p className="text-sm text-slate-600">We encourage you to <strong>go through the mistakes with your child</strong>. Use &ldquo;AI explanation&rdquo; if you would like a more detailed explanation of the solution.</p>
                  </div>
                </div>
              </>
            )}

            {guidePage === 3 && (
              <>
                <div className="text-center mb-5">
                  <div className="w-14 h-14 rounded-full bg-violet-100 flex items-center justify-center mx-auto mb-3">
                    <span className="text-2xl">&#x1F3AF;</span>
                  </div>
                  <h2 className="text-xl font-bold text-slate-800">Focused Practice</h2>
                  <p className="text-xs text-slate-400 mt-1">Feature Guide</p>
                </div>
                <div className="space-y-3 mb-6">
                  <div className="flex gap-3 items-start">
                    <span className="text-lg shrink-0 mt-0.5">&#x1F4CA;</span>
                    <p className="text-sm text-slate-600">All your child&apos;s work and performance is stored in the server. <strong>Click your child&apos;s name</strong> on your homepage to access the details.</p>
                  </div>
                  <div className="flex gap-3 items-start">
                    <span className="text-lg shrink-0 mt-0.5">&#x1F50D;</span>
                    <p className="text-sm text-slate-600">The AI will show <strong>which topics your child is weak in</strong>, and you can assign &ldquo;focused practice&rdquo; on that weak topic.</p>
                  </div>
                  <div className="flex gap-3 items-start">
                    <span className="text-lg shrink-0 mt-0.5">&#x1F4DA;</span>
                    <p className="text-sm text-slate-600">The AI will assign questions on that topic, <strong>drawn from our top school question bank</strong>. This will be auto-marked within 2 minutes of your child&apos;s submission.</p>
                  </div>
                  <div className="flex gap-3 items-start">
                    <span className="text-lg shrink-0 mt-0.5">&#x1F469;&#x200D;&#x1F3EB;</span>
                    <p className="text-sm text-slate-600">We encourage you to <strong>go through your child&apos;s mistakes</strong> and clarify any gaps in understanding.</p>
                  </div>
                </div>
              </>
            )}

            {guidePage === 4 && (
              <>
                <div className="text-center mb-5">
                  <div className="w-14 h-14 rounded-full bg-teal-100 flex items-center justify-center mx-auto mb-3">
                    <span className="text-2xl">&#x23F1;&#xFE0F;</span>
                  </div>
                  <h2 className="text-xl font-bold text-slate-800">Daily Quiz</h2>
                  <p className="text-xs text-slate-400 mt-1">Feature Guide</p>
                </div>
                <div className="space-y-3 mb-6">
                  <div className="flex gap-3 items-start">
                    <span className="text-lg shrink-0 mt-0.5">&#x1F4AA;</span>
                    <p className="text-sm text-slate-600">Daily quizzes are a great way to get <strong>habitual bite-size practices</strong>.</p>
                  </div>
                  <div className="flex gap-3 items-start">
                    <span className="text-lg shrink-0 mt-0.5">&#x1F3EB;</span>
                    <p className="text-sm text-slate-600">Questions are drawn from our <strong>top-school question banks</strong> appropriate for that level and semester.</p>
                  </div>
                  <div className="flex gap-3 items-start">
                    <span className="text-lg shrink-0 mt-0.5">&#x2705;</span>
                    <p className="text-sm text-slate-600">You can choose <strong>MCQ-only quiz</strong> or <strong>MCQ + open-ended quiz</strong> (requires stylus).</p>
                  </div>
                  <div className="flex gap-3 items-start">
                    <span className="text-lg shrink-0 mt-0.5">&#x1F469;&#x200D;&#x1F3EB;</span>
                    <p className="text-sm text-slate-600">Again, we encourage you to <strong>go through the mistakes with your child</strong>.</p>
                  </div>
                </div>
              </>
            )}

            {/* Navigation buttons */}
            <div className="flex gap-2">
              {guidePage > 0 && (
                <button
                  onClick={() => setGuidePage(p => p - 1)}
                  className="flex-1 py-3 rounded-xl border border-slate-200 text-slate-600 font-semibold hover:bg-slate-50 transition-colors"
                >
                  Back
                </button>
              )}
              {guidePage < GUIDE_PAGES - 1 ? (
                <button
                  onClick={() => setGuidePage(p => p + 1)}
                  className="flex-1 py-3 rounded-xl bg-primary-500 text-white font-semibold hover:bg-primary-600 transition-colors"
                >
                  Next
                </button>
              ) : (
                <button
                  onClick={dismissGuide}
                  className="flex-1 py-3 rounded-xl bg-primary-500 text-white font-semibold hover:bg-primary-600 transition-colors"
                >
                  Got it!
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Bottom tab bar — students and parents */}
      {!isAdmin && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 z-40">
          <div className="max-w-lg mx-auto flex">
            {/* Home tab */}
            <button
              onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
              className="flex-1 flex flex-col items-center py-2 text-primary-600"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3 2 12h3v8h6v-6h2v6h6v-8h3Z" /></svg>
              <span className="text-[10px] font-medium mt-0.5">Home</span>
            </button>

            {/* Spelling tab */}
            <Link href={`/scan?userId=${userId}`} className="flex-1 flex flex-col items-center py-2 text-slate-400 hover:text-accent-orange transition-colors">
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19v20H6.5a2.5 2.5 0 0 1 0-5H19" /></svg>
              <span className="text-[10px] font-medium mt-0.5">听写</span>
            </Link>

            {/* Quiz tab — students only */}
            {!isParent && (
              <button onClick={() => setShowQuizSetup(true)} className="flex-1 flex flex-col items-center py-2 text-slate-400 hover:text-emerald-500 transition-colors">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                <span className="text-[10px] font-medium mt-0.5">Quiz</span>
              </button>
            )}

            {/* Papers tab — parents */}
            {isParent && (
              <button
                onClick={() => {
                  if (hasLinkedStudents) document.getElementById("exam-papers-section")?.scrollIntoView({ behavior: "smooth" });
                  else setShowLinkPrompt(true);
                }}
                className="flex-1 flex flex-col items-center py-2 text-slate-400 hover:text-purple-500 transition-colors"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>
                <span className="text-[10px] font-medium mt-0.5">Papers</span>
              </button>
            )}

            {/* Solver tab — parents only */}
            {isParent && (
              <Link href={`/solver?userId=${userId}`} className="flex-1 flex flex-col items-center py-2 text-slate-400 hover:text-teal-500 transition-colors">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v10h16V10a2 2 0 0 0-2-2h-2V6a4 4 0 0 0-4-4Z"/></svg>
                <span className="text-[10px] font-medium mt-0.5">Solver</span>
              </Link>
            )}

            {/* Progress tab — parents with linked students */}
            {isParent && hasLinkedStudents && user?.linkedStudents?.[0] && (
              <Link href={`/progress/${user.linkedStudents[0].id}?parentId=${userId}`} className="flex-1 flex flex-col items-center py-2 text-slate-400 hover:text-primary-500 transition-colors">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>
                <span className="text-[10px] font-medium mt-0.5">Progress</span>
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════ */
/*  ExamPapersSection — extracted for cleaner structure                       */
/* ═══════════════════════════════════════════════════════════════════════════ */

function ExamPapersSection({
  examPapers, loading, isParent, isAdmin, userId, userRole,
  showAllPapers, setShowAllPapers,
  levelFilter, setLevelFilter,
  subjectFilter, setSubjectFilter,
  examTypeFilter, setExamTypeFilter,
  onDeleteExam, onStartQuiz,
}: {
  examPapers: ExamPaperSummary[];
  loading: boolean;
  isParent: boolean;
  isAdmin: boolean;
  userId: string;
  userRole?: "PARENT" | "STUDENT";
  showAllPapers: boolean;
  setShowAllPapers: (fn: (v: boolean) => boolean) => void;
  levelFilter: string | null; setLevelFilter: (v: string | null) => void;
  subjectFilter: string | null; setSubjectFilter: (v: string | null) => void;
  examTypeFilter: string | null; setExamTypeFilter: (v: string | null) => void;
  onDeleteExam: (id: string) => void;
  onStartQuiz: () => void;
}) {
  const [showCompleted, setShowCompleted] = useState(false);

  // Apply filters
  let filtered = examPapers;
  if (levelFilter) filtered = filtered.filter(p => p.level === levelFilter);
  if (subjectFilter) filtered = filtered.filter(p => p.subject === subjectFilter);
  if (examTypeFilter) filtered = filtered.filter(p => p.examType === examTypeFilter);

  // Split papers by role
  const pendingPapers = isParent ? filtered.filter(p => p.pendingReviewCount > 0) : [];
  const todoPapers = !isParent && !isAdmin ? filtered.filter(p => !p.completedAt) : [];
  const completedPapers = !isParent && !isAdmin ? filtered.filter(p => p.completedAt) : [];
  const allPapers = isParent ? filtered : isAdmin ? filtered : [];

  function canDelete(paper: ExamPaperSummary) {
    return isAdmin || (isParent && paper.paperType === "focused") || (!isParent && !isAdmin && paper.paperType === "quiz");
  }

  // Filter buttons helper
  function FilterButtons({ items, active, onSelect, color }: { items: string[]; active: string | null; onSelect: (v: string | null) => void; color: string }) {
    if (items.length === 0) return null;
    return (
      <div className="flex gap-1.5 mb-3 overflow-x-auto pb-1">
        <button onClick={() => onSelect(null)}
          className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${active === null ? `bg-${color}-500 text-white` : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}>
          All
        </button>
        {items.map(item => (
          <button key={item} onClick={() => onSelect(item)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${active === item ? `bg-${color}-500 text-white` : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}>
            {item}
          </button>
        ))}
      </div>
    );
  }

  const levels = [...new Set(examPapers.map(p => p.level).filter(Boolean))].sort() as string[];
  const subjects = [...new Set(examPapers.map(p => p.subject).filter(Boolean))].sort() as string[];
  const examTypes = (() => {
    const types = [...new Set(examPapers.map(p => p.examType).filter(Boolean))] as string[];
    const order = ["Preliminary", "WA1", "WA2", "WA3", "End of Year"];
    types.sort((a, b) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)));
    return types;
  })();

  const filtersSection = (
    <>
      <FilterButtons items={levels} active={levelFilter} onSelect={setLevelFilter} color="green" />
      <FilterButtons items={subjects} active={subjectFilter} onSelect={setSubjectFilter} color="primary" />
      <FilterButtons items={examTypes} active={examTypeFilter} onSelect={setExamTypeFilter} color="purple" />
    </>
  );

  const emptyState = (
    <div className="text-center py-10 rounded-2xl bg-slate-50 border-2 border-dashed border-slate-200">
      <div className="w-12 h-12 rounded-full bg-purple-100 flex items-center justify-center mx-auto mb-3">
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-purple-500"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>
      </div>
      <p className="text-slate-600 font-medium">{examPapers.length === 0 ? "No exam papers yet" : "No matching papers"}</p>
      <p className="text-slate-400 text-sm mt-1">
        {examPapers.length === 0
          ? isParent ? "Assign a past-year paper to get started" : !isAdmin ? "Take a daily quiz while waiting!" : null
          : "Try changing your filters"}
      </p>
      {!isAdmin && !isParent && examPapers.length === 0 && (
        <button onClick={onStartQuiz} className="inline-block mt-3 px-4 py-2 rounded-xl bg-emerald-500 text-white text-sm font-medium hover:opacity-90">Start a Quiz</button>
      )}
    </div>
  );

  function PaperList({ papers }: { papers: ExamPaperSummary[] }) {
    return (
      <div className="space-y-3">
        {papers.map(paper => (
          <ExamPaperCard key={paper.id} paper={paper} userId={userId} userRole={userRole} isAdmin={isAdmin}
            onDelete={canDelete(paper) ? onDeleteExam : undefined} />
        ))}
      </div>
    );
  }

  if (loading) return null;

  return (
    <div className="mt-8" id="exam-papers-section">
      <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">
        {isParent ? "Your Child\u2019s Work" : "Exam Papers"}
      </h2>

      {/* ─── PARENT VIEW ─── */}
      {isParent && (
        <>
          {/* Always show pending review */}
          {pendingPapers.length > 0 && (
            <div className="mb-5">
              <h3 className="text-sm font-semibold text-amber-600 uppercase tracking-wider mb-3">Pending Review</h3>
              <PaperList papers={pendingPapers} />
            </div>
          )}

          {/* Toggle to show full list with filters */}
          <button
            onClick={() => setShowAllPapers(v => !v)}
            className="w-full py-3 rounded-xl border-2 border-dashed border-slate-200 text-slate-500 font-medium hover:border-primary-300 hover:text-primary-600 transition-colors mb-4"
          >
            {showAllPapers ? "Hide exam papers" : "Assign new exam paper"}
          </button>

          {showAllPapers && (
            <>
              {filtersSection}
              {filtered.length === 0 ? emptyState : <PaperList papers={filtered} />}
            </>
          )}
        </>
      )}

      {/* ─── STUDENT VIEW ─── */}
      {!isParent && !isAdmin && (
        <>
          {/* To Do — always visible */}
          {todoPapers.length > 0 && (
            <div className="mb-5">
              <h3 className="text-sm font-semibold text-amber-600 uppercase tracking-wider mb-3">To Do</h3>
              <PaperList papers={todoPapers} />
            </div>
          )}

          {/* Completed — hidden behind toggle */}
          {completedPapers.length > 0 && (
            <>
              <button
                onClick={() => setShowCompleted(v => !v)}
                className="w-full py-2.5 rounded-xl border border-slate-200 text-slate-400 text-sm font-medium hover:text-slate-600 hover:border-slate-300 transition-colors mb-3"
              >
                {showCompleted ? "Hide completed" : `Show completed papers (${completedPapers.length})`}
              </button>
              {showCompleted && <PaperList papers={completedPapers} />}
            </>
          )}

          {todoPapers.length === 0 && completedPapers.length === 0 && emptyState}
        </>
      )}

      {/* ─── ADMIN VIEW ─── */}
      {isAdmin && (
        <>
          {filtersSection}
          {filtered.length === 0 ? emptyState : <PaperList papers={allPapers} />}
        </>
      )}
    </div>
  );
}
