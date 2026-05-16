import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const PAPER_ID = process.argv[2] ?? "cmp8gfuds0001uaerck6epajj";
  const paper = await prisma.examPaper.findUnique({ where: { id: PAPER_ID }, select: { metadata: true, subject: true } });
  const meta = paper?.metadata as Record<string, unknown> | null;
  console.log("subject:", paper?.subject);
  console.log("metadata keys:", meta ? Object.keys(meta) : "(none)");
  console.log("has englishSections:", !!(meta as { englishSections?: unknown })?.englishSections);
  console.log("has chineseSections:", !!(meta as { chineseSections?: unknown })?.chineseSections);
  const cs = (meta as { chineseSections?: Array<unknown> })?.chineseSections;
  if (cs) console.log(`  chineseSections is array len=${cs.length}`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
