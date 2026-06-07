import { prisma } from "../src/lib/db";
const PAPER = "cmq37z11b0028cyy0pj3zeydm";
async function main() {
  const p = await prisma.examPaper.findUnique({
    where: { id: PAPER },
    select: { id: true, title: true, subject: true, score: true, totalMarks: true, paperType: true, pageCount: true, metadata: true },
  });
  console.log("Paper:", JSON.stringify({ ...p, metadata: undefined }, null, 2));
  const meta = p?.metadata as Record<string, unknown> | null;
  console.log("metadata keys:", Object.keys(meta ?? {}));

  // Look for submissionIndexMap / page-offset hints in metadata
  for (const k of Object.keys(meta ?? {})) {
    if (k.toLowerCase().includes("page") || k.toLowerCase().includes("scan") || k.toLowerCase().includes("submission")) {
      console.log(`metadata.${k}:`, JSON.stringify((meta as Record<string, unknown>)[k]).slice(0, 200));
    }
  }

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER, questionNum: { in: ["1", "2"] } },
    select: { id: true, questionNum: true, pageIndex: true, yStartPct: true, yEndPct: true, marksAwarded: true, marksAvailable: true, markingNotes: true },
  });
  console.log("\nQuestions 1 & 2:");
  for (const q of qs) {
    console.log(`\nQ${q.questionNum} (id=${q.id})`);
    console.log(`  pageIndex=${q.pageIndex}  y=${q.yStartPct}–${q.yEndPct}`);
    console.log(`  marks: ${q.marksAwarded}/${q.marksAvailable}`);
    console.log(`  notes: ${(q.markingNotes ?? "").slice(0, 300)}`);
  }
  process.exit(0);
}
main();
