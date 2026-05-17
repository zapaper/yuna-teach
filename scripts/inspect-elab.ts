import { prisma } from "../src/lib/db";
(async () => {
  const PAPER_ID = process.argv[2];
  const Q_NUM = process.argv[3];
  if (!PAPER_ID || !Q_NUM) {
    console.error("usage: inspect-elab.ts <paperId> <questionNum>");
    process.exit(1);
  }
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: PAPER_ID, questionNum: Q_NUM },
    select: { id: true, elaboration: true, transcribedStem: true },
  });
  if (!q) { console.error("not found"); process.exit(1); }
  console.log(`stem: ${(q.transcribedStem ?? "").slice(0, 80)}`);
  console.log(`---`);
  if (!q.elaboration) {
    console.log("no elaboration cached");
  } else {
    try {
      const parsed = JSON.parse(q.elaboration) as { solution?: string; diagrams?: unknown[] };
      console.log("=== solution (parsed) ===");
      console.log(parsed.solution);
      console.log("\n=== diagrams ===");
      console.log(JSON.stringify(parsed.diagrams, null, 2));
    } catch {
      console.log("(unparseable JSON; raw):");
      console.log(q.elaboration);
    }
  }
  await prisma.$disconnect();
})();
