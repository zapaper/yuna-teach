// Shared MCQ-vs-OEQ shape detection. Used by:
//   - server-side marker (src/lib/marking.ts)
//   - client-side review / quiz pages
// so the classification is consistent on both sides.
//
// History: this used to live inline in marking.ts and the review page
// did its own `transcribedOptions.length === 4` check. A bug surfaced
// where some OEQ rows had `transcribedOptions = ["", "", "", ""]`
// (extractor seeded a 4-empty-string array onto an OEQ question), and
// the review page treated those as MCQs. The fix is to fall back to
// the ANSWER shape when the options array is empty: a non-empty option
// string OR an MCQ-shaped answer key means MCQ; otherwise OEQ.

/** MCQ answer keys come back as a single digit / letter, optionally
 *  wrapped in parens. The "X or Y" alternation is also valid (relaxed
 *  answer keys with two acceptable options). Anything else — prose,
 *  multi-step working, "Final answer: 3 students" — is OEQ. */
export function isMcqAnswer(answer: string | null | undefined): boolean {
  if (!answer) return false;
  // Answer-key extraction occasionally stores MCQ keys as
  // "(3) | working explanation". Strip everything past the first
  // " | " before classifying.
  const head = (answer.split("|")[0] ?? answer).trim();
  if (!head) return false;
  if (/^\(?[1-4A-Da-d]\)?$/.test(head)) return true;
  // "3 or 4", "(1) or (3)" — both ends must be 1-4 / A-D.
  const normalized = head.replace(/[().]/g, "").trim();
  const parts = normalized.split(/\s+or\s+/).map(p => p.trim());
  if (parts.length > 1 && parts.every(p => /^[1-4A-Da-d]$/.test(p))) return true;
  return false;
}

/** True when at least one of the four option strings has visible text.
 *  An array of four empty strings is treated as "no real options".
 *  Written as a type guard so the .map / .[i] sites downstream can
 *  use the narrowed string[] type without re-asserting. */
export function hasOptionText(opts: unknown): opts is string[] {
  if (!Array.isArray(opts)) return false;
  if (opts.length !== 4) return false;
  return opts.some(o => typeof o === "string" && o.trim().length > 0);
}

/** Authoritative MCQ-vs-OEQ check for a question whose option / answer
 *  fields are loaded. Returns true if ANY of these hold:
 *    - text options with content
 *    - image options (at least one non-null)
 *    - option-table rows (4)
 *    - answer field is MCQ-shaped (single digit / letter, "X or Y")
 *  Falls back to OEQ when all four signals are absent.
 *
 *  The answer-side check is the catch for legacy rows whose options
 *  weren't transcribed but whose answer key IS just "1" / "2" / etc.
 *  Those ARE real MCQs (the kid sees the option image even if the text
 *  never made it into the DB).
 */
export function looksLikeMcq(q: {
  transcribedOptions?: unknown;
  transcribedOptionImages?: unknown;
  transcribedOptionTable?: unknown;
  answer?: string | null;
}): boolean {
  if (hasOptionText(q.transcribedOptions)) return true;
  if (Array.isArray(q.transcribedOptionImages) && q.transcribedOptionImages.some(x => !!x)) return true;
  const tbl = q.transcribedOptionTable as { rows?: unknown } | null | undefined;
  if (tbl && Array.isArray(tbl.rows) && tbl.rows.length === 4) return true;
  if (isMcqAnswer(q.answer ?? null)) return true;
  return false;
}
