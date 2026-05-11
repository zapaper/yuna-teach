// Dump the per-question state for a scanned-back clone so we can
// diagnose review-page issues — what oeqPageMap says, what
// printableBounds say, what the marker recorded as studentAnswer
// / marksAwarded / markingNotes.
//
// Usage: npx tsx scripts/dump-quiz-state.ts <paperId>

import { prisma } from "../src/lib/db";
import { pickScanFileIndex } from "../src/lib/page-map";

(async () => {
  const id = process.argv[2];
  if (!id) { console.error("usage: dump-quiz-state.ts <paperId>"); process.exit(1); }

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: {
      id: true, title: true, paperType: true,
      markingStatus: true, score: true, completedAt: true,
      metadata: true,
      questions: {
        orderBy: { orderIndex: "asc" },
        select: {
          id: true, questionNum: true, marksAvailable: true,
          marksAwarded: true, studentAnswer: true, markingNotes: true,
          printableBounds: true, transcribedSubparts: true,
        },
      },
    },
  });
  if (!paper) { console.error("Paper not found"); process.exit(1); }

  const meta = (paper.metadata ?? {}) as Record<string, unknown>;
  const pageMap = (meta.oeqPageMap ?? {}) as Record<string, number>;

  console.log(`Paper: ${paper.title}  (${paper.paperType})`);
  console.log(`Status: ${paper.markingStatus}  score=${paper.score}  completedAt=${paper.completedAt?.toISOString() ?? "null"}`);
  console.log(`oeqPageMap entries: ${Object.keys(pageMap).length}`);
  console.log();
  console.log("Per-question state:");
  for (const q of paper.questions) {
    const bounds = q.printableBounds as { pageIndex?: number; subparts?: Record<string, { pageIndex?: number }> } | null;
    const subs = q.transcribedSubparts as Array<{ label?: string }> | null;
    const realSubs = (subs ?? []).filter(s => s.label && !s.label.startsWith("_"));
    const mapVal = pageMap[q.id] ?? null;
    const computedVal = pickScanFileIndex(bounds as Parameters<typeof pickScanFileIndex>[0]);
    const subBoundsList = bounds?.subparts
      ? Object.entries(bounds.subparts).map(([k, v]) => `${k}:p${v.pageIndex}`).join(", ")
      : "(none)";
    console.log(
      `  Q${q.questionNum}  subs=${realSubs.length}  bounds.pageIdx=${bounds?.pageIndex ?? "—"}  ` +
      `subBounds={${subBoundsList}}  ` +
      `pageMap=${mapVal}  computed=${computedVal}  ` +
      `marks=${q.marksAwarded ?? "—"}/${q.marksAvailable ?? "—"}  ` +
      `studentAns="${(q.studentAnswer ?? "").slice(0, 50)}"  notes="${(q.markingNotes ?? "").slice(0, 60)}"`,
    );
  }
  await prisma.$disconnect();
})().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
