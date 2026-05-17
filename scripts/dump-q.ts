import { prisma } from "../src/lib/db";

const ID = process.argv[2];
if (!ID) { console.error("Usage: tsx scripts/dump-q.ts <questionId>"); process.exit(1); }

async function main() {
  const q = await prisma.examQuestion.findUnique({
    where: { id: ID },
    select: { id: true, questionNum: true, transcribedStem: true, transcribedOptions: true, answer: true, examPaper: { select: { title: true } } },
  });
  console.log(JSON.stringify(q, null, 2));
  await prisma.$disconnect();
}
main();
