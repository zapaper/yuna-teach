// Re-mark a SINGLE question on a paper, leaving every other question's
// marks/notes untouched. Useful when:
//   - you want to validate a marking-logic change against one known
//     problem question without paying for a full re-mark
//   - the parent flagged a specific Q and you don't want a 60-second
//     full re-mark blocking the page
//
// Strategy: temporarily reset only the target question's
// marksAwarded/markingNotes/studentAnswer to null, then call the
// appropriate per-paperType marker. Most markers iterate every
// question regardless — to bound the work to one Q we use a
// per-question DB write-through that skips already-marked rows. The
// markQuiz/markExam paths handle marksAwarded=null as "mark me", so
// we end up only paying for the cleared question.
//
// Usage:
//   DATABASE_URL=... npx tsx scripts/_remark-single-question.ts <paperId> <questionNum>
//
// Example:
//   DATABASE_URL=... npx tsx scripts/_remark-single-question.ts cmq66nqks004lafidm8wltpyc 35

import { prisma } from "../src/lib/db";
import { markExamPaper, markQuizPaper, markFocusedTest } from "../src/lib/marking";

(async () => {
  const PAPER = process.argv[2];
  const QNUM = process.argv[3];
  if (!PAPER || !QNUM) {
    console.error("usage: _remark-single-question.ts <paperId> <questionNum>");
    process.exit(1);
  }

  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER },
    select: { id: true, title: true, paperType: true, subject: true },
  });
  if (!paper) {
    console.error("paper not found");
    process.exit(1);
  }

  // Find the target question(s) — could be Q35 plus subparts Q35a /
  // Q35bc etc. when the extractor split a multi-part question. Match
  // by questionNum prefix so all siblings get re-marked together.
  const targets = await prisma.examQuestion.findMany({
    where: {
      examPaperId: PAPER,
      OR: [
        { questionNum: QNUM },
        { questionNum: { startsWith: `${QNUM}a` } },
        { questionNum: { startsWith: `${QNUM}b` } },
        { questionNum: { startsWith: `${QNUM}c` } },
        { questionNum: { startsWith: `${QNUM}d` } },
      ],
    },
    select: {
      id: true,
      questionNum: true,
      marksAwarded: true,
      markingNotes: true,
      studentAnswer: true,
    },
  });
  if (targets.length === 0) {
    console.error(`No questions matching Q${QNUM} on paper ${PAPER}`);
    process.exit(1);
  }

  console.log(`Paper: "${paper.title}" (${paper.paperType ?? "exam"}, subject=${paper.subject})`);
  console.log(`Targets (${targets.length}):`);
  for (const t of targets) {
    console.log(`  Q${t.questionNum} — was ${t.marksAwarded === null ? "unmarked" : `marksAwarded=${t.marksAwarded}`}`);
  }

  // Snapshot every OTHER question's marks/notes so we can restore them
  // after the marker runs. This is the trick that turns a full re-mark
  // into a "single Q" re-mark: the marker will mark every question
  // that has marksAwarded=null, but we restore the saved values for
  // everything except our targets immediately after.
  const others = await prisma.examQuestion.findMany({
    where: {
      examPaperId: PAPER,
      id: { notIn: targets.map(t => t.id) },
    },
    select: {
      id: true,
      questionNum: true,
      marksAwarded: true,
      markingNotes: true,
      studentAnswer: true,
    },
  });
  console.log(`Snapshotted ${others.length} other questions to restore after the re-mark.`);

  // Clear the targets so the marker re-processes them.
  await prisma.examQuestion.updateMany({
    where: { id: { in: targets.map(t => t.id) } },
    data: { marksAwarded: null, markingNotes: null, studentAnswer: null },
  });
  console.log(`Cleared ${targets.length} target question(s).`);

  // Run the appropriate marker. The single-Q optimisation only works
  // if the marker SKIPS already-marked rows — markExamPaper /
  // markQuizPaper / markFocusedTest all do that today (they check
  // marksAwarded != null before re-processing).
  console.log(`Re-marking via ${paper.paperType ?? "exam"} pipeline…`);
  if (paper.paperType === "quiz") await markQuizPaper(PAPER);
  else if (paper.paperType === "focused") await markFocusedTest(PAPER);
  else await markExamPaper(PAPER);

  // Restore every OTHER question's prior state (in case the marker
  // touched them despite the marksAwarded guard).
  let restored = 0;
  for (const o of others) {
    const current = await prisma.examQuestion.findUnique({
      where: { id: o.id },
      select: { marksAwarded: true, markingNotes: true, studentAnswer: true },
    });
    if (!current) continue;
    if (
      current.marksAwarded !== o.marksAwarded ||
      current.markingNotes !== o.markingNotes ||
      current.studentAnswer !== o.studentAnswer
    ) {
      await prisma.examQuestion.update({
        where: { id: o.id },
        data: {
          marksAwarded: o.marksAwarded,
          markingNotes: o.markingNotes,
          studentAnswer: o.studentAnswer,
        },
      });
      restored++;
    }
  }
  console.log(`Restored ${restored} other question(s) to pre-run state.`);

  // Print the new state for the targets.
  const after = await prisma.examQuestion.findMany({
    where: { id: { in: targets.map(t => t.id) } },
    select: { questionNum: true, marksAwarded: true, marksAvailable: true, studentAnswer: true, markingNotes: true },
    orderBy: { orderIndex: "asc" },
  });
  console.log(`\nResult:`);
  for (const a of after) {
    console.log(`  Q${a.questionNum}: ${a.marksAwarded ?? "(null)"} / ${a.marksAvailable ?? "?"}`);
    if (a.studentAnswer) console.log(`    studentAnswer: ${a.studentAnswer.slice(0, 300)}`);
    if (a.markingNotes) console.log(`    markingNotes:  ${a.markingNotes.slice(0, 500)}`);
  }

  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
