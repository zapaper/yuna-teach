import { prisma } from "../src/lib/db";

async function main() {
  const paper = await prisma.examPaper.findFirst({
    where: {
      subject: { contains: "science", mode: "insensitive" },
      title: { contains: "PSLE", mode: "insensitive" },
      year: { contains: "2025" },
      sourceExamId: null,
    },
    select: { id: true, title: true, year: true },
  });
  if (!paper) {
    console.log("No PSLE Science 2025 master paper found.");
    return;
  }
  console.log(`[${paper.year}] ${paper.title}`);

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: paper.id },
    select: { questionNum: true, marksAvailable: true, syllabusTopic: true },
    orderBy: { orderIndex: "asc" },
  });

  const totalQs = qs.length;
  const totalMarks = qs.reduce((s, q) => s + (q.marksAvailable ?? 0), 0);

  const interactQs = qs.filter(q =>
    (q.syllabusTopic ?? "").toLowerCase().includes("interaction") &&
    (q.syllabusTopic ?? "").toLowerCase().includes("environment"));
  const interactMarks = interactQs.reduce((s, q) => s + (q.marksAvailable ?? 0), 0);

  console.log(`\nTotal questions: ${totalQs}, total marks: ${totalMarks}`);
  console.log(`"Interactions within the environment": ${interactQs.length} qs, ${interactMarks} marks`);
  console.log(`  → ${((interactQs.length / totalQs) * 100).toFixed(1)}% of questions`);
  console.log(`  → ${((interactMarks / totalMarks) * 100).toFixed(1)}% of marks`);

  console.log(`\nQuestion-level detail:`);
  for (const q of interactQs) {
    console.log(`  Q${q.questionNum.padEnd(6)} marks=${q.marksAvailable ?? "?"}  topic="${q.syllabusTopic}"`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
