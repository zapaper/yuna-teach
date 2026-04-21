// Inspect a specific exam + its Q4 to help diagnose old-vs-new quiz format.
// Run: npx tsx scripts/check-exam-q4.ts <examId>

import { prisma } from "@/lib/db";

async function main() {
  const examId = process.argv[2] || "cmnybdsi0000nhswgfizri3y6";
  const exam = await prisma.examPaper.findUnique({
    where: { id: examId },
    select: {
      id: true,
      title: true,
      subject: true,
      level: true,
      paperType: true,
      sourceExamId: true,
      createdAt: true,
      updatedAt: true,
      markingStatus: true,
      questions: {
        where: { questionNum: { in: ["4", "4a", "4b", "4(a)", "4(b)", "Q4"] } },
        select: {
          id: true,
          questionNum: true,
          orderIndex: true,
          transcribedStem: true,
          transcribedOptions: true,
          transcribedSubparts: true,
          answer: true,
          syllabusTopic: true,
          sourceQuestionId: true,
          syntheticGenerated: true,
        },
      },
    },
  });

  if (!exam) {
    console.log("Exam not found:", examId);
    return;
  }

  console.log("=== EXAM ===");
  console.log({
    id: exam.id,
    title: exam.title,
    subject: exam.subject,
    level: exam.level,
    paperType: exam.paperType,
    sourceExamId: exam.sourceExamId,
    createdAt: exam.createdAt,
    updatedAt: exam.updatedAt,
    markingStatus: exam.markingStatus,
  });

  console.log("\n=== Q4 candidates ===");
  for (const q of exam.questions) {
    console.log({
      id: q.id,
      questionNum: q.questionNum,
      stemLen: q.transcribedStem?.length ?? 0,
      stemPreview: q.transcribedStem?.slice(0, 200),
      hasOptions: !!q.transcribedOptions,
      hasSubparts: !!q.transcribedSubparts,
      subpartCount: Array.isArray(q.transcribedSubparts) ? q.transcribedSubparts.length : 0,
      answer: q.answer?.slice(0, 100),
      topic: q.syllabusTopic,
      synthetic: q.syntheticGenerated,
      sourceQuestionId: q.sourceQuestionId,
    });
  }
}

main().finally(() => prisma.$disconnect());
