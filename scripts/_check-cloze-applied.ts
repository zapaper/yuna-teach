import { prisma } from "@/lib/db";
async function main() {
  const counts = await prisma.examQuestion.groupBy({
    by: ["subTopic"],
    where: { syllabusTopic: "Comprehension Cloze" },
    _count: { id: true },
  });
  console.log("Comp Cloze subTopic counts in DB:");
  for (const c of counts.sort((a, b) => b._count.id - a._count.id)) {
    console.log(`  ${(c._count.id + "").padStart(5)}  ${c.subTopic ?? "(null)"}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
