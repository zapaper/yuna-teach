// Tiny client-side fetch wrapper that catches the failure modes we
// see in real life — Cloudflare 502 / 503 / 504 during a Railway
// redeploy, an HTML error page when the origin is down, JSON parse
// errors when the response body isn't actually JSON.
//
// Goal: every UI fetch can do `const { data, error } = await
// fetchJsonSafe(...)` without sprinkling try/catch + .text()/.json()
// boilerplate, and the message in `error` is always something
// short and user-readable (no <html> blob in a toast).

export type FetchResult<T> =
  | { ok: true;  data: T; status: number; }
  | { ok: false; data: null; status: number; error: string; transient: boolean };

const TRANSIENT_STATUSES = new Set([502, 503, 504]);

function shortMessage(text: string, status: number): string {
  if (TRANSIENT_STATUSES.has(status)) {
    return `Server is restarting (HTTP ${status}). Try again in a moment.`;
  }
  // Stripped Cloudflare / Railway HTML error pages are noisy and
  // useless in a toast. Detect by sniff and replace with a clean
  // message. We still log the raw text to the console for debug.
  const looksLikeHtml = /^\s*<!doctype\b|<html\b/i.test(text);
  if (looksLikeHtml) {
    console.warn("[fetchJsonSafe] origin returned HTML:", text.slice(0, 200));
    return `Server returned an error page (HTTP ${status}).`;
  }
  // Plain-text error from our own routes — usually 1 line. Cap it
  // so a stack trace can't blow out the toast.
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 240 ? trimmed.slice(0, 240) + "…" : (trimmed || `Request failed (HTTP ${status}).`);
}

export async function fetchJsonSafe<T = unknown>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<FetchResult<T>> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (err) {
    // Network failure — DNS, offline, CORS, AbortError, etc.
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, data: null, status: 0, error: `Network error: ${msg}`, transient: true };
  }

  if (res.ok) {
    // 2xx — try to parse JSON. If parsing fails, treat as error so
    // the caller doesn't operate on garbage data.
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      return { ok: true, data: undefined as unknown as T, status: res.status };
    }
    try {
      const data = await res.json() as T;
      return { ok: true, data, status: res.status };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, data: null, status: res.status, error: `Bad JSON response: ${msg}`, transient: false };
    }
  }

  // Non-2xx — pull body as text for the toast.
  let bodyText = "";
  try { bodyText = await res.text(); } catch { /* ignore */ }
  return {
    ok: false,
    data: null,
    status: res.status,
    error: shortMessage(bodyText, res.status),
    transient: TRANSIENT_STATUSES.has(res.status) || res.status === 0,
  };
}
