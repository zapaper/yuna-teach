import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const ID = process.argv[2];
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: ID, questionNum: { in: ["1", "2", "3"] } },
    orderBy: { orderIndex: "asc" },
    select: { questionNum: true, transcribedStem: true, transcribedOptions: true },
  });
  for (const q of qs) {
    console.log(`Q${q.questionNum} stem: ${q.transcribedStem}`);
    console.log(`Q${q.questionNum} opts: ${JSON.stringify(q.transcribedOptions)}`);
    console.log();
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
