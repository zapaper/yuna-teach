import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const PAPER_ID = process.argv[2] ?? "cmp8452t70001r1hlmmff4zlz";
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: { title: true, subject: true, metadata: true, extractionStatus: true, pageCount: true },
  });
  if (!paper) return console.log("not found");
  console.log("Title:", paper.title, "| Subject:", paper.subject, "| Status:", paper.extractionStatus, "| pages:", paper.pageCount);

  const meta = paper.metadata as Record<string, unknown> | null;
  console.log("\nmetadata keys:", meta ? Object.keys(meta) : "(none)");
  const papers = (meta as { papers?: Array<{ label: string; sections?: unknown[] }> } | null)?.papers;
  if (papers) {
    for (const p of papers) {
      console.log(`\nPaper ${p.label}: ${p.sections?.length ?? 0} sections`);
      for (const s of (p.sections ?? []) as Array<{ name?: string; type?: string; startPage?: number; endPage?: number; questionCount?: number }>) {
        console.log(`  - "${s.name}" [type=${s.type}] pages=${s.startPage}-${s.endPage} qs=${s.questionCount}`);
      }
    }
  }

  const sectionOcr = (meta as { sectionOcrTexts?: Record<string, { ocrText?: string; passageOcrText?: string }> } | null)?.sectionOcrTexts;
  if (sectionOcr) {
    console.log(`\nsectionOcrTexts keys: [${Object.keys(sectionOcr).join(", ")}]`);
  } else {
    console.log("\n(no sectionOcrTexts)");
  }

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID },
    orderBy: { orderIndex: "asc" },
    select: {
      questionNum: true, syllabusTopic: true, answer: true,
      transcribedStem: true, transcribedOptions: true,
      yStartPct: true, yEndPct: true, pageIndex: true, imageData: true,
    },
  });
  console.log(`\n${qs.length} questions stored.`);
  console.log("First 5:\n");
  for (const q of qs.slice(0, 5)) {
    const hasImg = (q.imageData ?? "").length > 100;
    console.log(`Q${q.questionNum} [${q.syllabusTopic}]  page=${q.pageIndex} y=${q.yStartPct}-${q.yEndPct} hasImg=${hasImg}`);
    console.log(`  stem: ${(q.transcribedStem ?? "(none)").slice(0, 150)}`);
    if (q.transcribedOptions) console.log(`  options: ${JSON.stringify(q.transcribedOptions).slice(0, 120)}`);
    console.log(`  answer: ${q.answer}`);
    console.log();
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
