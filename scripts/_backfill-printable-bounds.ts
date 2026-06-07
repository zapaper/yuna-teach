// Backfill printableBounds on questions of an already-printed exam paper.
// Uses the same algorithm as /api/exam/[id]/print: build originalPageIdx
// → printedPageIdx by dropping skipPages+answerPages, then stamp each
// question with { pageIndex: <new>, yStartPct, yEndPct }.
//
// Idempotent — skips questions that already have bounds.
import { prisma } from "../src/lib/db";

const PAPER = process.argv[2];
if (!PAPER) { console.log("Usage: tsx _backfill-printable-bounds.ts <paperId>"); process.exit(1); }

async function main() {
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER },
    select: { id: true, title: true, pageCount: true, metadata: true, sourceExamId: true },
  });
  if (!paper) { console.log("Paper not found"); process.exit(1); }
  console.log(`Paper: ${paper.title}`);
  console.log(`pageCount: ${paper.pageCount}`);

  // For clones inheriting metadata from source.
  let meta = paper.metadata as { answerPages?: number[]; skipPages?: number[] } | null;
  if (!meta?.answerPages && !meta?.skipPages && paper.sourceExamId) {
    const src = await prisma.examPaper.findUnique({
      where: { id: paper.sourceExamId }, select: { metadata: true },
    });
    meta = src?.metadata as { answerPages?: number[]; skipPages?: number[] } | null;
    console.log("(inherited metadata from source paper)");
  }
  const pagesToDrop = new Set<number>([
    ...(meta?.answerPages ?? []).map(p => p - 1),
    ...(meta?.skipPages ?? []).map(p => p - 1),
  ]);
  console.log(`Pages to drop (0-idx): ${[...pagesToDrop].sort((a,b)=>a-b).slice(0,8).join(",")}...(${pagesToDrop.size} total)`);

  const printedPageOf = new Map<number, number>();
  let printedIdx = 0;
  for (let i = 0; i < (paper.pageCount ?? 0); i++) {
    if (pagesToDrop.has(i)) continue;
    printedPageOf.set(i, printedIdx);
    printedIdx++;
  }
  console.log(`Printed pages: ${printedIdx} (0..${printedIdx - 1})`);

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER },
    select: { id: true, questionNum: true, pageIndex: true, yStartPct: true, yEndPct: true, printableBounds: true },
  });
  let stamped = 0, skipped = 0;
  for (const q of qs) {
    if (q.printableBounds) { skipped++; continue; }
    const printedPageIndex = printedPageOf.get(q.pageIndex);
    if (printedPageIndex === undefined) { skipped++; continue; }
    if (q.yStartPct == null || q.yEndPct == null) { skipped++; continue; }
    await prisma.examQuestion.update({
      where: { id: q.id },
      data: { printableBounds: { pageIndex: printedPageIndex, yStartPct: q.yStartPct, yEndPct: q.yEndPct } },
    });
    stamped++;
  }
  console.log(`\nStamped: ${stamped} / Skipped: ${skipped} / Total: ${qs.length}`);
  process.exit(0);
}
main();
