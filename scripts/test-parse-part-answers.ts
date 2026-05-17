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
