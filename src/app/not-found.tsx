"use client";

// Project-wide 404. The default Next.js 404 was a dead-end on the
// iOS app — Capacitor WebViews don't expose a hardware/OS back
// button, so a child who hits a 404 (e.g. stale assignment link,
// router race after logout) had no way to recover except force-
// quitting the app. This component always offers a clear path
// out: home if signed in, login otherwise.
//
// We can't read the session cookie client-side (httpOnly), so we
// route everyone through /login — the login page redirects to
// home automatically when an existing session is detected.

import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-screen bg-[#f8f9ff] flex items-center justify-center px-6">
      <div className="bg-white rounded-3xl shadow-xl max-w-sm w-full p-8 text-center">
        <div className="w-16 h-16 rounded-2xl bg-[#dce9ff] flex items-center justify-center mx-auto mb-4">
          <span
            className="material-symbols-outlined text-[#003366] text-3xl"
            style={{ fontVariationSettings: "'FILL' 1" }}
            aria-hidden
          >
            search_off
          </span>
        </div>
        <h1 className="font-headline text-xl font-extrabold text-[#001e40] mb-2">Page not found</h1>
        <p className="text-sm text-[#43474f] leading-relaxed mb-6">
          That link looks broken or has expired. Let&apos;s get you back on track.
        </p>
        <Link
          href="/login"
          className="inline-block w-full py-3 rounded-2xl bg-[#003366] text-white font-bold text-sm hover:bg-[#002145] transition-colors"
        >
          Continue
        </Link>
      </div>
    </div>
  );
}
