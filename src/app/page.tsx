"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import TestCard from "@/components/TestCard";
import { SpellingTestSummary } from "@/types";

export default function HomePage() {
  const [tests, setTests] = useState<SpellingTestSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchTests();
  }, []);

  async function fetchTests() {
    try {
      const res = await fetch("/api/tests");
      const data = await res.json();
      setTests(data.tests);
    } catch (err) {
      console.error("Failed to fetch tests:", err);
    } finally {
      setLoading(false);
    }
  }

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
      <div className="text-center mb-8">
        <h1 className="text-2xl font-bold text-slate-800">
          Yuna&apos;s Spelling Tests
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          Scan, practice, and ace your tests!
        </p>
      </div>

      {/* Scan button */}
      <Link
        href="/scan"
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
              <TestCard key={test.id} test={test} onDelete={handleDelete} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
