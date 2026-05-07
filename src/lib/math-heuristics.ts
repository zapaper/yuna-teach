// Singapore Math problem-solving heuristics — the four "Math Maven"
// techniques teachers use in PSLE prep. Injected into the AI-
// explanation prompt for math questions so the model picks the
// idiomatic technique rather than algebra-dumping. Empty string for
// non-math subjects so we don't burn tokens on Science / English.
//
// Pass `subject` if you know it (e.g. paper.subject in the elaborate
// route). Pass `undefined` / no arg for the solver path where the AI
// detects subject itself — the block contains "only when applicable"
// guidance so it's safe to emit unconditionally.

export function mathHeuristicsBlock(subject?: string | null): string {
  if (subject !== undefined && (!subject || !subject.toLowerCase().includes("math"))) {
    return "";
  }
  return `

SINGAPORE MATH HEURISTICS — these are only relevant for **word problems** that match the patterns below. **Most math questions (computation drills, area/perimeter, time, simple fractions, geometry, MCQ on definitions) DO NOT use these heuristics — for those, just teach the direct method.** Only invoke a heuristic when the question genuinely fits one of these patterns.

When you use a heuristic, the FIRST line of the solution must be a header on its own line announcing the technique:
- "**Using Bar Modeling**"
- "**Before-and-After Method**"
- "**Working Backwards**"
- "**Supposition (Guess-and-Check)**"

Then a blank line, then the step-by-step working. Don't repeat the technique name inside step labels — the header is enough.

1. **Bar Modeling** (part-whole or comparison) — use when the question is about parts of a total, comparing two quantities, or distributing items in known ratios. Describe bars with **labelled units** in writing ("Cathy: |==|==|==|, Dan: |==|==|"), then identify "1 unit = …" and read off the answer.

2. **Before-and-After Method** — use when a quantity CHANGES mid-problem (someone gives away, receives, or transforms a fraction/ratio of what they had). Set up a "before" picture, then a separate "after" picture, and find what was preserved between them (common multiple, total, or one person's share that didn't change). For these problems, **emit TWO entries in the diagrams array** — the first with \`"title": "Before"\` showing the initial state, the second with \`"title": "After"\` showing the post-change state. Use the SAME row labels in both diagrams (same person/quantity names) so the student can compare the bars side-by-side. Each diagram's \`unitValue\` should reflect what 1 unit equals at THAT stage (often only the "After" diagram has a known unitValue — leave "Before" as null until you've solved).

3. **Working Backwards** — use when the question gives the FINAL state and asks for the start (e.g. "after spending half then $5 more, she had $7 left"). Reverse each step in turn.

4. **Supposition / Guess-and-Check** — use when the problem hides TWO unknowns inside one total (chickens-and-rabbits style: "30 heads, 80 legs"). Suppose all are one kind, compute the difference from the actual total, then adjust.

If none of these four patterns clearly fits, do NOT shoehorn the problem into a heuristic. Just solve it directly.`;
}
