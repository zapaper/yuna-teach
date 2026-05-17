import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const ID = process.argv[2] ?? "cmp91l66v0003uryl1ats2vlo";
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: ID, questionNum: { in: ["13", "14", "15"] } },
    orderBy: { orderIndex: "asc" },
    select: { questionNum: true, syllabusTopic: true, transcribedStem: true, transcribedOptions: true },
  });
  for (const q of qs) {
    console.log(`Q${q.questionNum}  [${q.syllabusTopic}]`);
    console.log(`  stem: ${q.transcribedStem}`);
    console.log(`  opts: ${JSON.stringify(q.transcribedOptions)}`);
    console.log();
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
