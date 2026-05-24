// Normalise math/science OEQ answer-key strings to the canonical
// sub-part label format expected by the marking pipeline:
//   "(a)"        — simple sub-part
//   "(a)(i)"     — compound sub-part
//
// Input variants seen in real answer keys (printed by school papers
// in inconsistent ways) that this normaliser fixes:
//   "Q7a) X"           → "(a) X"
//   "Q7(a) X"          → "(a) X"
//   "7a) X"            → "(a) X"
//   "7(a) X"           → "(a) X"
//   "a) X"             → "(a) X"
//   "a. X"             → "(a) X"
//   "(a) (i) X"        → "(a)(i) X"   (collapse internal space)
//   "(a) i) X"         → "(a)(i) X"
//   "a)(i) X"          → "(a)(i) X"
//   "(a) X | (i) Y"    → "(a) X | (a)(i) Y"   (bare roman gets parent letter from most recent label)
//
// All transforms operate on the raw answer string. The marking pipeline
// uses " | " as the separator between sub-part chunks — we preserve it.

export type NormaliseResult = { normalized: string; changed: boolean };

const ROMAN_RE = "i{1,3}|iv|v|vi{0,3}|ix|x";

export function normaliseAnswerKeyFormat(answer: string): NormaliseResult {
  if (!answer || typeof answer !== "string") return { normalized: answer, changed: false };
  const original = answer;
  let result = answer;

  // 1) Strip the question-number prefix in front of compound labels:
  //    "Q7(a)(i) X" / "7(a)(i) X" → "(a)(i) X"
  //    Run BEFORE the simple-letter pass below so we don't accidentally
  //    eat the parent letter.
  result = result.replace(
    /(^|\s\|\s)\s*Q?\d+\(([a-h])\)\((i{1,3}|iv|v|vi{0,3}|ix|x)\)/gi,
    (_m, sep, letter, roman) => `${sep}(${letter.toLowerCase()})(${roman.toLowerCase()})`
  );

  // 2) Strip the question-number prefix in front of simple labels:
  //    "Q7a X" / "Q7a) X" / "Q7(a) X" / "7a X" / "7a) X" / "7(a) X" → "(a) X"
  result = result.replace(
    /(^|\s\|\s)\s*Q?\d+\(?([a-h])\)?(?=[\s.):])/gi,
    (_m, sep, letter) => `${sep}(${letter.toLowerCase()})`
  );

  // 3) "a) X" or "a. X" at the start of a chunk → "(a) X".
  //    Restrict to a-h so we don't mangle prose that happens to start
  //    with a letter followed by a paren.
  result = result.replace(
    /(^|\s\|\s)\s*([a-h])[).]\s/gi,
    (_m, sep, letter) => `${sep}(${letter.toLowerCase()}) `
  );

  // 4) "a)(i) X" → "(a)(i) X"  (letter missing its outer parens before a compound roman)
  result = result.replace(
    new RegExp(`(^|\\s\\|\\s)\\s*([a-h])\\)\\((${ROMAN_RE})\\)`, "gi"),
    (_m, sep, letter, roman) => `${sep}(${letter.toLowerCase()})(${roman.toLowerCase()})`
  );

  // 5) "(a) (i)" or "(a) i)" → "(a)(i)"  (collapse internal space between letter
  //    and its compound roman). Only when the roman immediately follows the letter
  //    within the same chunk — does NOT touch ` | (i)` (handled by pass 6).
  result = result.replace(
    new RegExp(`\\(([a-h])\\)\\s+\\(?(${ROMAN_RE})\\)`, "gi"),
    (_m, letter, roman) => `(${letter.toLowerCase()})(${roman.toLowerCase()})`
  );

  // 6a) MCQ keys that carry an explanation suffix: "(3) | working notes"
  //     or "B | because the others are…". When the whole answer is a single
  //     MCQ-shaped head followed by " | …", drop the suffix. The marker
  //     and renderer have defensive splits but cleaning the stored data
  //     is the durable fix.
  {
    const m = result.match(/^\s*(\(?[1-4A-Da-d]\)?)\s*\|/);
    if (m) {
      result = m[1];
    }
  }

  // 6) Bare "(i)" / "(ii)" / "ii)" / "ii." / etc. as a chunk → attach
  //    the most-recent parent letter seen earlier in the answer. Walk
  //    chunks left-to-right tracking the last (letter) we saw — simple
  //    or compound. Accept the roman with EITHER both parens "(ii)" OR
  //    just a trailing paren/dot "ii)" / "ii." — printed answer keys
  //    use all three conventions.
  const parts = result.split(/(\s\|\s)/);
  let currentParent: string | null = null;
  const parentRe = /^\s*\(([a-h])\)/i;
  // Two shapes we'll attach the parent to:
  //   (ii)   — both parens
  //   ii)    — closing paren only
  //   ii.    — dot terminator
  const bareRomanRe = new RegExp(`^\\s*(?:\\((${ROMAN_RE})\\)|(${ROMAN_RE})[).])`, "i");
  for (let i = 0; i < parts.length; i += 2) {
    const chunk = parts[i];
    const parentMatch = chunk.match(parentRe);
    if (parentMatch) {
      currentParent = parentMatch[1].toLowerCase();
      continue;
    }
    const bareMatch = chunk.match(bareRomanRe);
    if (bareMatch && currentParent) {
      const roman = (bareMatch[1] ?? bareMatch[2] ?? "").toLowerCase();
      if (roman) {
        parts[i] = chunk.replace(bareRomanRe, `(${currentParent})(${roman}) `).replace(/  +/g, " ");
      }
    }
  }
  result = parts.join("");

  // Tidy: collapse any double spaces introduced by the transforms.
  result = result.replace(/  +/g, " ").trim();

  // Compare against a whitespace-normalised original so pure
  // whitespace cleanup (trailing newlines, double spaces) does NOT
  // count as a "format issue". Only substantive label transforms
  // (e.g. "7a)" → "(a)") should flag a row for admin review.
  const tidiedOriginal = original.replace(/  +/g, " ").trim();
  return { normalized: result, changed: result !== tidiedOriginal };
}
