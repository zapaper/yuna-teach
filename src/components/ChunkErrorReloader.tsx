"use client";

import { useEffect } from "react";

// Auto-reload-once when the browser hits an error that almost
// certainly comes from a stale bundle rather than a real bug.
// Catches two patterns:
//
//   A) Classic ChunkLoadError — message matches `ChunkLoadError`,
//      `Loading chunk`, `Loading CSS chunk`, or "Failed to fetch
//      dynamically imported module". The new build's chunk
//      manifest is different and the old client tries to load
//      chunks that no longer exist.
//
//   B) Resume-after-suspension runtime crash — the tab/app was
//      backgrounded across a Railway redeploy, woke up, fetched
//      data, and the response shape from the new server doesn't
//      match what the old client expects → `Cannot read
//      properties of undefined …`, `… is not a function`, etc.
//      The give-away is that it crashes within ~30s of the page
//      coming back to "visible". Initial-load crashes (real bugs)
//      don't have a recent resume, so they fall through to the
//      normal error UI — no infinite reload loop.
//
// The iOS WebView is where this matters most: no pull-to-refresh,
// no hard-reload gesture, and the WebView often stays alive across
// long backgrounding intervals while Railway redeploys.
//
// Safety net: sessionStorage flag means we only auto-reload once
// per tab session. If the new build is genuinely broken, the
// second crash falls through normally so the user/devs can see it.

const RELOAD_FLAG = "mfy_chunk_reloaded";
// How long after a visibility=>visible / pageshow we still treat
// uncaught errors as "probably a stale bundle that woke up". Tuned
// long enough to cover the typical fetch + render cycle after
// resume but short enough that errors in normal use don't qualify.
const RESUME_WINDOW_MS = 30_000;

let resumedAt = 0;

function looksLikeChunkError(message: unknown): boolean {
  if (typeof message !== "string") {
    if (message && typeof (message as { message?: unknown }).message === "string") {
      return looksLikeChunkError((message as { message: string }).message);
    }
    return false;
  }
  return /ChunkLoadError|Loading chunk|Loading CSS chunk|Failed to fetch dynamically imported module/i.test(message);
}

// Heuristic: runtime errors that almost always mean "old code, new
// data". `Cannot read properties of undefined` covers .some / .map
// / .filter calls on a field the server stopped returning. `is not
// a function` covers a renamed import. Narrow on purpose — generic
// 'TypeError' alone would over-match. Only used when the page
// recently resumed; on normal use these are real bugs.
function looksLikeStaleBundleRuntime(message: unknown): boolean {
  if (typeof message !== "string") {
    if (message && typeof (message as { message?: unknown }).message === "string") {
      return looksLikeStaleBundleRuntime((message as { message: string }).message);
    }
    return false;
  }
  return (
    /Cannot read propert(?:y|ies) of (?:undefined|null)/i.test(message) ||
    /is not a function/i.test(message) ||
    /Unexpected token .* in JSON/i.test(message)
  );
}

function reloadOnce() {
  try {
    if (sessionStorage.getItem(RELOAD_FLAG)) return;
    sessionStorage.setItem(RELOAD_FLAG, "1");
  } catch { /* sessionStorage can throw in private-mode WebView */ }
  // Hard reload bypasses the HTTP cache for the entry HTML so the
  // browser picks up the new chunk manifest.
  window.location.reload();
}

function inResumeWindow() {
  return resumedAt > 0 && performance.now() - resumedAt < RESUME_WINDOW_MS;
}

function maybeReload(message: unknown) {
  if (looksLikeChunkError(message)) {
    reloadOnce();
    return;
  }
  if (inResumeWindow() && looksLikeStaleBundleRuntime(message)) {
    reloadOnce();
  }
}

export default function ChunkErrorReloader() {
  useEffect(() => {
    const onError = (e: ErrorEvent) => maybeReload(e.error ?? e.message);
    const onRejection = (e: PromiseRejectionEvent) => maybeReload(e.reason);
    // Mark resume points. We listen to both visibilitychange and
    // pageshow because iOS Safari/WKWebView fire pageshow on
    // bfcache restore but sometimes don't re-fire visibilitychange
    // in the same path.
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        resumedAt = performance.now();
      }
    };
    const onPageShow = () => { resumedAt = performance.now(); };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);
  return null;
}
