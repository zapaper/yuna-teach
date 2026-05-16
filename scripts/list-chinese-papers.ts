import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const papers = await prisma.examPaper.findMany({
    where: { subject: { contains: "chinese", mode: "insensitive" } },
    select: { id: true, title: true, paperType: true, sourceExamId: true, createdAt: true, metadata: true, _count: { select: { questions: true } } },
    orderBy: { createdAt: "desc" },
  });
  for (const p of papers) {
    const meta = p.metadata as Record<string, unknown> | null;
    const keys = meta ? Object.keys(meta) : [];
    const hasCs = !!(meta as { chineseSections?: unknown } | null)?.chineseSections;
    const hasOcr = !!(meta as { sectionOcrTexts?: unknown } | null)?.sectionOcrTexts;
    console.log(`${p.id}  ${p.paperType.padEnd(8)} qs=${p._count.questions}  cs=${hasCs ? "Y" : "."}  ocr=${hasOcr ? "Y" : "."}  src=${p.sourceExamId ?? "-"}  ${p.title}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
