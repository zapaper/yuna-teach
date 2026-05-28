"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

// Landing page for the password-reset link emailed by
// /api/auth/forgot-password. Reads the token from ?token=…, asks the
// user for a new password, submits to /api/auth/reset-password.
// On success, redirects to /login with a success banner flag.

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-50" />}>
      <ResetPasswordContent />
    </Suspense>
  );
}

function ResetPasswordContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!token) { setError("This page needs a reset token. Use the link from your email."); return; }
    if (!newPassword) { setError("Please enter a new password."); return; }
    if (newPassword.length < 4) { setError("Password must be at least 4 characters."); return; }
    if (newPassword !== confirmPassword) { setError("Passwords don't match."); return; }
    setLoading(true);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Couldn't reset your password. Please try again.");
        return;
      }
      // Success — send to login with the identity (email preferred,
      // username fallback) so the login page pre-fills the field for
      // the account we JUST reset, overriding any leftover state from
      // a /home/<other-user> pre-fill earlier in this session.
      const identity = typeof data.identity === "string" ? data.identity : "";
      const idQs = identity ? `&identity=${encodeURIComponent(identity)}` : "";
      router.push(`/login?reset=ok${idQs}`);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-surface font-body text-on-surface min-h-screen flex flex-col items-center justify-center p-6 lg:p-12 relative overflow-hidden">
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-surface-container-high rounded-full blur-[120px] opacity-60 pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-secondary-container rounded-full blur-[120px] opacity-30 pointer-events-none" />

      <main className="w-full max-w-[480px] z-10">
        <div className="flex flex-col items-center mb-10">
          <Link href="/" className="w-20 h-20 mb-6 bg-surface-container-lowest rounded-xl flex items-center justify-center" style={{ boxShadow: "0 20px 40px rgba(11,28,48,0.06)" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt="MarkForYou Owl Logo" className="w-14 h-14 object-contain" src="/logo_t.png" />
          </Link>
          <h1 className="font-headline font-extrabold text-3xl tracking-tight text-primary mb-2">Reset your password</h1>
          <p className="text-sm text-on-surface-variant font-medium text-center max-w-sm">
            Choose a new password for your MarkForYou account.
          </p>
        </div>

        <div className="bg-surface-container-lowest rounded-[2rem] p-8 md:p-12 border border-white/40" style={{ boxShadow: "0 20px 40px rgba(11,28,48,0.06)" }}>
          {!token ? (
            <div className="text-center space-y-4">
              <p className="text-sm text-error font-medium">This page needs a reset token from the email link.</p>
              <Link href="/login" className="inline-block py-3 px-6 bg-primary text-on-primary font-bold text-sm rounded-xl hover:scale-[1.02] transition-transform">
                Back to login
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="space-y-2">
                <label className="block font-headline font-bold text-sm text-primary ml-1" htmlFor="new-password">
                  New Password
                </label>
                <div className="relative group">
                  <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-outline-variant group-focus-within:text-primary transition-colors">lock</span>
                  <input
                    id="new-password"
                    type={showPw ? "text" : "password"}
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    placeholder="At least 4 characters"
                    autoFocus
                    className="w-full pl-12 pr-12 py-4 bg-surface-container-low border-none rounded-xl focus:ring-2 focus:ring-primary-container text-on-surface placeholder:text-outline transition-all outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPw(v => !v)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-outline-variant hover:text-primary"
                  >
                    <span className="material-symbols-outlined">{showPw ? "visibility_off" : "visibility"}</span>
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <label className="block font-headline font-bold text-sm text-primary ml-1" htmlFor="confirm-password">
                  Confirm Password
                </label>
                <div className="relative group">
                  <span className="material-symbols-outlined absolute left-4 top-1/2 -translate-y-1/2 text-outline-variant group-focus-within:text-primary transition-colors">lock</span>
                  <input
                    id="confirm-password"
                    type={showPw ? "text" : "password"}
                    value={confirmPassword}
                    onChange={e => setConfirmPassword(e.target.value)}
                    placeholder="Type it again"
                    className="w-full pl-12 pr-4 py-4 bg-surface-container-low border-none rounded-xl focus:ring-2 focus:ring-primary-container text-on-surface placeholder:text-outline transition-all outline-none"
                  />
                </div>
              </div>

              {error && <p className="text-sm text-error font-medium">{error}</p>}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-4 bg-gradient-to-r from-primary to-primary-container text-on-primary font-headline font-bold text-lg rounded-xl hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center justify-center gap-2 mt-2 disabled:opacity-60"
                style={{ boxShadow: "0 20px 40px rgba(11,28,48,0.06)" }}
              >
                {loading ? "Updating…" : "Set new password"}
                {!loading && <span className="material-symbols-outlined">arrow_forward</span>}
              </button>

              <p className="text-xs text-center text-outline-variant">
                <Link href="/login" className="font-semibold hover:text-primary">Back to login</Link>
              </p>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
