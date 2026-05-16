import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const PAPER_ID = process.argv[2] ?? "cmp8gfuds0001uaerck6epajj";
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: { metadata: true },
  });
  const meta = paper?.metadata as Record<string, unknown> | null;
  const sections = (meta as { chineseSections?: Array<{ label: string; startIndex: number; endIndex: number; passage?: string }> } | null)?.chineseSections;
  if (!sections) return console.log("(no chineseSections)");
  console.log(`${sections.length} sections in chineseSections:\n`);
  for (const s of sections) {
    console.log(`  ${s.label.padEnd(22)} idx ${s.startIndex}-${s.endIndex}  passage=${s.passage ? `${s.passage.length}ch` : "(none)"}`);
    if (s.passage) console.log(`    head: ${s.passage.slice(0, 100).replace(/\n/g, "\\n")}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
