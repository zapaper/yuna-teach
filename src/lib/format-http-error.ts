// Build a clean one-line message from an HTTP response body. Used by
// the various "Re-mark failed (HTTP …)" alerts so a 502 from Railway
// during a redeploy doesn't surface the full Cloudflare/IIS HTML
// error page in an alert dialog. Returns just the operator-friendly
// remediation hint for known status codes, the JSON `error` field
// when the server returned structured JSON, or a clipped slice of
// the body otherwise.
export function formatHttpError(status: number, body: string): string {
  const trimmed = (body ?? "").trim();
  // Gateway / unavailability shapes during a Railway redeploy. The
  // response is HTML (starts with <, sometimes after a BOM or
  // whitespace); the dialog only needs to say "try again".
  if (status >= 502 && status <= 504) {
    return "Server is temporarily unavailable (likely a redeploy or worker restart). Please try again in a moment.";
  }
  // Try to pull a JSON {error: "..."} field out of the body before
  // falling back to a clipped raw string.
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown; detail?: unknown };
      if (typeof parsed.error === "string") return parsed.error.slice(0, 200);
      if (typeof parsed.detail === "string") return parsed.detail.slice(0, 200);
    } catch { /* ignore malformed JSON */ }
  }
  // Any HTML response other than the 5xx case above — strip the
  // markup wrapping and surface a generic message rather than the
  // raw <!DOCTYPE…>. We don't know the upstream's exact failure mode
  // here; just say it failed and let the operator inspect logs.
  if (trimmed.startsWith("<") || /^<!doctype/i.test(trimmed)) {
    return "Upstream returned an HTML error page. Check server logs.";
  }
  return trimmed ? trimmed.slice(0, 200) : "no body";
}
