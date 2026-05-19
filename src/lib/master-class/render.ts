// Shared inline-markdown renderer for Master Class slide content.
// Both the admin workshop and the student player import this so they
// stay in lock-step.
//
// Supports:
//   **bold**          → <strong>
//   __underline__     → <u>
//   \n\n  (paragraph) → <br><br>
//   \n     (line)     → <br>
// HTML special chars are escaped first.
export function renderInlineMd(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+?)__/g, "<u>$1</u>")
    .replace(/\n{2,}/g, "<br><br>")
    .replace(/\n/g, "<br>");
}
