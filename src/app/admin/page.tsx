"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";

export default function AdminPage() {
  return (
    <Suspense>
      <AdminContent />
    </Suspense>
  );
}

function AdminContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const userId = searchParams.get("userId") ?? "";
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`)
      .then(r => setAllowed(r.ok))
      .catch(() => setAllowed(false));
  }, [userId]);

  if (allowed === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" />
      </div>
    );
  }

  if (!allowed) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <p className="text-slate-500 text-sm">Access denied.</p>
      </div>
    );
  }

  const tiles = [
    {
      icon: "flag",
      label: "Review Flagged Q&A",
      description: "View questions flagged by students, reply or clear flags.",
      href: `/flagged?userId=${userId}`,
      color: "bg-red-50 text-red-600",
    },
    {
      icon: "upload_file",
      label: "Upload Exam Papers",
      description: "Upload a PDF exam paper and extract questions via AI.",
      href: `/exam/upload?userId=${userId}`,
      color: "bg-blue-50 text-blue-600",
    },
    {
      icon: "feedback",
      label: "User Feedback",
      description: "Read feedback submitted by parents and students.",
      href: `/admin/feedback?userId=${userId}`,
      color: "bg-amber-50 text-amber-600",
    },
  ];

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3">
        <button onClick={() => router.push(`/home/${userId}`)} className="p-1.5 rounded-lg hover:bg-slate-100">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <div>
          <h1 className="text-lg font-bold text-slate-800">Admin Panel</h1>
          <p className="text-xs text-slate-400">MarkForYou management tools</p>
        </div>
      </div>

      {/* Tiles */}
      <div className="max-w-xl mx-auto px-4 py-6 space-y-3">
        {tiles.map(tile => (
          <Link
            key={tile.href}
            href={tile.href}
            className="flex items-center gap-4 bg-white rounded-2xl border border-slate-100 shadow-sm px-5 py-4 hover:border-slate-300 transition-colors"
          >
            <div className={`w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 ${tile.color}`}>
              <span className="material-symbols-outlined text-[24px]">{tile.icon}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-slate-800 text-sm">{tile.label}</p>
              <p className="text-xs text-slate-400 mt-0.5">{tile.description}</p>
            </div>
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className="text-slate-300 flex-shrink-0">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </Link>
        ))}
      </div>
    </div>
  );
}
