// Pull Lumi workshop patterns for English diagnoses, then filter to
// the ones that read as Comprehension Cloze mistakes. Output goes to
// the console + a JSON file for the next step (proposing the
// sub-topic taxonomy).
//
// "Comprehension Cloze" keywords used to filter patterns:
//   cloze, blank, fill, missing word, wrong word, vocabulary in
//   context, word choice, connector, conjunction, "context clue".
//
// We also pull a sample of actual PSLE Comp Cloze questions + their
// answer keys so the next step has both the kid-level patterns AND
// the marker-level vocabulary in front of it.

import { prisma } from "@/lib/db";
import { TUTOR_CACHE } from "@/lib/tutor-cache";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";

const COMP_CLOZE_KEYWORDS = [
  "cloze",
  "blank",
  "fill in",
  "fill-in",
  "missing word",
  "context",
  "connector",
  "conjunction",
  "word choice",
  "wrong word",
  "linking word",
  "preposition",
];

async function main() {
  const patterns: Array<{ studentKey: string; what: string; advice: string; sampleQs?: number }> = [];
  for (const [key, val] of Object.entries(TUTOR_CACHE)) {
    if (!key.endsWith(":english")) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ps = (val as any)?.patterns;
    if (!Array.isArray(ps)) continue;
    for (const p of ps) {
      const what = String(p?.what ?? "").trim();
      const advice = String(p?.advice ?? "").trim();
      const blob = (what + " " + advice).toLowerCase();
      if (COMP_CLOZE_KEYWORDS.some(kw => blob.includes(kw))) {
        patterns.push({ studentKey: key, what, advice });
      }
    }
  }
  console.log(`Mined ${patterns.length} Comp Cloze-shaped patterns from ${Object.keys(TUTOR_CACHE).filter(k => k.endsWith(":english")).length} English diagnoses.\n`);
  // Group by "what" prefix (first 60 chars) to see recurring themes.
  const themes = new Map<string, number>();
  for (const p of patterns) {
    const k = p.what.slice(0, 70).toLowerCase().replace(/[^a-z\s]/g, "").trim();
    themes.set(k, (themes.get(k) ?? 0) + 1);
  }
  console.log("Top recurring 'what' prefixes:");
  for (const [k, c] of [...themes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${(c + "").padStart(3)}  ${k}`);
  }
  console.log("");

  // Sample 20 PSLE Comp Cloze questions + answer keys for taxonomy
  // signal. Most useful: actual answer-key vocabulary across the
  // bank. We pick from the 967 master questions.
  const sample = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        subject: { equals: "English", mode: "insensitive" },
        sourceExamId: null,
        OR: [
          { title: { contains: "PSLE", mode: "insensitive" } },
          { level: { contains: "6", mode: "insensitive" } },
        ],
      },
      syllabusTopic: "Comprehension Cloze",
      answer: { not: null },
    },
    select: { id: true, transcribedStem: true, answer: true, examPaperId: true },
    take: 30,
    orderBy: { id: "asc" },
  });
  console.log("Sample of 5 PSLE Comprehension Cloze questions + answer keys:\n");
  for (const q of sample.slice(0, 5)) {
    console.log(`Q ${q.id.slice(-6)}:`);
    console.log(`  stem: ${(q.transcribedStem ?? "").slice(0, 200).replace(/\s+/g, " ")}`);
    console.log(`  ans:  ${(q.answer ?? "").slice(0, 80)}`);
    console.log("");
  }

  // Dump to a file for the next pass.
  mkdirSync(path.join("eval", "english-classifiers"), { recursive: true });
  const out = path.join("eval", "english-classifiers", "comp-cloze-patterns.json");
  writeFileSync(out, JSON.stringify({ patterns, sample }, null, 2));
  console.log(`Wrote ${out} (${patterns.length} patterns, ${sample.length} sample Qs).`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
