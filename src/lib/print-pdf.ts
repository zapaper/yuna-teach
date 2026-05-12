// Trigger the system print flow for a PDF URL. Strategy differs by
// platform because the iframe+print() trick only works reliably on
// desktop browsers.
//
//   Desktop browser:
//     Hidden iframe → window.print() prints every page of the PDF.
//
//   Mobile (iOS Safari, iOS WKWebView, Android Chrome):
//     The iframe approach prints only the first PDF page on
//     iOS — the inline PDF viewer in an iframe shows a single-
//     page preview and window.print() captures just that. Worse,
//     on small screens the user can't even see what's being
//     printed.
//
//     Instead: navigate the current tab/WebView to the inline PDF
//     URL. iOS's native PDF viewer renders the full document with
//     a share button that routes to AirPrint. The browser's back
//     button returns the user to the dashboard. On Android Chrome
//     the native PDF viewer offers Print via the overflow menu.
//
// The PDF endpoint must support `?inline=1` (Content-Disposition:
// inline) so the browser/WebView renders the bytes in-place
// instead of triggering a Save dialog.
//
// Both paths now fetch the PDF as a blob first so we can show a
// spinner during the (sometimes slow) server-side render — the
// printable route does MathJax → SVG → PNG for every fraction /
// square root on the page, which can take several seconds on a
// math-heavy paper or on cold-start.

function isMobile(): boolean {
  if (typeof window === "undefined") return false;
  // Touch capability is the most reliable single signal across iOS
  // Safari, iOS WKWebView, Android Chrome, and Android WebView.
  // Some hybrid laptops report touch too, but those usually have
  // a working iframe-print path anyway, so the worst case there is
  // an extra navigation — not the broken first-page-only print.
  if ("ontouchstart" in window || (navigator.maxTouchPoints ?? 0) > 0) return true;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "");
}

// ── Spinner overlay ──────────────────────────────────────────────
// Pure-DOM (no React) so it can be mounted from a lib helper without
// pulling in a portal. Singleton — repeated calls bump a refcount so
// the overlay survives chained prints. The "Preparing your print"
// label appears after a short delay so we don't flash on cached /
// fast responses.

let spinnerRefCount = 0;
let spinnerEl: HTMLDivElement | null = null;
let spinnerLabelTimer: number | null = null;
let spinnerSafetyTimer: number | null = null;
// Hardest-failure backstop — no print should ever leave a spinner
// stuck on screen longer than this. Cold-start MathJax + a math-
// heavy paper is maybe 5-10s; 30s is comfortably past that and
// short enough that a stuck UI gets noticed and recovered.
const SPINNER_SAFETY_MS = 30_000;

// On mobile we navigate away while the spinner is up, so the page
// may come back via bfcache restore (iOS does this aggressively) —
// at which point the spinner element is still in the DOM but the
// JS state is frozen from before the navigation. `pageshow` with
// `persisted=true` is the signal to clean it up.
function attachBfcacheCleanup() {
  if (typeof window === "undefined") return;
  if ((window as Window & { __mfyPrintBfcacheBound?: boolean }).__mfyPrintBfcacheBound) return;
  (window as Window & { __mfyPrintBfcacheBound?: boolean }).__mfyPrintBfcacheBound = true;
  window.addEventListener("pageshow", (ev) => {
    if (ev.persisted) {
      // Force-clear regardless of refcount — the previous run's
      // bookkeeping is meaningless after a bfcache restore.
      forceHideSpinner();
    }
  });
}

function showSpinner(): void {
  attachBfcacheCleanup();
  spinnerRefCount += 1;
  if (spinnerEl) return;
  const el = document.createElement("div");
  el.setAttribute("data-print-spinner", "");
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.style.cssText = [
    "position:fixed", "inset:0", "z-index:9999",
    "display:flex", "flex-direction:column", "align-items:center", "justify-content:center",
    "gap:14px",
    "background:rgba(0,0,0,0.35)",
    "backdrop-filter:blur(2px)",
    "-webkit-backdrop-filter:blur(2px)",
  ].join(";");
  el.innerHTML = `
    <style>@keyframes mfy-print-spin { to { transform: rotate(360deg); } }</style>
    <div style="
      width:54px;height:54px;border-radius:50%;
      border:5px solid rgba(255,255,255,0.35);
      border-top-color:#fff;
      animation:mfy-print-spin 0.85s linear infinite;
    "></div>
    <div data-spinner-label style="
      color:#fff;font-weight:600;font-size:14px;
      font-family:system-ui,-apple-system,sans-serif;
      opacity:0;transition:opacity 0.2s ease-in;
    ">Preparing your print…</div>
  `;
  document.body.appendChild(el);
  spinnerEl = el;
  // Slight delay before the label appears — keeps fast responses
  // (<300ms) from flashing text at the user.
  spinnerLabelTimer = window.setTimeout(() => {
    const label = el.querySelector<HTMLDivElement>("[data-spinner-label]");
    if (label) label.style.opacity = "1";
  }, 350);
  // Safety timeout — should never trigger in the happy path; logs
  // a warning if it does so we can investigate.
  spinnerSafetyTimer = window.setTimeout(() => {
    console.warn("[print-pdf] spinner safety timeout fired — forcing hide");
    forceHideSpinner();
  }, SPINNER_SAFETY_MS);
}

function hideSpinner(): void {
  spinnerRefCount = Math.max(0, spinnerRefCount - 1);
  if (spinnerRefCount > 0) return;
  forceHideSpinner();
}

function forceHideSpinner(): void {
  spinnerRefCount = 0;
  if (spinnerLabelTimer !== null) {
    clearTimeout(spinnerLabelTimer);
    spinnerLabelTimer = null;
  }
  if (spinnerSafetyTimer !== null) {
    clearTimeout(spinnerSafetyTimer);
    spinnerSafetyTimer = null;
  }
  if (spinnerEl) {
    try { spinnerEl.remove(); } catch { /* already detached */ }
    spinnerEl = null;
  }
}

export async function printPdf(url: string): Promise<void> {
  // Add inline=1 AND a unique cachebuster to whatever query string
  // is already there. Mobile browsers (iOS Safari + WKWebView
  // especially) sometimes ignore Cache-Control: no-store and
  // serve a stale PDF when the same URL is hit twice in a session.
  // Date.now() guarantees each print hits the server fresh, so
  // every print picks up the latest printableBounds and any
  // route-code changes.
  const sep = url.includes("?") ? "&" : "?";
  const inlineUrl = `${url}${sep}inline=1&t=${Date.now()}`;

  showSpinner();

  // ── Mobile: navigate to the https URL directly ──
  // We deliberately do NOT fetch as a blob first on mobile. iOS
  // Safari + Capacitor WKWebView render PDFs at https URLs via
  // their native viewer (AirPrint, share sheet), but blob: URLs
  // either show nothing or trigger a Save sheet — breaking the
  // whole print-from-phone flow. The browser's URL-bar progress
  // indicator covers the server-render wait, plus our spinner
  // stays up until the page unloads.
  if (isMobile()) {
    // Yield one paint so the spinner is visible before the
    // navigation tears down the page. Without this the spinner
    // can appear-and-disappear in the same frame on fast devices.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    window.location.href = inlineUrl;
    return;
  }

  // ── Desktop: fetch the PDF as a blob first ──
  // The slow part of printing a math-heavy paper is the server-
  // side MathJax → PNG rendering. Fetching into a blob with the
  // spinner up gives the user real visual feedback. The hidden
  // iframe then loads the blob URL instantly.
  let blobUrl: string;
  try {
    const res = await fetch(inlineUrl, { credentials: "include" });
    if (!res.ok) {
      // Surface a helpful message rather than dumping the user
      // onto a blank tab. The route returns JSON on error.
      let msg = `Print failed (${res.status})`;
      try {
        const body = await res.json();
        if (body?.error) msg = body.error;
      } catch { /* not JSON */ }
      hideSpinner();
      alert(msg);
      return;
    }
    const blob = await res.blob();
    blobUrl = URL.createObjectURL(blob);
  } catch (err) {
    console.warn("[print-pdf] fetch failed:", err);
    hideSpinner();
    // Last-ditch fallback — let the browser try the URL directly.
    window.location.href = inlineUrl;
    return;
  }

  // Invisible iframe + window.print(). Spinner stays up until the
  // iframe loads + print dialog is invoked, then is removed before
  // the dialog opens so it doesn't appear in the print preview.
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.setAttribute("aria-hidden", "true");
  iframe.src = blobUrl;

  const cleanup = () => {
    setTimeout(() => {
      try { iframe.remove(); } catch { /* already detached */ }
      try { URL.revokeObjectURL(blobUrl); } catch { /* ignored */ }
    }, 60_000); // keep alive while the print dialog is open
  };

  let printed = false;
  iframe.onload = () => {
    setTimeout(() => {
      hideSpinner();
      try {
        const win = iframe.contentWindow;
        if (!win) throw new Error("no contentWindow");
        win.focus();
        win.print();
        printed = true;
      } catch (err) {
        console.warn("[print-pdf] iframe.print() failed, falling back to navigation", err);
        if (!printed) window.location.href = blobUrl;
      } finally {
        cleanup();
      }
    }, 250);
  };
  iframe.onerror = () => {
    console.warn("[print-pdf] iframe load failed, falling back to download");
    hideSpinner();
    cleanup();
    window.location.href = url;
  };

  document.body.appendChild(iframe);
}
