"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

interface FeedbackItem {
  id: string;
  userName: string | null;
  userEmail: string | null;
  message: string;
  createdAt: string;
}

export default function AdminFeedbackPage() {
  return (
    <Suspense>
      <AdminFeedbackContent />
    </Suspense>
  );
}

function AdminFeedbackContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userId = searchParams.get("userId") ?? "";

  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    if (!userId) { setForbidden(true); setLoading(false); return; }
    fetch(`/api/feedback?userId=${userId}`)
      .then(async (r) => {
        if (r.status === 403 || r.status === 401) { setForbidden(true); return; }
        setItems(await r.json());
      })
      .finally(() => setLoading(false));
  }, [userId]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-primary-200 border-t-primary-500" />
      </div>
    );
  }

  if (forbidden) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <p className="text-slate-500">Access denied.</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3">
        <button onClick={() => router.back()} className="p-1.5 rounded-lg hover:bg-slate-100">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <div>
          <h1 className="text-lg font-bold text-slate-800">User Feedback</h1>
          <p className="text-xs text-slate-400">{items.length} submission{items.length !== 1 ? "s" : ""}</p>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-slate-400">No feedback submitted yet.</p>
        </div>
      ) : (
        <div className="px-4 py-4 space-y-3 max-w-2xl mx-auto">
          {items.map((item) => (
            <div key={item.id} className="bg-white rounded-xl border border-slate-100 shadow-sm px-4 py-3 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-slate-800">
                  {item.userName ?? "Anonymous"}
                </span>
                <span className="text-[11px] text-slate-400">
                  {new Date(item.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
              {item.userEmail && (
                <p className="text-xs text-slate-400">{item.userEmail}</p>
              )}
              <p className="text-sm text-slate-700 whitespace-pre-wrap">{item.message}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
