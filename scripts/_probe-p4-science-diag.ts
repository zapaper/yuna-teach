import { prisma } from "@/lib/db";

const PAPER_ID = "cmr294m3c000z26em59stibzi";

async function main() {
  const p = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: { id: true, title: true, level: true, markingStatus: true, metadata: true, createdAt: true, assignedToId: true },
  });
  console.log("Paper:", p);
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID },
    select: { questionNum: true, syllabusTopic: true, marksAwarded: true, marksAvailable: true, sourceQuestionId: true },
    orderBy: { orderIndex: "asc" },
  });
  console.log(`\n${qs.length} questions:`);
  const byTopic = new Map<string, number>();
  for (const q of qs) {
    console.log(`  Q${q.questionNum}  topic=${q.syllabusTopic ?? "?"}  ${q.marksAwarded ?? "-"}/${q.marksAvailable ?? "-"}`);
    const t = q.syllabusTopic ?? "(null)";
    byTopic.set(t, (byTopic.get(t) ?? 0) + 1);
  }
  console.log(`\nTopic breakdown:`);
  for (const [t, n] of [...byTopic.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n}  ${t}`);
  }

  // Level-specific tagged science pool
  console.log(`\n\nP4 Science MCQ pool (subTopic sanity check):`);
  const rows = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        subject: { contains: "science", mode: "insensitive" },
        paperType: null,
        visible: true,
        level: "Primary 4",
      },
      sourceQuestionId: null,
    },
    select: { syllabusTopic: true },
  });
  const bySt = new Map<string, number>();
  for (const r of rows) bySt.set(r.syllabusTopic ?? "(null)", (bySt.get(r.syllabusTopic ?? "(null)") ?? 0) + 1);
  console.log(`P4 Science masters: ${rows.length}`);
  for (const [t, n] of [...bySt.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n}  ${t}`);
  }
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
