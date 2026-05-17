import { prisma } from "../src/lib/db";

const NEEDLE = process.argv.slice(2).join(" ").trim();
if (!NEEDLE) {
  console.error("Usage: tsx scripts/find-mcq.ts \"<text fragment>\"");
  process.exit(1);
}

async function main() {
  const matches = await prisma.examQuestion.findMany({
    where: {
      transcribedStem: { contains: NEEDLE, mode: "insensitive" },
      examPaper: { sourceExamId: null, paperType: null },
    },
    select: {
      id: true,
      questionNum: true,
      transcribedStem: true,
      transcribedOptions: true,
      answer: true,
      examPaper: { select: { id: true, title: true, level: true, examType: true } },
    },
    take: 20,
  });
  console.log(`Found ${matches.length} match(es) for "${NEEDLE}":`);
  for (const q of matches) {
    const stemPreview = (q.transcribedStem ?? "").slice(0, 200).replace(/\n/g, " ⏎ ");
    console.log(`\n  ${q.id} · Q${q.questionNum} · ${q.examPaper.title} (${q.examPaper.level ?? "?"} ${q.examPaper.examType ?? ""})`);
    console.log(`    Stem: ${stemPreview}`);
    const opts = q.transcribedOptions as unknown;
    if (Array.isArray(opts)) {
      opts.forEach((o, i) => {
        if (typeof o === "string") console.log(`    (${i+1}) ${o}`);
      });
    }
    console.log(`    Answer: ${q.answer}`);
    console.log(`    Has $: ${(q.transcribedStem ?? "").includes("$")}`);
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
