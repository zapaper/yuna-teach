import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const ID = process.argv[2];
  if (!ID) return console.error("Usage: tsx scripts/check-q13-bold.ts <paperId>");
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: ID, questionNum: { in: ["13", "14", "15"] } },
    orderBy: { orderIndex: "asc" },
    select: { questionNum: true, transcribedOptions: true },
  });
  for (const q of qs) {
    console.log(`\nQ${q.questionNum} options:`);
    const opts = q.transcribedOptions as string[] | null;
    opts?.forEach((o, i) => console.log(`  (${i+1}) ${o}`));
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
