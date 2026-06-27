"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import AdminNav from "@/components/AdminNav";

interface FeedbackItem {
  id: string;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  message: string;
  createdAt: string;
  adminReply: string | null;
  adminRepliedAt: string | null;
  adminReplyRead: boolean;
}

export default function AdminFeedbackPage() {
  return (
    <Suspense>
      <AdminFeedbackContent />
    </Suspense>
  );
}

function AdminFeedbackContent() {
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
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-slate-200 border-t-slate-500" />
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
      <AdminNav userId={userId} />
      <div className="lg:ml-56 pb-24 lg:pb-0">
        <div className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3">
          <div>
            <h1 className="text-lg font-bold text-slate-800">User Feedback</h1>
            <p className="text-xs text-slate-400">
              {items.length} submission{items.length !== 1 ? "s" : ""}
              {" · "}
              {items.filter(i => !i.adminReply).length} awaiting reply
            </p>
          </div>
        </div>
        {items.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-slate-400">No feedback submitted yet.</p>
          </div>
        ) : (
          <div className="px-4 py-4 space-y-3 max-w-2xl mx-auto">
            {items.map((item) => (
              <FeedbackCard
                key={item.id}
                item={item}
                onReplySent={(reply, repliedAt) =>
                  setItems(curr => curr.map(it => it.id === item.id ? { ...it, adminReply: reply, adminRepliedAt: repliedAt, adminReplyRead: false } : it))
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FeedbackCard({ item, onReplySent }: { item: FeedbackItem; onReplySent: (reply: string, repliedAt: string) => void }) {
  const [reply, setReply] = useState(item.adminReply ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isEdit = !!item.adminReply;
  const trimmed = reply.trim();
  const canSubmit = trimmed.length > 0 && trimmed !== (item.adminReply ?? "").trim() && !submitting;

  async function send() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/feedback/${item.id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      onReplySent(trimmed, new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Send failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-slate-100 shadow-sm px-4 py-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-slate-800">{item.userName ?? "Anonymous"}</span>
        <span className="text-[11px] text-slate-400">
          {new Date(item.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
      {item.userEmail && <p className="text-xs text-slate-400">{item.userEmail}</p>}
      <p className="text-sm text-slate-700 whitespace-pre-wrap">{item.message}</p>

      <div className="pt-2 border-t border-slate-100 space-y-1.5">
        {item.adminReply && (
          <p className="text-[11px] text-slate-400">
            {item.adminReplyRead ? "Replied" : "Replied (unread)"}
            {item.adminRepliedAt && " · "}
            {item.adminRepliedAt && new Date(item.adminRepliedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
          </p>
        )}
        <textarea
          value={reply}
          onChange={e => setReply(e.target.value)}
          rows={3}
          disabled={!item.userId}
          placeholder={item.userId ? "Type your reply…" : "Anonymous submission — no user to reply to"}
          className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:border-slate-400 disabled:bg-slate-50 disabled:text-slate-400"
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-rose-500">{error}</span>
          <button
            onClick={send}
            disabled={!canSubmit || !item.userId}
            className="text-xs px-3 py-1.5 rounded-lg bg-slate-800 text-white font-semibold disabled:bg-slate-200 disabled:text-slate-400"
          >
            {submitting ? "Sending…" : isEdit ? "Update reply" : "Send reply"}
          </button>
        </div>
      </div>
    </div>
  );
}
