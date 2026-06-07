import { prisma } from "../src/lib/db";

const CLONE_PREFIX = "cmpug10zi";

async function main() {
  const p = await prisma.examPaper.findFirst({
    where: { id: { startsWith: CLONE_PREFIX } },
    select: { id: true, title: true },
  });
  if (!p) { console.log("clone not found"); return; }
  console.log(`probing ${p.title} (${p.id})`);

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: p.id },
    orderBy: { orderIndex: "asc" },
    select: {
      questionNum: true, marksAvailable: true, marksAwarded: true,
      markingNotes: true, studentAnswer: true, answer: true,
    },
  });
  for (const q of qs) {
    const ansNorm = (q.answer ?? "").trim().replace(/[().]/g, "").trim();
    if (/^[1-4]$/.test(ansNorm) || /^[A-D]$/i.test(ansNorm)) continue; // skip MCQ
    console.log(`\n--- Q${q.questionNum}  ${q.marksAwarded}/${q.marksAvailable}m`);
    console.log(`  expected: ${(q.answer ?? "").slice(0, 200)}`);
    console.log(`  student : ${(q.studentAnswer ?? "(null)").slice(0, 200)}`);
    console.log(`  notes   : ${(q.markingNotes ?? "(null)").slice(0, 500)}`);
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
