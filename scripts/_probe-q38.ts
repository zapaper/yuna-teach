import { prisma } from "../src/lib/db";
async function main() {
  const qs = await prisma.examQuestion.findMany({
    where: {
      examPaperId: "cmnbuadll0001c4cr4j0lkdr7",
      questionNum: { startsWith: "38" },
    },
    orderBy: { questionNum: "asc" },
    select: {
      questionNum: true, marksAvailable: true,
      transcribedStem: true, transcribedSubparts: true, answer: true,
    },
  });
  for (const q of qs) {
    console.log(`\n=== Q${q.questionNum}  marksAvailable=${q.marksAvailable} ===`);
    console.log(`stem: ${(q.transcribedStem ?? "").slice(0, 200)}`);
    const sps = q.transcribedSubparts as Array<{label?: string; text?: string}> | null;
    if (Array.isArray(sps)) {
      for (const sp of sps) {
        if (sp.label?.startsWith("_")) continue;
        console.log(`  (${sp.label}) ${(sp.text ?? "").slice(0, 150)}`);
      }
    }
    console.log(`answer: ${(q.answer ?? "").slice(0, 200)}`);
  }
  process.exit(0);
}
main();
