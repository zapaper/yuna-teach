"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// Pop-up that fires when a trialing user has 1 day or less remaining,
// and once when the trial has just expired. Dismissible per session
// (sessionStorage); reappears on next browser session.
//
// Mounted high up in the dashboards (Parent + Student) so any logged-in
// user sees it on the home screen. Doesn't gate access — gating
// happens server-side in canAssign() on the relevant POST routes.
//
// Inputs come from the User shape returned by /api/users?userId=X.

type TrialReminderProps = {
  userId: string;
  subscriptionStatus: string | null | undefined;
  trialEndsAtIso: string | null | undefined;
};

export default function TrialReminder({
  userId,
  subscriptionStatus,
  trialEndsAtIso,
}: TrialReminderProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [variant, setVariant] = useState<"last-day" | "expired" | null>(null);

  useEffect(() => {
    // Subscribed users — never show.
    if (subscriptionStatus === "active") return;
    if (!trialEndsAtIso) return;

    const trialEndsAt = new Date(trialEndsAtIso).getTime();
    const now = Date.now();
    const msLeft = trialEndsAt - now;
    const dayMs = 24 * 60 * 60 * 1000;

    let v: "last-day" | "expired" | null = null;
    if (msLeft <= 0) v = "expired";
    else if (msLeft <= dayMs) v = "last-day";
    if (!v) return;

    // Dismissed for this session? (`expired` always shows, since the
    // user is locked out of creating new things until they pay or
    // explicitly close the modal each visit.)
    const key = `trialReminder:${userId}:${v}`;
    if (v === "last-day" && sessionStorage.getItem(key) === "dismissed") return;

    setVariant(v);
    setOpen(true);
  }, [userId, subscriptionStatus, trialEndsAtIso]);

  function dismiss() {
    if (variant) sessionStorage.setItem(`trialReminder:${userId}:${variant}`, "dismissed");
    setOpen(false);
  }

  if (!open || !variant) return null;

  const title = variant === "expired" ? "Your free trial has ended" : "Your free trial ends tomorrow";
  const body =
    variant === "expired"
      ? "You can still view past quizzes and progress reports. To assign new quizzes, papers, or daily practice, please subscribe."
      : "Subscribe today to keep assigning quizzes, papers, and daily practice without interruption.";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center px-4 bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-xl">
        <div className="flex items-start gap-3 mb-3">
          <span
            className="material-symbols-outlined text-2xl"
            style={{ color: variant === "expired" ? "#ba1a1a" : "#a06900" }}
            aria-hidden
          >
            {variant === "expired" ? "lock" : "schedule"}
          </span>
          <h2 className="text-lg font-extrabold text-[#001e40] flex-1">{title}</h2>
        </div>
        <p className="text-sm text-[#43474f] mb-5 leading-relaxed">{body}</p>
        <div className="flex gap-2">
          <button
            onClick={dismiss}
            className="flex-1 py-3 rounded-xl border border-[#c3c6d1] text-[#001e40] text-sm font-bold hover:bg-[#f5f5f9]"
          >
            {variant === "expired" ? "Not now" : "Later"}
          </button>
          <button
            onClick={() => {
              dismiss();
              router.push(`/pricing/${userId}`);
            }}
            className="flex-1 py-3 rounded-xl bg-[#003366] text-white text-sm font-bold hover:bg-[#002145]"
          >
            See plans
          </button>
        </div>
      </div>
    </div>
  );
}
