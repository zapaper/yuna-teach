// Count Synthesis & Transformation questions per sub-topic.
// Synthesis questions are tagged in syllabusTopic = "Synthesis" /
// "Synthesis & Transformation" and the subTopic field carries the
// grammatical pattern being tested (e.g. "Conditional", "Although",
// "Despite", etc.).

import { prisma } from "../src/lib/db";

async function main() {
  const qs = await prisma.examQuestion.findMany({
    where: {
      // Synthesis & Transformation only — explicitly excluding the
      // Photosynthesis false positives my first query swept in.
      syllabusTopic: { in: ["Synthesis / Transformation", "Synthesis & Transformation"] },
      examPaper: { visible: true },
    },
    select: {
      id: true, syllabusTopic: true, subTopic: true, transcribedStem: true,
      examPaper: { select: { level: true, paperType: true, visible: true } },
    },
  });

  console.log(`${qs.length} Synthesis & Transformation questions (visible papers only)\n`);

  // Derived sub-topic from the bolded keyword in the stem.
  // Synthesis question shape: source sentence, then a TEMPLATE line with
  // **bold-keyword** ____________ . The keyword IS the sub-topic.
  // Normalise lowercase + collapse whitespace so "Although" / "although"
  // / " Although " all bucket together.
  function extractKeyword(stem: string | null): string | null {
    if (!stem) return null;
    const matches = [...stem.matchAll(/\*\*([^*]{1,80})\*\*/g)].map(m => m[1].trim());
    if (matches.length === 0) return null;
    // The keyword line typically appears after the source sentence,
    // and often there are decorative bolds for emphasis elsewhere.
    // Heuristic: pick the SHORTEST bold (the synthesis keyword is
    // usually a single word or short phrase like "instead of",
    // "no sooner", "although", etc.), tied break by latest position.
    matches.sort((a, b) => a.length - b.length);
    return matches[0].toLowerCase().replace(/\s+/g, " ");
  }

  const bySub = new Map<string, number>();
  let untagged = 0;
  for (const q of qs) {
    const kw = extractKeyword(q.transcribedStem);
    if (!kw) { untagged++; continue; }
    bySub.set(kw, (bySub.get(kw) ?? 0) + 1);
  }

  console.log(`Sub-topic (derived from bold keyword in stem) — ${bySub.size} distinct keywords, ${untagged} questions had no detectable bold:\n`);
  for (const [k, v] of [...bySub.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${v.toString().padStart(4)}  ${k}`);
  }

  console.log();

  // Level split
  const byLevel = new Map<string, number>();
  for (const q of qs) {
    const k = q.examPaper.level ?? "(unknown)";
    byLevel.set(k, (byLevel.get(k) ?? 0) + 1);
  }
  console.log(`By level:`);
  for (const [k, v] of [...byLevel.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${v.toString().padStart(4)}  ${k}`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
