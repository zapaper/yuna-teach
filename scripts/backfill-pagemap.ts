// Backfill metadata.oeqPageMap on an existing clone from each
// question's printableBounds. Lets the review page show the right
// scanned image per question without having to re-scan or re-mark.
//
// Usage:
//   npx tsx scripts/backfill-pagemap.ts <paperId> [<paperId> ...]

import { prisma } from "../src/lib/db";
import { Prisma } from "@prisma/client";

async function backfillOne(id: string) {
  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: { id: true, title: true, metadata: true },
  });
  if (!paper) {
    console.error(`[backfill] not found: ${id}`);
    return;
  }
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: id },
    select: { id: true, questionNum: true, printableBounds: true },
  });
  const pageMap: Record<string, number> = {};
  let withBounds = 0;
  for (const q of qs) {
    const b = q.printableBounds as { pageIndex?: number } | null | undefined;
    if (b && typeof b.pageIndex === "number" && Number.isFinite(b.pageIndex)) {
      pageMap[q.id] = b.pageIndex + 1;
      withBounds++;
    }
  }
  if (withBounds === 0) {
    console.warn(`[backfill] ${id} (${paper.title}): no questions have printableBounds — nothing to write. Was this paper ever printed via the printable route?`);
    return;
  }
  const meta = (paper.metadata ?? {}) as Record<string, unknown>;
  await prisma.examPaper.update({
    where: { id },
    data: { metadata: { ...meta, oeqPageMap: pageMap } as Prisma.InputJsonValue },
  });
  console.log(`[backfill] ${id} (${paper.title}): wrote oeqPageMap for ${withBounds}/${qs.length} questions.`);
}

(async () => {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    console.error("Usage: npx tsx scripts/backfill-pagemap.ts <paperId> [<paperId> ...]");
    process.exit(1);
  }
  for (const id of ids) await backfillOne(id);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
