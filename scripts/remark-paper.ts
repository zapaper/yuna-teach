import { prisma } from "../src/lib/db";
import { Prisma } from "@prisma/client";
import { markQuizPaper, markExamPaper, markFocusedTest } from "../src/lib/marking";

(async () => {
  const ID = process.argv[2];
  if (!ID) { console.error("usage: remark-paper.ts <paperId>"); process.exit(1); }
  const p = await prisma.examPaper.findUnique({
    where: { id: ID },
    select: { paperType: true, score: true, markingStatus: true, title: true },
  });
  if (!p) { console.error("paper not found"); process.exit(1); }

  // Backfill oeqPageMap from each question's printableBounds (with
  // cover offset) so the review page shows the correct scan image
  // for each question. New scan-submit runs already do this; running
  // remark-paper.ts on an older clone wires it in without a re-scan.
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: ID },
    select: { id: true, printableBounds: true },
  });
  const pageMap: Record<string, number> = {};
  for (const q of qs) {
    const b = q.printableBounds as { pageIndex?: number } | null | undefined;
    if (b && typeof b.pageIndex === "number" && Number.isFinite(b.pageIndex)) {
      pageMap[q.id] = b.pageIndex + 1;
    }
  }
  if (Object.keys(pageMap).length > 0) {
    const existing = await prisma.examPaper.findUnique({ where: { id: ID }, select: { metadata: true } });
    const meta = (existing?.metadata ?? {}) as Record<string, unknown>;
    await prisma.examPaper.update({
      where: { id: ID },
      data: { metadata: { ...meta, oeqPageMap: pageMap } as Prisma.InputJsonValue },
    });
    console.log(`Backfilled oeqPageMap for ${Object.keys(pageMap).length} questions.`);
  }

  console.log(`Re-marking "${p.title}"  type=${p.paperType}  was score=${p.score} status=${p.markingStatus}`);
  if (p.paperType === "quiz") await markQuizPaper(ID);
  else if (p.paperType === "focused") await markFocusedTest(ID);
  else await markExamPaper(ID);
  const after = await prisma.examPaper.findUnique({ where: { id: ID }, select: { score: true, markingStatus: true } });
  console.log(`done. score=${after?.score} status=${after?.markingStatus}`);
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
