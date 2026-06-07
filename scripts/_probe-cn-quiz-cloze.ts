import { prisma } from "../src/lib/db";
async function main() {
  const id = "cmq0tgcuc00011e0qqv3pfcjc";
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: id, syllabusTopic: { contains: "短文填空" } },
    select: {
      questionNum: true, syllabusTopic: true,
      marksAwarded: true, marksAvailable: true,
      markingNotes: true, studentAnswer: true, answer: true,
      pageIndex: true, yStartPct: true, yEndPct: true, xStartPct: true, xEndPct: true,
    },
    orderBy: { orderIndex: "asc" },
  });
  for (const q of qs) {
    console.log(`Q${q.questionNum} expected="${q.answer}" student="${q.studentAnswer}" → ${q.marksAwarded}/${q.marksAvailable}`);
    console.log(`  page=${q.pageIndex} y=${q.yStartPct?.toFixed(2)}-${q.yEndPct?.toFixed(2)}% x=${q.xStartPct?.toFixed(2) ?? "—"}-${q.xEndPct?.toFixed(2) ?? "—"}%`);
    console.log(`  notes="${(q.markingNotes ?? "").slice(0, 120)}"`);
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
