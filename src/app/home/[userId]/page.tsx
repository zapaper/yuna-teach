"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import TestCard from "@/components/TestCard";
import ExamPaperCard from "@/components/ExamPaperCard";
import { SpellingTestSummary, ExamPaperSummary, User } from "@/types";
import { useRef } from "react";

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
  const [showQuizSetup, setShowQuizSetup] = useState(false);
  const [quizType, setQuizType] = useState<"mcq" | "mcq-oeq">("mcq");
  const [quizSubject, setQuizSubject] = useState<"math" | "science">("math");
  const [creatingQuiz, setCreatingQuiz] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState("");
  const [sendingFeedback, setSendingFeedback] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
  const [guidePage, setGuidePage] = useState(0);
  const GUIDE_PAGES = 3; // 0: welcome, 1: spelling, 2: exam papers

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

  return (
    <div className="p-6 pb-24">
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

      <div className="text-center mb-8">
        <h1 className="text-2xl font-bold text-slate-800">
          {user?.name ? `${user.name}'s Page` : "Home"}
        </h1>
        {user?.role === "STUDENT" && user.level ? (
          <p className="text-slate-500 text-sm mt-1">Primary {user.level}</p>
        ) : null}

        {/* Linked users info */}
        {isParent && user?.linkedStudents && user.linkedStudents.length > 0 ? (
          <div className="flex flex-wrap justify-center gap-2 mt-3">
            {user.linkedStudents.map((s) => (
              <Link key={s.id} href={`/progress/${s.id}?parentId=${userId}`}
                className="inline-flex items-center px-3 py-1 rounded-full bg-primary-50 text-primary-700 text-xs font-medium hover:bg-primary-100 transition-colors">
                {s.name}
              </Link>
            ))}
          </div>
        ) : null}
        {!isParent && user?.linkedParents && user.linkedParents.length > 0 ? (
          <p className="text-slate-400 text-xs mt-2">
            Linked to: {user.linkedParents.map((p) => p.name).join(", ")}
          </p>
        ) : null}
      </div>

      {/* Invite / Connect section */}
      <div className="mb-6">
        {isParent ? (
          <>
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
            <button
              onClick={() => { setShowConnect(!showConnect); setConnectError(""); setConnectSuccess(""); }}
              className="w-full py-3 rounded-xl border-2 border-primary-200 text-primary-600 font-semibold hover:bg-primary-50 transition-colors"
            >
              {showConnect ? "Cancel" : "Connect to Parent"}
            </button>
            {showConnect ? (
              <div className="mt-3 rounded-2xl bg-slate-50 border border-slate-100 p-4">
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

      {/* Action buttons */}
      <div className="space-y-3 mb-8">
        <Link
          href={`/scan?userId=${userId}`}
          className="block w-full bg-accent-orange text-white rounded-2xl py-4 px-6 text-lg font-semibold text-center shadow-lg active:scale-[0.98] transition-transform"
        >
          Scan Spelling / 听写
        </Link>
        {!isAdmin && !isParent && (
          <button
            onClick={() => setShowQuizSetup(true)}
            className="block w-full bg-emerald-500 text-white rounded-2xl py-4 px-6 text-lg font-semibold text-center shadow-lg active:scale-[0.98] transition-transform"
          >
            Daily 20min Quiz
          </button>
        )}
        {isAdmin ? (
          <>
            <Link
              href={`/exam/upload?userId=${userId}`}
              className="block w-full bg-purple-500 text-white rounded-2xl py-4 px-6 text-lg font-semibold text-center shadow-lg active:scale-[0.98] transition-transform"
            >
              Upload Exam Paper
            </Link>
            <Link
              href="/flagged"
              className="block w-full bg-amber-500 text-white rounded-2xl py-4 px-6 text-lg font-semibold text-center shadow-lg active:scale-[0.98] transition-transform"
            >
              Review Flagged Q&amp;A
            </Link>
          </>
        ) : isParent ? (
          <>
            <button
              onClick={() => {
                if (hasLinkedStudents) {
                  document.getElementById("exam-papers-section")?.scrollIntoView({ behavior: "smooth" });
                } else {
                  setShowLinkPrompt(true);
                }
              }}
              className="block w-full bg-purple-500 text-white rounded-2xl py-4 px-6 text-lg font-semibold text-center shadow-lg active:scale-[0.98] transition-transform"
            >
              Assign Papers
            </button>
            <Link
              href={`/solver?userId=${userId}`}
              className="block w-full bg-teal-500 text-white rounded-2xl py-4 px-6 text-lg font-semibold text-center shadow-lg active:scale-[0.98] transition-transform"
            >
              AI Solver
            </Link>
          </>
        ) : null}
      </div>

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
          <div className="text-center py-12">
            <div className="text-4xl mb-3">📝</div>
            <p className="text-slate-500">No spelling tests yet.</p>
            <p className="text-slate-400 text-sm">
              Scan your first one to get started!
            </p>
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
      <div className="mt-8" id="exam-papers-section">
        <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">
          Exam Papers
        </h2>

        {/* Level filter — for parents/admin */}
        {(() => {
          const levels = [...new Set(examPapers.map((p) => p.level).filter(Boolean))] as string[];
          if (levels.length === 0) return null;
          levels.sort();
          return (
            <div className="flex gap-1.5 mb-3 overflow-x-auto pb-1">
              <button
                onClick={() => setLevelFilter(null)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                  levelFilter === null
                    ? "bg-green-500 text-white"
                    : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                }`}
              >
                All Levels
              </button>
              {levels.map((l) => (
                <button
                  key={l}
                  onClick={() => setLevelFilter(l)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                    levelFilter === l
                      ? "bg-green-500 text-white"
                      : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                  }`}
                >
                  {l}
                </button>
              ))}
            </div>
          );
        })()}

        {/* Subject tabs */}
        {(() => {
          const subjects = [...new Set(examPapers.map((p) => p.subject).filter(Boolean))] as string[];
          if (subjects.length === 0) return null;
          return (
            <div className="flex gap-1.5 mb-3 overflow-x-auto pb-1">
              <button
                onClick={() => setSubjectFilter(null)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                  subjectFilter === null
                    ? "bg-primary-500 text-white"
                    : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                }`}
              >
                All Subjects
              </button>
              {subjects.sort().map((s) => (
                <button
                  key={s}
                  onClick={() => setSubjectFilter(s)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                    subjectFilter === s
                      ? "bg-primary-500 text-white"
                      : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          );
        })()}

        {/* Exam type tabs */}
        {(() => {
          const types = [...new Set(examPapers.map((p) => p.examType).filter(Boolean))] as string[];
          if (types.length === 0) return null;
          const order = ["Preliminary", "WA1", "WA2", "WA3", "End of Year"];
          types.sort((a, b) => {
            const ia = order.indexOf(a), ib = order.indexOf(b);
            return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
          });
          return (
            <div className="flex gap-1.5 mb-3 overflow-x-auto pb-1">
              <button
                onClick={() => setExamTypeFilter(null)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                  examTypeFilter === null
                    ? "bg-purple-500 text-white"
                    : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                }`}
              >
                All Types
              </button>
              {types.map((t) => (
                <button
                  key={t}
                  onClick={() => setExamTypeFilter(t)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                    examTypeFilter === t
                      ? "bg-purple-500 text-white"
                      : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          );
        })()}

        {(() => {
          let filtered = examPapers;
          if (levelFilter) filtered = filtered.filter((p) => p.level === levelFilter);
          if (subjectFilter) filtered = filtered.filter((p) => p.subject === subjectFilter);
          if (examTypeFilter) filtered = filtered.filter((p) => p.examType === examTypeFilter);

          // Split into assigned/pending and regular/completed papers
          const assignedPapers = isParent
            ? filtered.filter((p) => p.pendingReviewCount > 0)
            : !isAdmin
            ? filtered.filter((p) => !p.completedAt)
            : [];
          const regularPapers = isParent
            ? filtered.filter((p) => p.pendingReviewCount === 0)
            : !isAdmin
            ? filtered.filter((p) => p.completedAt)
            : filtered;

          return loading ? null : filtered.length === 0 ? (
            <div className="text-center py-8">
              <div className="text-4xl mb-3">📄</div>
              <p className="text-slate-500">
                {examPapers.length === 0 ? "No exam papers yet." : "No matching papers."}
              </p>
              <p className="text-slate-400 text-sm">
                {examPapers.length === 0
                  ? isParent
                    ? "Upload a PDF exam paper to get started!"
                    : "No exam papers have been assigned to you yet."
                  : null}
              </p>
            </div>
          ) : (
            <>
              {/* Assigned / To Do section */}
              {assignedPapers.length > 0 && (
                <div className="mb-6">
                  <h3 className="text-sm font-semibold text-amber-600 uppercase tracking-wider mb-3">
                    {isParent ? "Pending Review" : "To Do"}
                  </h3>
                  <div className="space-y-3">
                    {assignedPapers.map((paper) => (
                      <ExamPaperCard
                        key={paper.id}
                        paper={paper}
                        userId={userId}
                        userRole={user?.role}
                        isAdmin={isAdmin}
                        onDelete={isAdmin || (isParent && paper.paperType === "focused") || (!isParent && !isAdmin && paper.paperType === "quiz") ? handleDeleteExam : undefined}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Regular / Completed Exam Papers */}
              {regularPapers.length > 0 ? (
                <div className="space-y-3">
                  {(isParent || (!isAdmin && assignedPapers.length > 0)) && (
                    <h3 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-1">
                      {isParent ? "Exams" : "Completed"}
                    </h3>
                  )}
                  {regularPapers.map((paper) => (
                    <ExamPaperCard
                      key={paper.id}
                      paper={paper}
                      userId={userId}
                      userRole={user?.role}
                      isAdmin={isAdmin}
                      onDelete={isAdmin || (isParent && paper.paperType === "focused") || (!isParent && !isAdmin && paper.paperType === "quiz") ? handleDeleteExam : undefined}
                    />
                  ))}
                </div>
              ) : assignedPapers.length === 0 ? (
                <div className="text-center py-8">
                  <div className="text-4xl mb-3">📄</div>
                  <p className="text-slate-500">No exam papers yet.</p>
                </div>
              ) : null}
            </>
          );
        })()}
      </div>

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
                <div className="space-y-3 mb-6">
                  <div className="flex gap-3 items-start">
                    <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">1</span>
                    <p className="text-sm text-slate-600"><strong>Upload exam papers</strong> — Scan or photograph your child&apos;s exam papers. The AI will extract and organise all the questions automatically.</p>
                  </div>
                  <div className="flex gap-3 items-start">
                    <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">2</span>
                    <p className="text-sm text-slate-600"><strong>AI marks the paper</strong> — Written answers are marked instantly by AI, with detailed feedback and model solutions for every question.</p>
                  </div>
                  <div className="flex gap-3 items-start">
                    <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">3</span>
                    <p className="text-sm text-slate-600"><strong>Review and guide</strong> — Check the AI&apos;s marking, review your child&apos;s mistakes, and use the progress tracker to spot weak areas.</p>
                  </div>
                  <div className="flex gap-3 items-start">
                    <span className="w-6 h-6 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">4</span>
                    <p className="text-sm text-slate-600"><strong>Focused practice</strong> — Generate targeted worksheets on topics your child needs more practice on. The AI handles the repetitive work so you can focus on coaching.</p>
                  </div>
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
                  <h2 className="text-xl font-bold text-slate-800">Exam Papers</h2>
                  <p className="text-xs text-slate-400 mt-1">Feature Guide</p>
                </div>
                <div className="space-y-3 mb-6">
                  <div className="flex gap-3 items-start">
                    <span className="w-6 h-6 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">1</span>
                    <p className="text-sm text-slate-600"><strong>Upload a past-year paper</strong> — Take photos or upload a PDF of the exam paper and its answer key.</p>
                  </div>
                  <div className="flex gap-3 items-start">
                    <span className="w-6 h-6 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">2</span>
                    <p className="text-sm text-slate-600"><strong>Assign to your child</strong> — The paper appears on their home page as a &ldquo;To Do&rdquo; task.</p>
                  </div>
                  <div className="flex gap-3 items-start">
                    <span className="w-6 h-6 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">3</span>
                    <p className="text-sm text-slate-600"><strong>AI marks it</strong> — Once submitted, MCQ is auto-scored and written answers are marked by AI with feedback and model solutions.</p>
                  </div>
                  <div className="flex gap-3 items-start">
                    <span className="w-6 h-6 rounded-full bg-amber-100 text-amber-600 flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">4</span>
                    <p className="text-sm text-slate-600"><strong>Review together</strong> — Go through the results with your child. You can flag any question for re-marking or override the AI&apos;s score.</p>
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
    </div>
  );
}
