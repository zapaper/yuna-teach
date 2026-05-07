"use client";

import { useState } from "react";
import Link from "next/link";

type UserShape = {
  id: string;
  displayName: string;
  email: string | null;
  role: string;
  subscriptionStatus: string | null;
  paymentSource: string | null;
  appleExpiresAtIso: string | null;
  linkedStudents: { id: string; name: string }[];
};

export default function AccountClient({ user }: { user: UserShape }) {
  const [stage, setStage] = useState<"idle" | "warn" | "confirm" | "deleting" | "deleted">("idle");
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const hasActiveApple = user.subscriptionStatus === "active" && user.paymentSource === "apple";
  const hasActiveStripe = user.subscriptionStatus === "active" && user.paymentSource !== "apple";

  async function performDelete() {
    if (confirmText !== "DELETE") {
      setError("Type DELETE in capitals to confirm.");
      return;
    }
    setStage("deleting");
    setError(null);
    try {
      const res = await fetch("/api/users/me", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, confirm: "DELETE" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Deletion failed");
        setStage("confirm");
        return;
      }
      setStage("deleted");
      // Allow the success copy a beat to render, then send to homepage.
      setTimeout(() => { window.location.href = "/"; }, 1800);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setStage("confirm");
    }
  }

  if (stage === "deleted") {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-50 px-6 text-center">
        <div>
          <span className="material-symbols-outlined text-5xl text-[#006c49] mb-3 block">check_circle</span>
          <h1 className="text-2xl font-extrabold text-[#001e40] mb-2">Account deleted</h1>
          <p className="text-sm text-[#43474f]">Redirecting…</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#f8f9ff] pb-20">
      <div className="max-w-xl mx-auto px-5 pt-10">
        <Link href={`/home/${user.id}`} className="text-sm font-bold text-[#003366] hover:underline">← Back</Link>
        <h1 className="text-3xl font-extrabold text-[#001e40] mt-4 mb-6">Account</h1>

        {/* Profile */}
        <section className="bg-white rounded-3xl p-6 mb-4 shadow-sm">
          <h2 className="text-sm font-extrabold uppercase tracking-widest text-[#737780] mb-3">Profile</h2>
          <p className="text-base text-[#001e40] font-semibold">{user.displayName}</p>
          {user.email && <p className="text-sm text-[#43474f]">{user.email}</p>}
          <p className="text-xs text-[#43474f] mt-1 uppercase tracking-wider font-bold">{user.role}</p>
        </section>

        {/* Subscription */}
        <section className="bg-white rounded-3xl p-6 mb-4 shadow-sm">
          <h2 className="text-sm font-extrabold uppercase tracking-widest text-[#737780] mb-3">Subscription</h2>
          {user.subscriptionStatus === "active" ? (
            <>
              <p className="text-base text-[#006c49] font-bold">Active</p>
              <p className="text-xs text-[#43474f] mt-1">
                Source: {user.paymentSource === "apple" ? "App Store" : "Website"}
                {user.appleExpiresAtIso ? ` · Renews ${new Date(user.appleExpiresAtIso).toLocaleDateString()}` : ""}
              </p>
              {hasActiveApple ? (
                <a
                  href="https://apps.apple.com/account/subscriptions"
                  className="inline-block mt-3 text-xs font-bold text-[#003366] hover:underline"
                >
                  Manage in App Store →
                </a>
              ) : (
                <Link
                  href={`/pricing/${user.id}`}
                  className="inline-block mt-3 text-xs font-bold text-[#003366] hover:underline"
                >
                  Manage subscription →
                </Link>
              )}
            </>
          ) : (
            <p className="text-sm text-[#43474f]">No active subscription.</p>
          )}
        </section>

        {/* Linked students (parent only) */}
        {user.role === "PARENT" && user.linkedStudents.length > 0 && (
          <section className="bg-white rounded-3xl p-6 mb-4 shadow-sm">
            <h2 className="text-sm font-extrabold uppercase tracking-widest text-[#737780] mb-3">Linked students</h2>
            <ul className="text-sm text-[#001e40]">
              {user.linkedStudents.map(s => (
                <li key={s.id} className="py-1">{s.name}</li>
              ))}
            </ul>
            <p className="text-xs text-[#43474f] mt-2">
              These accounts will be deleted when you delete yours, unless they are also linked to another parent.
            </p>
          </section>
        )}

        {/* Danger zone */}
        <section className="bg-white rounded-3xl p-6 border border-[#ffdad6]">
          <h2 className="text-sm font-extrabold uppercase tracking-widest text-[#ba1a1a] mb-3">Delete account</h2>
          <p className="text-sm text-[#43474f] mb-4 leading-relaxed">
            Permanently delete this account and all associated data — exam papers, scores,
            progress reports, and uploaded media. This cannot be undone.
          </p>

          {stage === "idle" && (
            <button
              onClick={() => setStage(hasActiveApple ? "warn" : "confirm")}
              className="px-4 py-2.5 rounded-xl bg-[#ba1a1a] text-white text-sm font-bold hover:bg-[#93000a] transition-colors"
            >
              Delete my account
            </button>
          )}

          {stage === "warn" && hasActiveApple && (
            <div className="bg-[#ffdad6]/40 rounded-2xl p-4 mb-4">
              <p className="text-sm font-bold text-[#ba1a1a] mb-2">⚠ Cancel your App Store subscription first</p>
              <p className="text-xs text-[#43474f] leading-relaxed mb-3">
                Your subscription is billed by Apple, not us. Apple will continue to charge you
                even after this account is deleted unless you cancel it manually:
              </p>
              <ol className="text-xs text-[#43474f] list-decimal pl-5 space-y-1 mb-3">
                <li>Open the Settings app on your iPhone or iPad</li>
                <li>Tap your name at the top → Subscriptions</li>
                <li>Tap MarkForYou → Cancel Subscription</li>
              </ol>
              <a
                href="https://apps.apple.com/account/subscriptions"
                className="inline-block mb-3 text-xs font-extrabold text-[#003366] hover:underline"
              >
                Open Apple Subscriptions →
              </a>
              <p className="text-xs text-[#43474f] leading-relaxed">
                Once cancelled in Apple Settings, come back here and continue. If you proceed
                without cancelling, your account is still deleted but Apple billing continues.
              </p>
              <div className="flex gap-2 mt-4">
                <button
                  onClick={() => setStage("idle")}
                  className="flex-1 py-2 rounded-xl border border-slate-200 text-[#43474f] text-sm font-bold hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  onClick={() => setStage("confirm")}
                  className="flex-1 py-2 rounded-xl bg-[#ba1a1a] text-white text-sm font-bold hover:bg-[#93000a]"
                >
                  Continue anyway
                </button>
              </div>
            </div>
          )}

          {stage === "confirm" && (
            <div className="bg-[#ffdad6]/40 rounded-2xl p-4">
              {hasActiveStripe && (
                <p className="text-xs text-[#43474f] mb-3 leading-relaxed">
                  Your website subscription will be cancelled automatically as part of deletion.
                </p>
              )}
              <p className="text-sm text-[#001e40] font-semibold mb-2">
                Type <span className="font-mono bg-white px-1.5 py-0.5 rounded">DELETE</span> to confirm.
              </p>
              <input
                type="text"
                value={confirmText}
                onChange={e => { setConfirmText(e.target.value); setError(null); }}
                placeholder="DELETE"
                className="w-full px-3 py-2 rounded-xl border-2 border-slate-200 focus:border-[#ba1a1a] outline-none font-mono text-[#001e40] mb-3"
                autoFocus
              />
              <div className="flex gap-2">
                <button
                  onClick={() => { setStage("idle"); setConfirmText(""); setError(null); }}
                  className="flex-1 py-2 rounded-xl border border-slate-200 text-[#43474f] text-sm font-bold hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  onClick={performDelete}
                  disabled={confirmText !== "DELETE"}
                  className="flex-1 py-2 rounded-xl bg-[#ba1a1a] text-white text-sm font-bold disabled:opacity-50 hover:bg-[#93000a]"
                >
                  Delete permanently
                </button>
              </div>
            </div>
          )}

          {stage === "deleting" && (
            <div className="flex items-center gap-3 text-sm text-[#43474f]">
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-slate-300 border-t-[#ba1a1a]" />
              Deleting…
            </div>
          )}

          {error && (
            <p className="text-sm text-[#ba1a1a] mt-3">{error}</p>
          )}
        </section>
      </div>
    </main>
  );
}
