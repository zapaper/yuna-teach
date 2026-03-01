"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  const [user, setUser] = useState<User | null>(null);
  const [students, setStudents] = useState<User[]>([]);
  const [tests, setTests] = useState<SpellingTestSummary[]>([]);
  const [examPapers, setExamPapers] = useState<ExamPaperSummary[]>([]);
  const [loading, setLoading] = useState(true);

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
        setStudents(
          usersData.users.filter((u: User) => u.role === "STUDENT")
        );

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

  async function handleAssignExam(
    paperId: string,
    studentId: string | null
  ) {
    try {
      const res = await fetch(`/api/exam/${paperId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignedToId: studentId }),
      });
      if (!res.ok) throw new Error("Failed to assign");

      const assignedStudent = studentId
        ? students.find((s) => s.id === studentId)
        : null;
      setExamPapers((prev) =>
        prev.map((p) =>
          p.id === paperId
            ? {
                ...p,
                assignedToId: studentId,
                assignedToName: assignedStudent?.name ?? null,
              }
            : p
        )
      );
    } catch (err) {
      console.error("Failed to assign exam:", err);
    }
  }

  const isParent = user?.role === "PARENT";

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
          {user?.name ? `${user.name}'s Tests` : "Spelling Tests"}
        </h1>
        {user?.role === "STUDENT" && user.level && (
          <p className="text-slate-500 text-sm mt-1">Primary {user.level}</p>
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
        {isParent && (
          <Link
            href={`/exam/upload?userId=${userId}`}
            className="block w-full bg-purple-500 text-white rounded-2xl py-4 px-6 text-lg font-semibold text-center shadow-lg active:scale-[0.98] transition-transform"
          >
            Upload Exam Paper
          </Link>
        )}
      </div>

      {/* Test list */}
      <div>
        <h2 className="text-sm font-semibold text-slate-400 uppercase tracking-wider mb-3">
          Recent Tests
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
                students={isParent ? students : undefined}
                onAssign={isParent ? handleAssignExam : undefined}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
