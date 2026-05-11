// Open the system print dialog for a PDF URL without first
// downloading it to disk. The PDF endpoint must support `?inline=1`
// (Content-Disposition: inline) so the browser/WebView renders the
// bytes in an <iframe> instead of triggering a Save dialog. The
// helper appends `inline=1`, loads the URL into an off-screen
// iframe, and calls iframe.contentWindow.print() once the load
// settles.
//
// Works in:
//   - Chrome / Firefox / Safari (desktop): triggers the browser
//     print dialog directly.
//   - Capacitor iOS WKWebView: window.print() inside the iframe
//     surfaces the iOS share sheet with AirPrint as the first
//     action (same UX users get on iOS Safari).
//
// Edge cases:
//   - iOS Safari renders inline PDFs as a "tap to preview" tile
//     instead of a live document in some configs. If
//     iframe.contentWindow stays null after load, we fall back to
//     a same-tab navigation so the user at least sees the PDF and
//     can use the share button.
//   - Browsers can block window.print() if it fires too soon — we
//     wait for the iframe `load` event plus a 250ms settle so the
//     PDF viewer has time to wire up its document.

export function printPdf(url: string): void {
  // Add inline=1 to whatever query string is already there.
  const inlineUrl = url + (url.includes("?") ? "&" : "?") + "inline=1";

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
        // Last resort: open the PDF in the current tab so the user
        // at least sees it and can print via their browser's UI.
        if (!printed) window.location.href = inlineUrl;
      } finally {
        cleanup();
      }
    }, 250);
  };
  iframe.onerror = () => {
    console.warn("[print-pdf] iframe load failed, falling back to download");
    cleanup();
    // The original URL (without inline=1) still downloads the file.
    window.location.href = url;
  };

  document.body.appendChild(iframe);
}
