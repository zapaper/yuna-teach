import { prisma } from "../src/lib/db";

(async () => {
  const PAPER = "cmpxyp365006a129kgli3irnf";
  const p = await prisma.examPaper.findUnique({
    where: { id: PAPER },
    select: {
      id: true, title: true, subject: true, paperType: true,
      markingStatus: true, completedAt: true, score: true, totalMarks: true,
      sourceExamId: true, assignedToId: true, userId: true,
      assignedTo: { select: { name: true } },
      user: { select: { name: true } },
    },
  });
  if (!p) { console.log("paper not found"); return; }
  console.log(`paper: ${p.title}`);
  console.log(`  subject=${p.subject}  paperType=${p.paperType}`);
  console.log(`  status=${p.markingStatus}  score=${p.score}/${p.totalMarks}`);
  console.log(`  completedAt=${p.completedAt?.toISOString()}`);
  console.log(`  assignedTo=${p.assignedTo?.name}  owner=${p.user?.name}`);

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER },
    select: {
      questionNum: true,
      answer: true,
      studentAnswer: true,
      marksAwarded: true,
      marksAvailable: true,
      markingNotes: true,
      syllabusTopic: true,
      transcribedOptions: true,
    },
    orderBy: { orderIndex: "asc" },
  });
  console.log(`\nQuestions (${qs.length}):`);
  let total = 0, awarded = 0;
  for (const q of qs) {
    total += q.marksAvailable ?? 0;
    awarded += q.marksAwarded ?? 0;
    const opts = q.transcribedOptions as string[] | null;
    const isMcq = Array.isArray(opts) && opts.length === 4;
    console.log(`  Q${q.questionNum.padEnd(4)} ${(isMcq ? "MCQ" : "OEQ").padEnd(3)} ${q.marksAwarded ?? "(null)"} / ${q.marksAvailable ?? "?"}  key=${(q.answer ?? "").slice(0, 40)}  student=${(q.studentAnswer ?? "(none)").slice(0, 80)}`);
    if (q.markingNotes) {
      const lines = q.markingNotes.split("\n").slice(0, 3).join(" | ");
      console.log(`      notes: ${lines.slice(0, 250)}`);
    }
  }
  console.log(`\nSum awarded=${awarded} / sum available=${total}  (paper.score=${p.score}, paper.totalMarks=${p.totalMarks})`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
