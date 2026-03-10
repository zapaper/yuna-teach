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
      await fetch(`/api/exam/${id}`, { method: "DELETE" });
      setExamPapers((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      console.error("Failed to delete exam:", err);
    }
  }

  const isParent = user?.role === "PARENT";
  const isAdmin = user?.name?.toLowerCase() === "admin";
  const hasLinkedStudents = (user?.linkedStudents?.length ?? 0) > 0;
  const [showLinkPrompt, setShowLinkPrompt] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackMsg, setFeedbackMsg] = useState("");
  const [sendingFeedback, setSendingFeedback] = useState(false);
  const [feedbackSent, setFeedbackSent] = useState(false);

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
      <button
        onClick={() => router.push("/")}
        className="flex items-center gap-1 text-slate-500 mb-4 hover:text-slate-700"
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
                onDelete={isAdmin || !isParent ? handleDelete : undefined}
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
                        onDelete={isAdmin ? handleDeleteExam : undefined}
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
                      onDelete={isAdmin ? handleDeleteExam : undefined}
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
    </div>
  );
}
