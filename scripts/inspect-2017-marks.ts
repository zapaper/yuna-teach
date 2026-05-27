import { prisma } from "../src/lib/db";
async function main() {
  const id = "cmpo2q0qo0001sm5jeg874w3r";
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: id },
    select: { questionNum: true, orderIndex: true, marksAvailable: true, syllabusTopic: true },
    orderBy: { orderIndex: "asc" },
    take: 30,
  });
  for (const q of qs) {
    console.log(`Q${q.questionNum.padEnd(6)} marks=${q.marksAvailable ?? "null"}  topic=${q.syllabusTopic ?? "—"}`);
  }
  // Also check metadata.papers
  const paper = await prisma.examPaper.findUnique({ where: { id }, select: { metadata: true } });
  console.log("\nmetadata.papers:", JSON.stringify((paper?.metadata as Record<string, unknown> | null)?.papers, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
