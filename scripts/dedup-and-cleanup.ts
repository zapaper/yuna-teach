// One-off cleanup:
//   (1) Delete the 6 duplicate ExamQuestion rows in 2 English master papers.
//   (2) Delete the 8 admin-generated "Test Quiz" papers for PSLE 2025 Math
//       (paperType = "quiz", left over from QA runs).
//
// Safety:
//   - Dry-run by default. Pass --write to actually delete.
//   - For (1): pick the canonical row as the OLDEST by id (cuid sorts
//     chronologically), then redirect any SyntheticQuestion children
//     of the EXTRA rows over to the canonical row before delete so we
//     don't lose synthetic variants.
//   - For (2): test quizzes have no SyntheticQuestion children (those
//     only attach to master-paper rows), so cascade delete is safe.
import { prisma } from "../src/lib/db";

async function main() {
  const write = process.argv.includes("--write");
  console.log(`Mode: ${write ? "WRITE" : "DRY-RUN"}\n`);

  // ─── Part 1 — English duplicate question rows ──────────────────
  console.log("=== Part 1: English duplicate ExamQuestion rows ===\n");
  const dupGroups = await prisma.examQuestion.groupBy({
    by: ["examPaperId", "questionNum"],
    where: { examPaper: { sourceExamId: null, paperType: null } },
    _count: { id: true },
    having: { id: { _count: { gt: 1 } } },
  });
  console.log(`Found ${dupGroups.length} duplicate group(s).`);
  let extrasDeleted = 0, syntheticsMoved = 0;
  for (const g of dupGroups) {
    const rows = await prisma.examQuestion.findMany({
      where: { examPaperId: g.examPaperId, questionNum: g.questionNum },
      orderBy: { id: "asc" },
      select: {
        id: true,
        examPaper: { select: { title: true } },
        _count: { select: { syntheticQuestions: true } },
        transcribedStem: true,
      },
    });
    const canonical = rows[0];
    const extras = rows.slice(1);
    console.log(`  [${canonical.examPaper.title}] Q${g.questionNum}: keeping ${canonical.id.slice(0, 10)}, dropping ${extras.length} extra(s)`);
    for (const extra of extras) {
      if (extra._count.syntheticQuestions > 0) {
        console.log(`    re-attaching ${extra._count.syntheticQuestions} synthetic(s) ${extra.id.slice(0, 10)} → ${canonical.id.slice(0, 10)}`);
        if (write) {
          await prisma.syntheticQuestion.updateMany({
            where: { sourceQuestionId: extra.id },
            data: { sourceQuestionId: canonical.id },
          });
        }
        syntheticsMoved += extra._count.syntheticQuestions;
      }
      if (write) {
        await prisma.examQuestion.delete({ where: { id: extra.id } });
      }
      extrasDeleted++;
    }
  }
  console.log(`  ${write ? "Deleted" : "Would delete"} ${extrasDeleted} extra row(s); ${write ? "moved" : "would move"} ${syntheticsMoved} synthetic(s)\n`);

  // ─── Part 2 — Admin Test Quiz papers for PSLE 2025 Math ────────
  console.log("=== Part 2: Admin Test Quiz papers (PSLE 2025 Math) ===\n");
  const testQuizzes = await prisma.examPaper.findMany({
    where: {
      title: { contains: "PSLE Mathematics 2025", mode: "insensitive" },
      paperType: "quiz",
    },
    select: { id: true, title: true, _count: { select: { questions: true } } },
  });
  console.log(`Found ${testQuizzes.length} test quiz paper(s).`);
  for (const p of testQuizzes) {
    console.log(`  ${p.id.slice(0, 12)}  qs=${p._count.questions}  ${p.title}`);
  }
  // Sanity check: ensure no Synthetic referencing these test-quiz questions.
  const testQuizQuestionIds = testQuizzes.length > 0
    ? (await prisma.examQuestion.findMany({
        where: { examPaperId: { in: testQuizzes.map(p => p.id) } },
        select: { id: true },
      })).map(q => q.id)
    : [];
  const syntheticsPointing = testQuizQuestionIds.length > 0
    ? await prisma.syntheticQuestion.count({ where: { sourceQuestionId: { in: testQuizQuestionIds } } })
    : 0;
  console.log(`  Synthetic rows pointing at test-quiz questions: ${syntheticsPointing} (expected 0)`);
  if (syntheticsPointing > 0) {
    console.log(`  ⚠️ Refusing to delete — there are ${syntheticsPointing} synthetic(s) tied to these test quizzes. Investigate first.`);
    return;
  }
  if (write && testQuizzes.length > 0) {
    const ids = testQuizzes.map(p => p.id);
    const res = await prisma.examPaper.deleteMany({ where: { id: { in: ids } } });
    console.log(`  Deleted ${res.count} paper(s) (questions cascaded).`);
  } else {
    console.log(`  ${write ? "(nothing to delete)" : "Would delete " + testQuizzes.length + " paper(s) (questions cascade)"}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
