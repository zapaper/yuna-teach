"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import TestCard from "@/components/TestCard";
import { SpellingTestSummary, User } from "@/types";

export default function HomePage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = use(params);
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [tests, setTests] = useState<SpellingTestSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [usersRes, testsRes] = await Promise.all([
          fetch("/api/users"),
          fetch(`/api/tests?userId=${userId}`),
        ]);
        const usersData = await usersRes.json();
        const testsData = await testsRes.json();

        const foundUser = usersData.users.find(
          (u: User) => u.id === userId
        );
        setUser(foundUser || null);
        setTests(testsData.tests);
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

      {/* Scan button */}
      <Link
        href={`/scan?userId=${userId}`}
        className="block w-full bg-accent-orange text-white rounded-2xl py-4 px-6 text-lg font-semibold text-center shadow-lg active:scale-[0.98] transition-transform mb-8"
      >
        Scan New Test
      </Link>

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
    </div>
  );
}
