import { prisma } from "../src/lib/db";
async function main() {
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: "cmotr5qoz000ih6io0b4z2erx", questionNum: "9" },
    select: { id: true, questionNum: true, marksAvailable: true, marksAwarded: true, markingNotes: true },
  });
  console.log(JSON.stringify(q, null, 2));
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
