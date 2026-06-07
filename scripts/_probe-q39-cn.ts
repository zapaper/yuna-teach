import { prisma } from "../src/lib/db";
async function main() {
  const id = "cmq0tgcuc00011e0qqv3pfcjc";
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: id, questionNum: "39" },
    select: {
      id: true, questionNum: true,
      marksAwarded: true, marksAvailable: true,
      markingNotes: true,
      studentAnswer: true, answer: true,
      syllabusTopic: true,
    },
  });
  console.log(JSON.stringify(q, null, 2));
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
