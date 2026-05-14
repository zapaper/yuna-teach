// Render a stored subpart label into the human-facing "(a)" /
// "(a)(i)" form used everywhere the student or parent sees a
// label printed.
//
// Storage convention (set by the OEQ extraction prompt in
// src/lib/gemini.ts):
//   "a"     → simple sub-part   → display "(a)"
//   "b"     → simple sub-part   → display "(b)"
//   "a-i"   → compound          → display "(a)(i)"
//   "a-ii"  → compound          → display "(a)(ii)"
//   "b-iii" → compound          → display "(b)(iii)"
//
// The dash is purely an internal separator — students never see
// it. Keeping all labels as plain ASCII (no parens in storage)
// preserves the existing equality / lowercase / startsWith("_")
// comparisons scattered through marking.ts and the focused-test
// route.
export function formatSubpartLabel(label: string): string {
  if (!label) return "()";
  // Compound: split on "-" and wrap each piece in its own ().
  if (label.includes("-")) {
    return label.split("-").map((p) => `(${p})`).join("");
  }
  return `(${label})`;
}
