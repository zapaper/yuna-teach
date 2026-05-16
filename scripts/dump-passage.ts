import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const PAPER_ID = process.argv[2] ?? "cmp8gfuds0001uaerck6epajj";
  const paper = await prisma.examPaper.findUnique({ where: { id: PAPER_ID }, select: { metadata: true } });
  const meta = paper?.metadata as Record<string, unknown> | null;
  const sections = (meta as { chineseSections?: Array<{ label: string; startIndex: number; endIndex: number; passage?: string }> })?.chineseSections;
  if (!sections) return console.log("no chineseSections");
  for (const s of sections) {
    if (!s.passage) continue;
    console.log(`\n=== ${s.label} [${s.startIndex}-${s.endIndex}] (${s.passage.length} chars) ===`);
    console.log(s.passage);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
