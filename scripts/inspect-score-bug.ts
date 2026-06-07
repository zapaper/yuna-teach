import { prisma } from "../src/lib/db";

async function main() {
  const examId = "cmpotj8s9002htpp9w3ywgbgb";
  const exam = await prisma.examPaper.findUnique({
    where: { id: examId },
    select: {
      id: true,
      title: true,
      subject: true,
      score: true,
      paperType: true,
      questions: {
        select: {
          id: true,
          questionNum: true,
          marksAvailable: true,
          marksAwarded: true,
          syllabusTopic: true,
        },
        orderBy: [{ pageIndex: "asc" }, { orderIndex: "asc" }],
      },
    },
  });
  if (!exam) {
    console.log("Exam not found");
    return;
  }

  console.log(`Exam: ${exam.title}`);
  console.log(`Score field: ${exam.score}`);
  console.log(`paperType: ${exam.paperType}`);
  console.log(`Total questions: ${exam.questions.length}`);
  console.log();

  let totalAvailable = 0;
  let totalAwarded = 0;
  for (const q of exam.questions) {
    totalAvailable += q.marksAvailable ?? 0;
    totalAwarded += q.marksAwarded ?? 0;
  }
  console.log(`Sum of marksAvailable: ${totalAvailable}`);
  console.log(`Sum of marksAwarded:   ${totalAwarded}`);
  console.log();

  console.log("Per-question marks:");
  for (const q of exam.questions) {
    const flag = (q.marksAvailable ?? 0) !== Math.round(q.marksAvailable ?? 0) || (q.marksAvailable ?? 0) > 5 ? "  ⚠" : "";
    console.log(`  Q${q.questionNum.padEnd(8)} avail=${String(q.marksAvailable).padStart(4)}  awarded=${String(q.marksAwarded).padStart(4)}${flag}  topic=${q.syllabusTopic ?? "—"}`);
  }
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
