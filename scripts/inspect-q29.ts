import { prisma } from "../src/lib/db";

async function main() {
  const examId = "cmpo2q0qo0001sm5jeg874w3r";

  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: examId, questionNum: "29_p2" },
    select: {
      id: true,
      questionNum: true,
      answer: true,
      transcribedStem: true,
      transcribedSubparts: true,
      pageIndex: true,
      orderIndex: true,
      marksAvailable: true,
      syllabusTopic: true,
    },
  });

  if (!q) {
    console.log(`No question with questionNum="29_p2" in exam ${examId}.`);
    console.log("Listing all questions in exam matching /29/...");
    const all = await prisma.examQuestion.findMany({
      where: { examPaperId: examId, questionNum: { contains: "29" } },
      select: { id: true, questionNum: true, pageIndex: true, orderIndex: true, marksAvailable: true },
      orderBy: [{ pageIndex: "asc" }, { orderIndex: "asc" }],
    });
    console.log(JSON.stringify(all, null, 2));
  } else {
    console.log("FOUND:");
    console.log(JSON.stringify(q, null, 2));
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
