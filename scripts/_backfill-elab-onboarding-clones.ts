import "dotenv/config";
import { prisma } from "../src/lib/db";

const PAPER_IDS = [
  "cmr1lvc99000hzp2nayw9ymkf",  // Math
  "cmr1lvegl000yzp2n90dxkr6r",  // Science
  "cmr1nfba300017ut6rjl0h5o8",  // English (14+6)
];
(async () => {
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: { in: PAPER_IDS }, sourceQuestionId: { not: null } },
    select: { id: true, elaboration: true, sourceQuestionId: true, examPaperId: true, questionNum: true },
  });
  const masterIds = [...new Set(qs.map(q => q.sourceQuestionId!).filter(Boolean))];
  const masters = await prisma.examQuestion.findMany({
    where: { id: { in: masterIds } },
    select: { id: true, elaboration: true },
  });
  const byId = new Map(masters.map(m => [m.id, m.elaboration]));
  let updated = 0, skipped = 0;
  for (const q of qs) {
    if ((q.elaboration ?? "").length > 0) { skipped++; continue; }
    const src = byId.get(q.sourceQuestionId!);
    if (!src || src.length === 0) { skipped++; continue; }
    await prisma.examQuestion.update({ where: { id: q.id }, data: { elaboration: src } });
    updated++;
  }
  console.log(`Updated ${updated} clones · skipped ${skipped}.`);
  await prisma.$disconnect();
})();
