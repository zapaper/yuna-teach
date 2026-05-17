import { prisma } from "../src/lib/db";

async function main() {
  const student = await prisma.user.findFirst({
    where: { name: { contains: "Mark", mode: "insensitive" }, role: "STUDENT" },
    select: { id: true, name: true },
  });
  if (!student) { console.log("No Mark"); return; }
  console.log(`Student: ${student.name} (${student.id})`);

  // Most recent diagnostic paper assigned to or created for Mark Lim
  const papers = await prisma.examPaper.findMany({
    where: {
      paperType: "diagnostic",
      OR: [
        { assignedToId: student.id },
        { metadata: { path: ["studentName"], string_contains: student.name } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { id: true, title: true, createdAt: true, assignedToId: true, score: true, totalMarks: true, markingStatus: true },
  });
  console.log(`\nDiagnostic papers (most recent first):`);
  for (const p of papers) {
    console.log(`  ${p.id} · ${p.title} · ${p.createdAt.toISOString()} · status=${p.markingStatus} · ${p.score}/${p.totalMarks}`);
  }

  if (papers.length === 0) return;

  const latest = papers[0];
  console.log(`\n=== Latest: ${latest.id} ===`);
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: latest.id },
    orderBy: { orderIndex: "asc" },
    select: { id: true, questionNum: true, transcribedStem: true, transcribedOptions: true, answer: true, studentAnswer: true, marksAwarded: true, marksAvailable: true, markingNotes: true, syllabusTopic: true },
  });
  for (const q of qs.slice(0, 8)) {
    console.log(`\n  Q${q.questionNum} [${q.syllabusTopic}] — ${q.marksAwarded}/${q.marksAvailable}`);
    console.log(`    student: ${JSON.stringify(q.studentAnswer)}, expected: ${q.answer}`);
    console.log(`    notes: ${q.markingNotes?.slice(0, 400)}`);
  }
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
