// One-shot sweep: every English Synthesis & Transformation question
// whose transcribedStem carries two consecutive underscore runs (i.e.
// the answer area wraps across two printed lines on the source paper)
// has the second run dropped. The marker sees one blank instead of
// two — confused-keyword-skip bug goes away.
//
// Run with:  npx tsx scripts/collapse-synthesis-blanks.ts [--apply]
//
// Default is DRY RUN. Pass --apply to commit the changes.

import { prisma } from "@/lib/db";

const BLANK = String.raw`(?:\\_|_){3,}`;
// One blank, then AT LEAST ONE whitespace char (incl. newlines),
// then another blank. \s+ — not \s* — is critical: with \s* the
// regex engine backtracks INSIDE a single long run of underscores
// and "matches" itself (e.g. 32 underscores → 29 + 0 ws + 3), which
// collapses every long run to 3 chars. \s+ forces a real separator.
const CONSEC_RE = new RegExp(`(${BLANK})\\s+(${BLANK})`, "g");

function collapse(stem: string): string {
  // Run the regex repeatedly — three consecutive blanks (rare, but
  // possible if a third line wraps) become a single blank after two
  // passes. JS replace's /g is greedy but doesn't re-scan the result;
  // loop until no more matches.
  let out = stem;
  let prev: string;
  do {
    prev = out;
    out = out.replace(CONSEC_RE, "$1");
  } while (out !== prev);
  return out;
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "── APPLY mode ──" : "── DRY RUN (pass --apply to commit) ──");

  const candidates = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: { contains: "ynthesis" },
      transcribedStem: { not: null },
    },
    select: { id: true, questionNum: true, examPaperId: true, transcribedStem: true },
  });
  console.log(`scanning ${candidates.length} synthesis questions...`);

  let touched = 0;
  for (const q of candidates) {
    const stem = q.transcribedStem ?? "";
    if (!CONSEC_RE.test(stem)) continue;
    // Reset lastIndex so the .test() above doesn't poison the replace.
    CONSEC_RE.lastIndex = 0;
    const next = collapse(stem);
    if (next === stem) continue;

    touched++;
    if (touched <= 10) {
      console.log(`\nQ${q.questionNum} (exam=${q.examPaperId.slice(-6)}, id=${q.id.slice(-6)})`);
      console.log("  before:", JSON.stringify(stem.slice(0, 220)));
      console.log("  after: ", JSON.stringify(next.slice(0, 220)));
    } else if (touched === 11) {
      console.log("  …(more — silencing per-row dump)");
    }

    if (apply) {
      await prisma.examQuestion.update({
        where: { id: q.id },
        data: { transcribedStem: next },
      });
    }
  }

  console.log(`\n── total: ${touched} question(s) ${apply ? "rewritten" : "would be rewritten"}.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
