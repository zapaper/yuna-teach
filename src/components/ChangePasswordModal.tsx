"use client";

import { useState } from "react";

// Modal for parents to change their password from the profile menu.
// Validates "new == confirm" client-side and "current is correct" via
// the /api/auth/change-password endpoint. On success: shows a brief
// confirmation, then closes itself.
//
// Triggered by ParentDashboard. Mounted via portal-style fixed
// overlay; keeps focus inside via stop-propagation on the inner box.

export default function ChangePasswordModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  if (!open) return null;

  function reset() {
    setCurrent("");
    setNext("");
    setConfirm("");
    setError(null);
    setSuccess(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next !== confirm) {
      setError("New passwords don't match");
      return;
    }
    if (next.length < 4) {
      setError("New password must be at least 4 characters");
      return;
    }
    setSubmitting(true);
    try {
      const r = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(data.error ?? "Could not change password");
        return;
      }
      setSuccess(true);
      setTimeout(() => {
        reset();
        onClose();
      }, 1200);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center px-4 bg-black/40 backdrop-blur-sm"
      onClick={() => {
        if (!submitting) {
          reset();
          onClose();
        }
      }}
    >
      <div
        className="bg-white rounded-2xl max-w-sm w-full p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between mb-3">
          <h2 className="text-lg font-extrabold text-[#001e40]">Change password</h2>
          <button
            onClick={() => {
              if (submitting) return;
              reset();
              onClose();
            }}
            className="text-[#43474f] hover:text-[#001e40] transition-colors"
            aria-label="Close"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {success ? (
          <div className="py-6 text-center">
            <span className="material-symbols-outlined text-3xl text-[#006c49]" style={{ fontVariationSettings: "'FILL' 1" }}>check_circle</span>
            <p className="text-sm font-bold text-[#006c49] mt-2">Password updated</p>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <label className="block">
              <span className="text-xs font-bold text-[#001e40] block mb-1">Current password</span>
              <input
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
                required
                className="w-full px-3 py-2 rounded-xl border border-[#c3c6d1] focus:outline-none focus:border-[#003366]"
              />
            </label>
            <label className="block">
              <span className="text-xs font-bold text-[#001e40] block mb-1">New password</span>
              <input
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
                minLength={4}
                required
                className="w-full px-3 py-2 rounded-xl border border-[#c3c6d1] focus:outline-none focus:border-[#003366]"
              />
            </label>
            <label className="block">
              <span className="text-xs font-bold text-[#001e40] block mb-1">Confirm new password</span>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                minLength={4}
                required
                className="w-full px-3 py-2 rounded-xl border border-[#c3c6d1] focus:outline-none focus:border-[#003366]"
              />
            </label>

            {error && (
              <p className="text-sm text-[#ba1a1a] bg-[#ffdad6] rounded-lg px-3 py-2">{error}</p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="mt-2 w-full py-3 rounded-xl bg-[#003366] text-white text-sm font-bold hover:bg-[#002145] disabled:opacity-50"
            >
              {submitting ? "Saving…" : "Update password"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
