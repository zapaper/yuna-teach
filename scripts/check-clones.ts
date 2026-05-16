import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const MASTER = process.argv[2] ?? "cmp8gfuds0001uaerck6epajj";
  const clones = await prisma.examPaper.findMany({
    where: { sourceExamId: MASTER },
    select: { id: true, assignedToId: true, metadata: true, completedAt: true, paperType: true },
  });
  console.log(`Master ${MASTER} has ${clones.length} clones:`);
  for (const c of clones) {
    const meta = c.metadata as Record<string, unknown> | null;
    const hasCs = !!(meta as { chineseSections?: unknown } | null)?.chineseSections;
    const hasOcr = !!(meta as { sectionOcrTexts?: unknown } | null)?.sectionOcrTexts;
    console.log(`  ${c.id} student=${c.assignedToId} type=${c.paperType} completed=${!!c.completedAt} chineseSections=${hasCs} sectionOcrTexts=${hasOcr}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
