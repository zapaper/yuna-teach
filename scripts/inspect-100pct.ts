import { prisma } from "../src/lib/db";
(async () => {
  const ID = "cmopk27fx0001102os8w2nffp";
  const p = await prisma.examPaper.findUnique({
    where: { id: ID },
    select: { id: true, title: true, subject: true, paperType: true, score: true, totalMarks: true, completedAt: true, markingStatus: true, metadata: true },
  });
  console.log("paper:", { ...p, metadata: undefined });
  const meta = p?.metadata as Record<string, unknown> | null;
  console.log("metadata keys:", meta ? Object.keys(meta) : "(none)");
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: ID },
    orderBy: { orderIndex: "asc" },
    select: { questionNum: true, marksAwarded: true, marksAvailable: true, studentAnswer: true, answer: true },
  });
  let totalAwarded = 0, totalAvailable = 0;
  for (const q of qs) {
    totalAwarded += q.marksAwarded ?? 0;
    totalAvailable += q.marksAvailable ?? 0;
  }
  console.log(`\n${qs.length} questions: sum awarded=${totalAwarded}  sum available=${totalAvailable}`);
  for (const q of qs) {
    const status = q.marksAwarded === q.marksAvailable && q.marksAvailable !== null ? "✓" : (q.marksAwarded ?? 0) > 0 ? "~" : "✗";
    console.log(`  ${status} Q${q.questionNum}  ${q.marksAwarded}/${q.marksAvailable}  student="${(q.studentAnswer ?? "").slice(0, 50)}"  key="${(q.answer ?? "").slice(0, 50)}"`);
  }
  await prisma.$disconnect();
})();
