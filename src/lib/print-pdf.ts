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

export function printPdf(url: string): void {
  // Add inline=1 AND a unique cachebuster to whatever query string
  // is already there. Mobile browsers (iOS Safari + WKWebView
  // especially) sometimes ignore Cache-Control: no-store and
  // serve a stale PDF when the same URL is hit twice in a session.
  // Date.now() guarantees each print hits the server fresh, so
  // every print picks up the latest printableBounds and any
  // route-code changes.
  const sep = url.includes("?") ? "&" : "?";
  const inlineUrl = `${url}${sep}inline=1&t=${Date.now()}`;

  // Mobile: navigate to the inline PDF and let the native viewer
  // handle printing. Most direct path on touch devices.
  if (isMobile()) {
    window.location.href = inlineUrl;
    return;
  }

  // Desktop: invisible iframe + window.print().
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.setAttribute("aria-hidden", "true");
  iframe.src = inlineUrl;

  const cleanup = () => {
    setTimeout(() => {
      try { iframe.remove(); } catch { /* already detached */ }
    }, 60_000); // keep alive while the print dialog is open
  };

  let printed = false;
  iframe.onload = () => {
    setTimeout(() => {
      try {
        const win = iframe.contentWindow;
        if (!win) throw new Error("no contentWindow");
        win.focus();
        win.print();
        printed = true;
      } catch (err) {
        console.warn("[print-pdf] iframe.print() failed, falling back to navigation", err);
        if (!printed) window.location.href = inlineUrl;
      } finally {
        cleanup();
      }
    }, 250);
  };
  iframe.onerror = () => {
    console.warn("[print-pdf] iframe load failed, falling back to download");
    cleanup();
    window.location.href = url;
  };

  document.body.appendChild(iframe);
}
