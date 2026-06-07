import { prisma } from "../src/lib/db";
const PAPER = "cmq37z11b0028cyy0pj3zeydm";
async function main() {
  const p = await prisma.examPaper.findUnique({
    where: { id: PAPER },
    select: { id: true, pageCount: true, submissionPageCount: true, metadata: true },
  });
  const meta = p?.metadata as Record<string, unknown> | null;
  console.log("pageCount:", p?.pageCount);
  console.log("submissionPageCount:", p?.submissionPageCount);
  console.log("metadata.skipPages length:", (meta?.skipPages as number[] | undefined)?.length);
  console.log("metadata.answerPages length:", (meta?.answerPages as number[] | undefined)?.length);
  // Compute non-hidden count
  const skipPages = (meta?.skipPages ?? []) as number[];
  const answerPages = (meta?.answerPages ?? []) as number[];
  const hidden = new Set([...skipPages, ...answerPages].map(p => p - 1));
  let nonHidden = 0;
  for (let i = 0; i < (p?.pageCount ?? 0); i++) if (!hidden.has(i)) nonHidden++;
  console.log("Non-hidden pages:", nonHidden);
  console.log("If student scanned EVERY page → submissionPageCount should equal", p?.pageCount);
  console.log("If student scanned NON-HIDDEN only → submissionPageCount should equal", nonHidden);
  process.exit(0);
}
main();
