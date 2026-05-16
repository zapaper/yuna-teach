import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const PAPER_ID = process.argv[2] ?? "cmp8gfuds0001uaerck6epajj";
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID },
    orderBy: { orderIndex: "asc" },
    select: { questionNum: true, syllabusTopic: true, pageIndex: true, orderIndex: true },
  });
  console.log(`${qs.length} questions stored.\n`);
  for (const q of qs) {
    console.log(`  Q${q.questionNum.padEnd(6)} idx=${String(q.orderIndex).padStart(3)} page=${q.pageIndex}  [${q.syllabusTopic}]`);
  }

  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: { metadata: true },
  });
  const meta = paper?.metadata as Record<string, unknown> | null;
  const papers = (meta as { papers?: Array<{ label: string; sections?: unknown[] }> } | null)?.papers;
  if (papers) {
    for (const p of papers) {
      console.log(`\nPaper "${p.label}": ${p.sections?.length ?? 0} sections`);
      for (const s of (p.sections ?? []) as Array<Record<string, unknown>>) {
        console.log(`  ${JSON.stringify(s).slice(0, 220)}`);
      }
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
