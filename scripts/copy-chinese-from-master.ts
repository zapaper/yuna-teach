import { PrismaClient, Prisma } from "@prisma/client";
type Sec = { label: string; startIndex: number; endIndex: number; passage?: string };
const prisma = new PrismaClient();
async function main() {
  const QUIZ_ID = process.argv[2] ?? "cmp8ipqma002bko6nu8sqn87u";
  const MASTER_ID = process.argv[3] ?? "cmp8gfuds0001uaerck6epajj";
  const master = await prisma.examPaper.findUnique({ where: { id: MASTER_ID }, select: { metadata: true } });
  const meta = master?.metadata as Record<string, unknown> | null;
  const masterCs = (meta as { chineseSections?: Sec[] } | null)?.chineseSections;
  if (!masterCs) return console.log("master has no chineseSections");
  const quiz = await prisma.examPaper.findUnique({ where: { id: QUIZ_ID }, select: { metadata: true } });
  const quizMeta = (quiz?.metadata as Record<string, unknown> | null) ?? {};
  await prisma.examPaper.update({
    where: { id: QUIZ_ID },
    data: { metadata: { ...quizMeta, chineseSections: masterCs } as Prisma.InputJsonValue },
  });
  console.log(`copied ${masterCs.length} sections from ${MASTER_ID} → ${QUIZ_ID}`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
