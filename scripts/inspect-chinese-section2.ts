import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const PAPER_ID = process.argv[2] ?? "cmp87u5hq0001vlyjgj72eb6d";
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID }, select: { title: true, metadata: true },
  });
  const meta = paper?.metadata as Record<string, unknown> | null;
  const sectionOcr = meta?.sectionOcrTexts as Record<string, { ocrText?: string }> | undefined;
  console.log("--- 短文填空 passage OCR ---");
  console.log(sectionOcr?.["短文填空"]?.ocrText ?? "(none)");
  console.log("\n--- Q16-Q20 stored ---\n");
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID, syllabusTopic: { contains: "短文填空" } },
    orderBy: { orderIndex: "asc" },
    select: { questionNum: true, transcribedStem: true, transcribedOptions: true, answer: true, pageIndex: true, yStartPct: true, yEndPct: true },
  });
  for (const q of qs) {
    console.log(`Q${q.questionNum}  page=${q.pageIndex}  y=${q.yStartPct}-${q.yEndPct}`);
    console.log(`  stem: ${q.transcribedStem ?? "(none)"}`);
    if (q.transcribedOptions) console.log(`  options: ${JSON.stringify(q.transcribedOptions)}`);
    console.log(`  answer: ${q.answer}`);
    console.log();
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
