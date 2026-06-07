import { prisma } from "../src/lib/db";
async function main() {
  const qs = await prisma.examQuestion.findMany({
    where: {
      examPaperId: "cmnbuadll0001c4cr4j0lkdr7",
      questionNum: { startsWith: "38" },
    },
    orderBy: { questionNum: "asc" },
    select: { questionNum: true, syllabusTopic: true, subTopic: true, marksAvailable: true },
  });
  for (const q of qs) {
    console.log(`Q${q.questionNum}: syllabusTopic="${q.syllabusTopic}" subTopic="${q.subTopic}" marks=${q.marksAvailable}`);
  }
  process.exit(0);
}
main();
