import { parsePartAnswers } from "../src/lib/marking";

function show(label: string, input: string) {
  const m = parsePartAnswers(input);
  console.log(`\n${label}`);
  console.log(`  input: ${input}`);
  console.log(`  parsed:`);
  for (const [k, v] of m) console.log(`    ${k} → "${v}"`);
}

// The actual bug — master answer key (compound + simple)
show("master compound", "(a)(i) K (a)(ii) J | (b) Container K has bigger opening. | (c) Wind speed must be same.");

// The hybrid clone artifact (mixed compound formats)
show("clone hybrid", "(a-i) K (a)(ii) J | (b) Container K has bigger opening. | (c) Wind speed must be same.");

// Plain hyphen form
show("hyphen only", "(a-i) K | (a-ii) J | (b) Container... | (c) Wind...");

// Plain simple labels
show("simple only", "(a) Yes | (b) No | (c) Maybe");

// Mixed: compound (a)(i)/(a)(ii), then simple (b)
show("compound + simple", "(a)(i) Apple (a)(ii) Banana | (b) Carrot");

// Edge: nothing labelled
show("plain prose", "The capital is London. Apply rule (a) to the next step.");

// Q15 cmqf3g47u — MCQ master answer typed without the " | " pipe.
// Used to bundle the whole tail "C (b) A" into (a). Should now split.
show("simple space-separated", "(a) C (b) A");

// 3-label chain "(a) X (b) Y (c) Z" — make sure the forward-walk
// keeps chaining past (b).
show("simple space-separated 3-way", "(a) Apple (b) Banana (c) Carrot");

// Prose safety: a single (a) followed by an out-of-sequence (z) — the
// relaxed scan must NOT match (z) because z is not the next letter.
show("prose with out-of-sequence label", "(a) Apply rule (z) to the next step.");
