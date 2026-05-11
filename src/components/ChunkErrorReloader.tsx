"use client";

import { useEffect } from "react";

// Auto-reload-once if the browser hits a ChunkLoadError. Happens
// almost exclusively when the server has redeployed since the tab
// last loaded — the old client bundle tries to lazy-fetch a JS
// chunk that no longer exists on the new build, React's error
// boundary trips, and the user sees a blank "Application error: a
// client-side exception …" page. Worst on the iOS WebView where
// the user has no obvious way to hard-refresh.
//
// We listen for the two ways the failure surfaces:
//   1. `window.onerror` — synchronous script load failures bubble
//      here. The error message contains "ChunkLoadError" or
//      "Loading chunk" / "Loading CSS chunk".
//   2. `unhandledrejection` — Next's lazy import returns a promise;
//      a chunk fetch failure rejects with the same error.
//
// To avoid reload loops if the new build is actually broken, we
// stash a flag in sessionStorage so reload only fires once per
// tab session.

const FLAG = "mfy_chunk_reloaded";

function looksLikeChunkError(message: unknown): boolean {
  if (typeof message !== "string") {
    if (message && typeof (message as { message?: unknown }).message === "string") {
      return looksLikeChunkError((message as { message: string }).message);
    }
    return false;
  }
  return /ChunkLoadError|Loading chunk|Loading CSS chunk|Failed to fetch dynamically imported module/i.test(message);
}

function reloadOnce() {
  try {
    if (sessionStorage.getItem(FLAG)) return;
    sessionStorage.setItem(FLAG, "1");
  } catch { /* sessionStorage can throw in private-mode WebView */ }
  // Hard reload bypasses the HTTP cache for the entry HTML so the
  // browser picks up the new chunk manifest.
  window.location.reload();
}

export default function ChunkErrorReloader() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      if (looksLikeChunkError(e.message) || looksLikeChunkError(e.error)) {
        reloadOnce();
      }
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      if (looksLikeChunkError(e.reason)) reloadOnce();
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
