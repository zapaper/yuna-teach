import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const PAPER_ID = "cmp5kbe1w0001svxg1r1j3dhe";
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: {
      id: true, title: true, paperType: true, subject: true,
      questions: {
        orderBy: { orderIndex: "asc" },
        select: {
          id: true, questionNum: true,
          transcribedOptions: true, transcribedOptionImages: true, transcribedOptionTable: true,
          transcribedSubparts: true,
          answer: true, studentAnswer: true,
          marksAwarded: true, marksAvailable: true, markingNotes: true,
        },
      },
    },
  });
  if (!paper) return console.log("paper not found");
  console.log(`Paper: ${paper.title}`);
  console.log();
  for (const q of paper.questions) {
    const hasOpts = !!q.transcribedOptions || !!q.transcribedOptionImages || !!q.transcribedOptionTable;
    const flag = hasOpts ? "MCQ" : "OEQ";
    const pct = (q.marksAwarded ?? 0) / (q.marksAvailable ?? 1) * 100;
    console.log(`Q${q.questionNum} (${flag}): ${q.marksAwarded ?? "?"}/${q.marksAvailable ?? "?"} = ${pct.toFixed(0)}%`);
    if (flag === "MCQ") {
      console.log(`  expected: ${q.answer}, student: ${q.studentAnswer}`);
    } else {
      const notes = (q.markingNotes ?? "").replace(/\n/g, " ").slice(0, 250);
      console.log(`  notes: ${notes}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
