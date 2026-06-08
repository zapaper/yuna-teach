import { prisma } from "../src/lib/db";

(async () => {
  const PAPER = "cmq4sc52800013bw7del0omk4";
  const p = await prisma.examPaper.findUnique({
    where: { id: PAPER },
    select: {
      id: true, title: true, subject: true,
      assignedToId: true, sourceExamId: true,
      markingStatus: true, completedAt: true,
    },
  });
  console.log("PAPER:", JSON.stringify(p, null, 2));

  // Master is the source — questions live there for clones
  const masterPaperId = p?.sourceExamId ?? PAPER;
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: masterPaperId, questionNum: { in: ["3", "6"] } },
    orderBy: { orderIndex: "asc" },
    select: {
      id: true, questionNum: true, marksAvailable: true,
      answer: true,
    },
  });
  console.log("\nMASTER QUESTIONS:");
  for (const q of qs) {
    console.log(`  Q${q.questionNum}  id=${q.id}  marksAvail=${q.marksAvailable}`);
    console.log(`    answer: ${(q.answer ?? "—").slice(0, 200)}`);
  }

  // Clone's marking output — marksAwarded + markingNotes
  const cloneQs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER, questionNum: { in: ["3", "6"] } },
    orderBy: { orderIndex: "asc" },
    select: {
      id: true, questionNum: true,
      marksAwarded: true, marksAvailable: true,
    },
  });
  console.log("\nCLONE MARKING:");
  for (const q of cloneQs) {
    console.log(`  Q${q.questionNum}  awarded=${q.marksAwarded}/${q.marksAvailable}`);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
