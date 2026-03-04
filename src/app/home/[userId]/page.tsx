"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  const [user, setUser] = useState<User | null>(null);
  const [tests, setTests] = useState<SpellingTestSummary[]>([]);
  const [examPapers, setExamPapers] = useState<ExamPaperSummary[]>([]);
  const [loading, setLoading] = useState(true);

  // Invite / link state
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [generatingCode, setGeneratingCode] = useState(false);
  const [connectCode, setConnectCode] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState("");
  const [connectSuccess, setConnectSuccess] = useState("");
  const [showInvite, setShowInvite] = useState(false);
  const [showConnect, setShowConnect] = useState(false);

  useEffect(() => {
    async function fetchData() {
      try {
        // Phase 1: get user info first (need role for exam API)
        const usersRes = await fetch("/api/users");
        const usersData = await usersRes.json();

        const foundUser = usersData.users.find(
          (u: User) => u.id === userId
        );
        setUser(foundUser || null);

        // Phase 2: fetch data with role-aware filtering
        const role = foundUser?.role || "STUDENT";
        const [testsRes, examsRes] = await Promise.all([
          fetch(`/api/tests?userId=${userId}`),
          fetch(`/api/exam?userId=${userId}&role=${role}`),
        ]);
        const testsData = await testsRes.json();
        const examsData = await examsRes.json();

        setTests(testsData.tests);
        setExamPapers(examsData.papers);
      } catch (err) {
        console.error("Failed to fetch data:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [userId]);

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
              <span key={s.id} className="inline-flex items-center px-3 py-1 rounded-full bg-primary-50 text-primary-700 text-xs font-medium">
                {s.name}
              </span>
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
        {isParent ? (
          <Link
            href={`/exam/upload?userId=${userId}`}
            className="block w-full bg-purple-500 text-white rounded-2xl py-4 px-6 text-lg font-semibold text-center shadow-lg active:scale-[0.98] transition-transform"
          >
            Upload Exam Paper
          </Link>
        ) : null}
      </div>

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
      <div className="mt-8">
        <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">
          Exam Papers
        </h2>

        {loading ? null : examPapers.length === 0 ? (
          <div className="text-center py-8">
            <div className="text-4xl mb-3">📄</div>
            <p className="text-slate-500">No exam papers yet.</p>
            <p className="text-slate-400 text-sm">
              {isParent
                ? "Upload a PDF exam paper to get started!"
                : "No exam papers have been assigned to you yet."}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {examPapers.map((paper) => (
              <ExamPaperCard
                key={paper.id}
                paper={paper}
                userId={userId}
                userRole={user?.role}
                onDelete={isParent ? handleDeleteExam : undefined}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
