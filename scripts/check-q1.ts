import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const ID = process.argv[2] ?? "cmp90vvli002bt3si5su51ibw";
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: ID },
    orderBy: { orderIndex: "asc" },
    take: 3,
    select: { questionNum: true, syllabusTopic: true, transcribedStem: true, transcribedOptions: true, imageData: true },
  });
  for (const q of qs) {
    const hasImg = (q.imageData ?? "").length > 100;
    const stemPreview = (q.transcribedStem ?? "(null)").slice(0, 80);
    const optsPreview = JSON.stringify(q.transcribedOptions ?? null).slice(0, 80);
    console.log(`Q${q.questionNum}  [${q.syllabusTopic}]`);
    console.log(`  hasImg=${hasImg} (${(q.imageData ?? "").length} chars)`);
    console.log(`  stem: ${stemPreview}`);
    console.log(`  options: ${optsPreview}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
