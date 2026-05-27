import { prisma } from "../src/lib/db";
async function main() {
  const id = process.argv[2];
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: id },
    select: { questionNum: true, orderIndex: true, answer: true, transcribedStem: true, transcribedSubparts: true },
    orderBy: { orderIndex: "asc" },
  });
  const splits = qs.filter(q => /^\d+[a-z]+$/i.test(q.questionNum));
  for (const q of splits) {
    const subs = (q.transcribedSubparts as Array<{ label: string; text?: string }> | null) ?? [];
    console.log(`\nQ${q.questionNum}  subs=[${subs.map(s => s.label).join(",")}]`);
    console.log(`  answer:   ${(q.answer ?? "").slice(0, 250)}`);
    console.log(`  stem:     ${(q.transcribedStem ?? "").slice(0, 250)}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
