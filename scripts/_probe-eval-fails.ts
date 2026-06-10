import { prisma } from "../src/lib/db";

(async () => {
  const TARGETS: ReadonlyArray<[string, string]> = [
    ["cmp1aebd00001ftsttx409h23", "10"], // P4 Cycles Q10 expected 2 got 0
    ["cmozcbl4e001d11l7dro13hbp", "6"],  // P6 Geometry Q6 expected 3 got 2
  ];
  for (const [master, qNum] of TARGETS) {
    const m = await prisma.examPaper.findUnique({ where: { id: master }, select: { title: true } });
    console.log(`\n=== ${m?.title} / Q${qNum} ===`);
    const recentClone = await prisma.examPaper.findFirst({
      where: { sourceExamId: master, paperType: "eval" },
      orderBy: { createdAt: "desc" },
      select: { id: true, score: true, createdAt: true },
    });
    if (!recentClone) {
      console.log(`  no eval clone found (cleanup ran)`);
      continue;
    }
    console.log(`  cloneId=${recentClone.id}  score=${recentClone.score}  createdAt=${recentClone.createdAt.toISOString()}`);
    const q = await prisma.examQuestion.findFirst({
      where: { examPaperId: recentClone.id, questionNum: qNum },
      select: {
        marksAwarded: true,
        marksAvailable: true,
        studentAnswer: true,
        markingNotes: true,
        answer: true,
        syllabusTopic: true,
      },
    });
    if (!q) { console.log(`  Q${qNum} not found on clone`); continue; }
    console.log(`  topic: ${q.syllabusTopic ?? "(none)"}`);
    console.log(`  key:   ${(q.answer ?? "").slice(0, 250)}`);
    console.log(`  awarded: ${q.marksAwarded} / ${q.marksAvailable}`);
    console.log(`  studentAnswer: ${(q.studentAnswer ?? "(none)").slice(0, 400)}`);
    console.log(`  markingNotes:`);
    console.log("    " + (q.markingNotes ?? "(none)").replace(/\n/g, "\n    ").slice(0, 1200));
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
