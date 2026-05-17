import { prisma } from "../src/lib/db";

const PAPER_ID = "cmomkbljz000z9wmzuuxu4yoz";

async function main() {
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: {
      id: true, title: true, subject: true, level: true, paperType: true,
      sourceExamId: true, completedAt: true, markingStatus: true,
      score: true, totalMarks: true,
      questions: { orderBy: { orderIndex: "asc" }, select: {
        id: true, questionNum: true, marksAwarded: true, marksAvailable: true,
        markingNotes: true, studentAnswer: true, answer: true,
        transcribedStem: true, transcribedSubparts: true, syllabusTopic: true,
        sourceQuestionId: true,
      } },
    },
  });
  if (!paper) { console.log("not found"); await prisma.$disconnect(); return; }
  console.log(`Paper: ${paper.title} (${paper.id})`);
  console.log(`  source=${paper.sourceExamId ?? "none"}, marking=${paper.markingStatus}, score=${paper.score}/${paper.totalMarks}`);
  console.log();
  for (const q of paper.questions) {
    console.log(`── Q${q.questionNum}  ${q.marksAwarded ?? "?"}/${q.marksAvailable ?? "?"}  topic="${q.syllabusTopic ?? ""}"`);
    if (q.transcribedStem) console.log(`  stem: ${q.transcribedStem.slice(0, 200).replace(/\s+/g, " ")}${q.transcribedStem.length > 200 ? "…" : ""}`);
    if (q.transcribedSubparts) console.log(`  subparts: ${JSON.stringify(q.transcribedSubparts).slice(0, 220)}`);
    if (q.studentAnswer) console.log(`  studentAnswer: ${q.studentAnswer.slice(0, 240).replace(/\s+/g, " ")}`);
    if (q.answer) console.log(`  answer: ${q.answer.slice(0, 200).replace(/\s+/g, " ")}`);
    if (q.markingNotes) console.log(`  notes: ${q.markingNotes.slice(0, 600).replace(/\s+/g, " ")}`);
    console.log();
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
