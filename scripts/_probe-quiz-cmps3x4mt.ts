import { prisma } from "../src/lib/db";

async function main() {
  const id = "cmps3x4mt004l2nr7opoak80p";
  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: {
      id: true, title: true, subject: true, paperType: true, examType: true,
      sourceExamId: true, userId: true, assignedToId: true,
      markingStatus: true, score: true, totalMarks: true,
      feedbackSummary: true, completedAt: true, updatedAt: true,
      questions: {
        select: {
          id: true, questionNum: true, orderIndex: true,
          marksAvailable: true, marksAwarded: true,
          answer: true,
          studentAnswer: true,
          syllabusTopic: true,
          markingNotes: true,
          transcribedStem: true,
          transcribedOptions: true,
        },
        orderBy: { orderIndex: "asc" },
      },
    },
  });
  if (!paper) { console.log("not found"); return; }
  console.log("PAPER:", JSON.stringify({
    id: paper.id, title: paper.title, subject: paper.subject,
    paperType: paper.paperType, examType: paper.examType,
    status: paper.markingStatus, score: paper.score, totalMarks: paper.totalMarks,
    completedAt: paper.completedAt, updatedAt: paper.updatedAt, srcExam: paper.sourceExamId,
  }, null, 2));
  console.log("feedbackSummary:", paper.feedbackSummary);
  console.log("question count:", paper.questions.length);
  let sumAwarded = 0, sumAvail = 0;
  for (const q of paper.questions) {
    sumAvail += q.marksAvailable ?? 0;
    sumAwarded += q.marksAwarded ?? 0;
    const isMcq = Array.isArray(q.transcribedOptions) && (q.transcribedOptions as unknown[]).length > 0;
    console.log(`Q${q.questionNum} ${isMcq ? "[MCQ]" : "[OEQ]"} avail=${q.marksAvailable ?? "?"} awarded=${q.marksAwarded ?? "?"} topic=${q.syllabusTopic ?? "-"}`);
    console.log(`  stem="${(q.transcribedStem ?? "").slice(0,140)}"`);
    console.log(`  stu ="${(q.studentAnswer ?? "").slice(0,200)}"`);
    console.log(`  ans ="${(q.answer ?? "").slice(0,200)}"`);
    console.log(`  note="${(q.markingNotes ?? "").slice(0,250)}"`);
  }
  console.log(`SUM avail=${sumAvail} awarded=${sumAwarded}`);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
