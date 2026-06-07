// Inspect the question the user flagged with broken image / writing gap.
// Exam: cmo9extsd0001bmmiga5bn558
// Question: cmoa58cnv0001dqlpzxig1g7v

import { prisma } from "../src/lib/db";

(async () => {
  const paper = await prisma.examPaper.findUnique({
    where: { id: "cmo9extsd0001bmmiga5bn558" },
    select: {
      id: true, title: true, subject: true, level: true,
      paperType: true, sourceExamId: true, examType: true,
      assignedToId: true, userId: true,
      extractionStatus: true,
      metadata: true,
      questions: { select: { id: true, questionNum: true }, orderBy: { orderIndex: "asc" } },
    },
  });
  console.log("=== Paper ===");
  console.log(JSON.stringify({
    id: paper?.id, title: paper?.title, subject: paper?.subject, level: paper?.level,
    paperType: paper?.paperType, sourceExamId: paper?.sourceExamId, examType: paper?.examType,
    extractionStatus: paper?.extractionStatus,
    metadata: paper?.metadata,
    questionCount: paper?.questions.length,
  }, null, 2));

  const q = await prisma.examQuestion.findUnique({
    where: { id: "cmoa58cnv0001dqlpzxig1g7v" },
    select: {
      id: true, questionNum: true, marksAvailable: true, marksAwarded: true,
      syllabusTopic: true, subTopic: true, answer: true, studentAnswer: true,
      transcribedStem: true, transcribedOptions: true, transcribedOptionImages: true,
      transcribedSubparts: true, transcribedOptionTable: true,
      // Image fields — check sizes
      imageData: true, answerImageData: true, diagramImageData: true, diagramBounds: true,
      sourceQuestionId: true,
      elaboration: true,
    },
  });
  if (!q) { console.log("Question not found"); return; }
  console.log("\n=== Question ===");
  console.log(`id: ${q.id}`);
  console.log(`questionNum: ${q.questionNum}`);
  console.log(`syllabusTopic: ${q.syllabusTopic}`);
  console.log(`subTopic: ${q.subTopic}`);
  console.log(`marks: ${q.marksAvailable} (awarded: ${q.marksAwarded})`);
  console.log(`sourceQuestionId: ${q.sourceQuestionId ?? "(none)"}`);
  console.log(`\nImage data sizes:`);
  console.log(`  imageData: ${q.imageData ? `${q.imageData.length} chars (${q.imageData.slice(0, 40)}...)` : "(null)"}`);
  console.log(`  answerImageData: ${q.answerImageData ? `${q.answerImageData.length} chars` : "(null)"}`);
  console.log(`  diagramImageData: ${q.diagramImageData ? `${q.diagramImageData.length} chars` : "(null)"}`);
  console.log(`  diagramBounds: ${JSON.stringify(q.diagramBounds)}`);

  console.log(`\nTranscribed:`);
  console.log(`  stem: ${(q.transcribedStem ?? "(null)").slice(0, 200)}`);
  console.log(`  options (text): ${JSON.stringify(q.transcribedOptions)}`);
  console.log(`  optionImages (truncated): ${Array.isArray(q.transcribedOptionImages) ? `[${q.transcribedOptionImages.length}] ${(q.transcribedOptionImages as unknown[]).map(o => o ? `${String(o).length}c` : "null").join(",")}` : "(null)"}`);
  console.log(`  subparts: ${JSON.stringify(q.transcribedSubparts).slice(0, 300)}`);
  console.log(`  optionTable: ${JSON.stringify(q.transcribedOptionTable).slice(0, 200)}`);
  console.log(`\nstudent answer (first 300 chars):\n  ${(q.studentAnswer ?? "(null)").slice(0, 300)}`);
  console.log(`\nanswer/marking scheme: ${(q.answer ?? "(null)").slice(0, 200)}`);

  // Source question if synthetic
  if (q.sourceQuestionId) {
    const src = await prisma.examQuestion.findUnique({
      where: { id: q.sourceQuestionId },
      select: {
        id: true, questionNum: true, transcribedStem: true,
        imageData: true, diagramImageData: true,
        examPaper: { select: { title: true } },
      },
    });
    console.log(`\n=== Source question ===`);
    console.log(`  paper: ${src?.examPaper.title}`);
    console.log(`  stem: ${(src?.transcribedStem ?? "").slice(0, 150)}`);
    console.log(`  imageData: ${src?.imageData ? `${src.imageData.length} chars` : "(null)"}`);
    console.log(`  diagramImageData: ${src?.diagramImageData ? `${src.diagramImageData.length} chars` : "(null)"}`);
  }

  await prisma.$disconnect();
})();
