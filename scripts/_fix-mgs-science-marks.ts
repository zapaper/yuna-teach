import { prisma } from "../src/lib/db";
async function main() {
  const PAPER = "cmptsu3no000113t757ojszt5";
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER, marksAvailable: 1 },
    select: { id: true, questionNum: true, answer: true },
  });
  const mcq = qs.filter(q => /^[1-4]$/.test((q.answer ?? "").trim().replace(/[().]/g, "").trim()));
  console.log(`updating ${mcq.length} 1→2 mark MCQ rows on this paper`);
  await prisma.$transaction(mcq.map(q => prisma.examQuestion.update({ where: { id: q.id }, data: { marksAvailable: 2 } })));
  console.log("done");
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
