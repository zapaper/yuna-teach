"use client";

import { useEffect, useState } from "react";

// Full-screen "you're offline" overlay with a Retry button. Used
// to break out of the blank-page state the iOS app shipped in
// without a network connection — WKWebView just renders an empty
// document if its initial load fails, and the user had no way to
// recover except force-quitting the app.
//
// Drives off `navigator.onLine` + the `online` / `offline` events
// (both web and WKWebView fire these). We also re-check on
// `visibilitychange` because iOS sometimes drops the offline event
// when the app was backgrounded during the disconnect — coming
// back to foreground re-confirms current state.
//
// Retry behaviour: full reload via location.reload(). Cheaper
// alternatives (re-fetching specific endpoints) would still leave
// the page in whatever broken state it was in when the network
// dropped, which is the worse user experience.

export default function OfflineOverlay() {
  // Hydration safety: server renders `true` (assume online) and we
  // flip after mount if needed. Without this the SSR HTML and the
  // first client render disagreed for users who launched the tab
  // while offline.
  const [online, setOnline] = useState(true);

  useEffect(() => {
    function update() {
      setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
    }
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  if (online) return null;

  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      aria-label="No internet connection"
      className="fixed inset-0 z-[10000] bg-[#001e40]/95 flex items-center justify-center p-6"
    >
      <div className="bg-white rounded-3xl shadow-2xl max-w-sm w-full p-8 text-center">
        <div className="w-16 h-16 rounded-2xl bg-[#ffdad6] flex items-center justify-center mx-auto mb-4">
          <span
            className="material-symbols-outlined text-[#ba1a1a] text-3xl"
            style={{ fontVariationSettings: "'FILL' 1" }}
            aria-hidden
          >
            wifi_off
          </span>
        </div>
        <h1 className="font-headline text-xl font-extrabold text-[#001e40] mb-2">No internet connection</h1>
        <p className="text-sm text-[#43474f] leading-relaxed mb-6">
          MarkForYou needs a connection to mark papers and load your dashboard.
          Reconnect and tap Retry.
        </p>
        <button
          type="button"
          onClick={() => location.reload()}
          className="inline-flex items-center justify-center gap-2 w-full py-3 rounded-2xl bg-[#003366] text-white font-bold text-sm hover:bg-[#002145] transition-colors"
        >
          <span className="material-symbols-outlined text-base">refresh</span>
          Retry
        </button>
      </div>
    </div>
  );
}
