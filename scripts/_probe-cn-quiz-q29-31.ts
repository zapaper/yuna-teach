import { prisma } from "../src/lib/db";
async function main() {
  const id = "cmq0tgcuc00011e0qqv3pfcjc";
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: id, questionNum: { in: ["29", "30", "31", "32"] } },
    select: {
      id: true, questionNum: true,
      marksAwarded: true, marksAvailable: true,
      markingNotes: true,
      studentAnswer: true, answer: true,
      syllabusTopic: true,
      pageIndex: true,
      yStartPct: true, yEndPct: true,
      xStartPct: true, xEndPct: true,
      printableBounds: true,
    },
    orderBy: { orderIndex: "asc" },
  });
  for (const q of qs) {
    console.log(`Q${q.questionNum} [${q.syllabusTopic}]`);
    console.log(`  page=${q.pageIndex} y=${q.yStartPct?.toFixed(2)}-${q.yEndPct?.toFixed(2)}% x=${q.xStartPct?.toFixed(2)}-${q.xEndPct?.toFixed(2)}%`);
    console.log(`  expected="${q.answer}" student="${q.studentAnswer}"`);
    console.log(`  notes="${(q.markingNotes ?? "").slice(0, 200)}"`);
    console.log(`  ${q.marksAwarded ?? "-"}/${q.marksAvailable}`);
    console.log("");
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
