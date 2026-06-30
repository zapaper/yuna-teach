// Duplicate David Lim's English papers (and their questions) onto
// student67 so the radar / Lumi flow has a second populated kid for
// testing without touching real student data.
//
// Idempotent — skips any paper whose title already exists for
// student67 with the same sourceExamId. Dry-run by default; pass
// --apply to commit.

import { prisma } from "@/lib/db";

const DAVID_ID = "cmm5wf91d000ryrxwaddlo6xh";
const STUDENT67_ID = "cmqg8upha0000l3ijfr3co6t8";

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "── APPLY mode ──\n" : "── DRY RUN (pass --apply to commit) ──\n");

  const davidPapers = await prisma.examPaper.findMany({
    where: {
      assignedToId: DAVID_ID,
      subject: { contains: "english", mode: "insensitive" },
    },
    include: { questions: true },
  });
  console.log(`David's English papers: ${davidPapers.length}`);

  // Build a set of paper-identifying keys student67 already has so we
  // don't double-clone on repeated runs.
  const existing = await prisma.examPaper.findMany({
    where: {
      assignedToId: STUDENT67_ID,
      subject: { contains: "english", mode: "insensitive" },
    },
    select: { title: true, sourceExamId: true },
  });
  const have = new Set(existing.map(p => `${p.title}::${p.sourceExamId ?? ""}`));
  const toClone = davidPapers.filter(p => !have.has(`${p.title}::${p.sourceExamId ?? ""}`));
  console.log(`Already on student67: ${existing.length}.  To clone: ${toClone.length}\n`);

  if (toClone.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  for (const p of toClone) {
    console.log(`  ${p.id} → clone for student67: ${p.title}  (${p.questions.length} Qs)`);
    if (!apply) continue;
    await prisma.examPaper.create({
      data: {
        title: p.title,
        subject: p.subject,
        level: p.level,
        examType: p.examType,
        year: p.year,
        userId: p.userId,
        assignedToId: STUDENT67_ID,
        paperType: p.paperType,
        sourceExamId: p.sourceExamId,
        pageCount: p.pageCount,
        extractionStatus: p.extractionStatus,
        markingStatus: p.markingStatus,
        score: p.score,
        feedbackSummary: p.feedbackSummary,
        timeSpentSeconds: p.timeSpentSeconds,
        instantFeedback: p.instantFeedback,
        isRevision: p.isRevision,
        totalMarks: p.totalMarks,
        completedAt: p.completedAt,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        metadata: p.metadata as any,
        questions: {
          create: p.questions.map(q => ({
            questionNum: q.questionNum,
            pageIndex: q.pageIndex,
            orderIndex: q.orderIndex,
            yStartPct: q.yStartPct,
            yEndPct: q.yEndPct,
            xStartPct: q.xStartPct,
            xEndPct: q.xEndPct,
            printableBounds: q.printableBounds as never,
            marksAwarded: q.marksAwarded,
            marksAvailable: q.marksAvailable,
            markingNotes: q.markingNotes,
            syllabusTopic: q.syllabusTopic,
            subTopic: q.subTopic,
            skillTags: q.skillTags,
            studentAnswer: q.studentAnswer,
            elaboration: q.elaboration,
            answer: q.answer,
            answerImageData: q.answerImageData,
            imageData: q.imageData,
            transcribedStem: q.transcribedStem,
            transcribedOptions: q.transcribedOptions as never,
            transcribedOptionImages: q.transcribedOptionImages as never,
            transcribedOptionTable: q.transcribedOptionTable as never,
            transcribedSubparts: q.transcribedSubparts as never,
            diagramBounds: q.diagramBounds as never,
            diagramImageData: q.diagramImageData,
            sourceQuestionId: q.sourceQuestionId,
            difficulty: q.difficulty,
          })),
        },
      },
    });
  }
  console.log(`\nDone.`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
