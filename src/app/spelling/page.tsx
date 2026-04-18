"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { SpellingTestSummary, User } from "@/types";

export default function SpellingPage() {
  return (
    <Suspense>
      <SpellingPageContent />
    </Suspense>
  );
}

function SpellingPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId");

  const [user, setUser] = useState<User | null>(null);
  const [tests, setTests] = useState<SpellingTestSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) return;

    async function fetchData() {
      try {
        // Fetch user info and tests in parallel
        const [usersRes, testsRes] = await Promise.all([
          fetch("/api/users"),
          fetch(`/api/tests?userId=${userId}`),
        ]);

        const [usersData, testsData] = await Promise.all([
          usersRes.json(),
          testsRes.json(),
        ]);

        const foundUser = usersData.users.find(
          (u: User) => u.id === userId
        );
        setUser(foundUser || null);

        let allTests: SpellingTestSummary[] = testsData.tests || [];

        // If parent, also fetch tests for all linked students
        if (foundUser?.role === "PARENT" && foundUser.linkedStudents?.length > 0) {
          const studentFetches = foundUser.linkedStudents.map(
            (s: { id: string }) => fetch(`/api/tests?userId=${s.id}`).then((r) => r.json())
          );
          const studentResults = await Promise.all(studentFetches);

          for (const result of studentResults) {
            if (result.tests) {
              allTests = [...allTests, ...result.tests];
            }
          }

          // Deduplicate by test ID
          const seen = new Set<string>();
          allTests = allTests.filter((t) => {
            if (seen.has(t.id)) return false;
            seen.add(t.id);
            return true;
          });

          // Sort by createdAt descending
          allTests.sort(
            (a, b) =>
              new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
        }

        setTests(allTests);
      } catch (err) {
        console.error("Failed to fetch spelling data:", err);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [userId]);

  if (!userId) {
    return (
      <div className="min-h-screen bg-[#f8f9ff] flex items-center justify-center">
        <p className="text-slate-500">No user specified.</p>
      </div>
    );
  }

  const languageLabel = (lang: string) =>
    lang === "CHINESE" ? "中文" : lang === "JAPANESE" ? "日本語" : "English";

  const languageColor = (lang: string) =>
    lang === "CHINESE"
      ? "bg-amber-100 text-amber-700"
      : lang === "JAPANESE"
      ? "bg-pink-100 text-pink-700"
      : "bg-blue-100 text-blue-700";

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  };

  return (
    <div className="min-h-screen bg-[#f8f9ff] font-body text-[#0b1c30] antialiased">
      {/* Sticky top bar */}
      <div className="sticky top-0 z-10 bg-[#eff4ff] px-4 py-3 flex items-center gap-3 border-b border-[#d3e4fe]">
        <button
          onClick={() => router.push(`/home/${userId}`)}
          className="p-2 -ml-2 rounded-full hover:bg-[#d3e4fe] transition-colors"
        >
          <span className="material-symbols-outlined text-[#001e40]">
            arrow_back
          </span>
        </button>
        <span className="font-headline font-bold text-[#001e40] text-lg">
          Spelling Lists
        </span>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-6 pb-32">
        {/* Scan New button */}
        <button
          onClick={() => router.push(`/scan?userId=${userId}`)}
          className="w-full flex items-center justify-center gap-2 bg-[#006c49] text-white font-bold py-3.5 px-6 rounded-xl shadow-md hover:bg-[#005a3d] active:scale-[0.98] transition-all mb-6"
        >
          <span className="material-symbols-outlined text-xl">
            document_scanner
          </span>
          Scan New List
        </button>

        {/* Loading state */}
        {loading && (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <div className="animate-spin rounded-full h-10 w-10 border-4 border-[#003366]/20 border-t-[#003366]" />
            <p className="text-sm text-[#43474f]">Loading spelling lists...</p>
          </div>
        )}

        {/* Empty state */}
        {!loading && tests.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
            <span className="material-symbols-outlined text-6xl text-slate-300">
              spellcheck
            </span>
            <p className="text-lg font-semibold text-slate-400">
              No spelling lists yet
            </p>
            <p className="text-sm text-slate-400 max-w-xs">
              Tap &quot;Scan New List&quot; above to create your first spelling
              list from a photo.
            </p>
          </div>
        )}

        {/* Test cards */}
        {!loading && tests.length > 0 && (
          <div className="flex flex-col gap-3">
            {tests.map((test) => (
              <Link
                key={test.id}
                href={`/test/${test.id}?userId=${userId}`}
                className="block bg-white rounded-2xl shadow-sm border border-slate-100 p-4 transition-all active:scale-[0.98] hover:border-[#a7c8ff] hover:shadow-md"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-lg text-slate-800 truncate font-chinese">
                      {test.title}
                    </h3>
                    {test.subtitle && (
                      <p className="text-sm text-slate-500 mt-0.5 font-chinese truncate">
                        {test.subtitle}
                      </p>
                    )}
                    <div className="flex items-center gap-2 mt-2">
                      <span
                        className={`text-xs font-medium px-2 py-0.5 rounded-full ${languageColor(test.language)}`}
                      >
                        {languageLabel(test.language)}
                      </span>
                      <span className="text-xs text-slate-400">
                        {test.wordCount} words
                      </span>
                      <span className="text-xs text-slate-300">&middot;</span>
                      <span className="text-xs text-slate-400">
                        {formatDate(test.createdAt)}
                      </span>
                    </div>
                  </div>
                  <span className="material-symbols-outlined text-slate-300 ml-2 mt-1">
                    chevron_right
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
