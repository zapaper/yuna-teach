// Shared inline-markdown renderer for Master Class slide content.
// Both the admin workshop and the student player import this so they
// stay in lock-step.
//
// Supports:
//   **bold**          → <strong>
//   __underline__     → <u>
//   ~~strike~~        → <s> (used to cross out wrong MCQ options on
//                            worked-example slides)
//   > quoted line     → italic muted span prefixed with "↳ "
//                       (used for the English translation that follows
//                       a Chinese bullet point — see e.g. the Q9-Q10
//                       worked-example slide on chinese-sentence-
//                       completion). Recognised at the start of a line
//                       only, optionally indented by whitespace.
//   \n\n  (paragraph) → <br><br>
//   \n     (line)     → <br>
// HTML special chars are escaped first. Because escape converts ">"
// to "&gt;", the blockquote pass keys off "&gt;" not raw ">".
export function renderInlineMd(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+?)__/g, "<u>$1</u>")
    .replace(/~~([^~\n]+?)~~/g, '<s class="text-slate-400">$1</s>')
    // Blockquote convention — once "&gt; text" appears at line start
    // (or after a paragraph break), wrap the rest of that line in a
    // muted italic span with an indent arrow. Applies before \n →
    // <br> conversion so the line-start anchor still matches.
    .replace(/(^|\n)\s*&gt;\s?([^\n]+)/g, '$1<span class="italic text-slate-500">↳ $2</span>')
    .replace(/\n{2,}/g, "<br><br>")
    .replace(/\n/g, "<br>");
}
