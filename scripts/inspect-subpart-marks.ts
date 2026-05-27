import { prisma } from "../src/lib/db";

const PAPER_ID = process.argv[2] ?? "cmpnovfic001au1mj90xpfyi1";

async function main() {
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: { id: true, title: true, subject: true, paperType: true, sourceExamId: true, score: true, totalMarks: true },
  });
  if (!paper) { console.log("Paper not found"); return; }
  console.log(`Paper: ${paper.title}  type=${paper.paperType}  subject=${paper.subject}`);
  console.log(`Score: ${paper.score}  totalMarks: ${paper.totalMarks}`);

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID },
    select: {
      id: true, questionNum: true,
      marksAvailable: true, marksAwarded: true,
      transcribedSubparts: true,
      markingNotes: true,
      syllabusTopic: true,
      studentAnswer: true,
    },
    orderBy: { orderIndex: "asc" },
  });
  console.log(`\nQuestions: ${qs.length}\n`);
  for (const q of qs) {
    const subs = (q.transcribedSubparts as Array<{ label: string; text?: string }> | null) ?? [];
    const subLabels = subs.map(s => s.label).join(",");
    console.log(`Q${q.questionNum.padEnd(6)} marksAwarded=${String(q.marksAwarded ?? "null").padEnd(4)} marksAvailable=${q.marksAvailable ?? "?"} subs=[${subLabels}]`);
    if (subs.length > 0 && q.studentAnswer) {
      console.log(`   studentAnswer (raw):\n${String(q.studentAnswer).split("\n").map(l => "      " + l).join("\n")}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
