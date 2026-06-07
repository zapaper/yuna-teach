import { prisma } from "../src/lib/db";
async function main() {
  const id = "cmpz809nl00eex52ff48c5h7y";
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: id, questionNum: "10" },
    select: {
      id: true, questionNum: true,
      marksAwarded: true, marksAvailable: true,
      markingNotes: true,
      studentAnswer: true, answer: true,
      transcribedSubparts: true,
      transcribedStem: true,
      syllabusTopic: true,
    },
  });
  console.log(JSON.stringify(q, null, 2));
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
