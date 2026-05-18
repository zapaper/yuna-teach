"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import AdminNav from "@/components/AdminNav";
import { listMasterClasses } from "@/data/master-class";

export default function Page() {
  return (
    <Suspense>
      <MasterClassList />
    </Suspense>
  );
}

function MasterClassList() {
  const userId = useSearchParams().get("userId") ?? "";
  const router = useRouter();
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    if (!userId) { setAllowed(false); return; }
    fetch(`/api/admin/check?userId=${userId}`).then(r => setAllowed(r.ok)).catch(() => setAllowed(false));
  }, [userId]);

  if (allowed === null) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" /></div>;
  }
  if (!allowed) {
    return <div className="min-h-screen flex items-center justify-center bg-slate-50"><p className="text-slate-500 text-sm">Access denied.</p></div>;
  }

  const classes = listMasterClasses();

  return (
    <div className="min-h-screen bg-slate-50">
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24 lg:pb-0">
        <div className="bg-white border-b border-slate-200 px-4 py-3">
          <h1 className="text-lg font-bold text-slate-800">Master Class — Workshop</h1>
          <p className="text-xs text-slate-400">Pre-built deep-dive modules on the highest-tested PSLE topics. Each module has slides, common mistakes, and 5 + 5 practice questions.</p>
        </div>

        <div className="max-w-3xl mx-auto px-4 py-6 space-y-3">
          {classes.map(mc => (
            <button
              key={mc.slug}
              onClick={() => router.push(`/admin/master-class/${mc.slug}?userId=${userId}`)}
              className="w-full text-left bg-white rounded-2xl border border-slate-100 shadow-sm px-5 py-4 hover:border-slate-300 transition-colors flex items-center gap-4"
            >
              <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 bg-emerald-50 text-emerald-700">
                <span className="material-symbols-outlined">school</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-slate-800 text-sm">{mc.title}</p>
                <p className="text-xs text-slate-400 mt-0.5">
                  {mc.subject} · {mc.level} · {mc.stats.psleSubjectPercent}% of PSLE Life-Science · {mc.stats.totalPracticePool} practice questions
                </p>
              </div>
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-slate-300 flex-shrink-0">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          ))}
          {classes.length === 0 && (
            <p className="text-xs text-slate-400">No Master Classes authored yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
