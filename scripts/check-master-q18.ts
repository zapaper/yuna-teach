import { prisma } from "../src/lib/db";
(async () => {
  const masterPaperId = "cmoczukzf0063w623oj93s1pv";
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: masterPaperId, questionNum: { in: ["16", "17", "18", "19", "20"] } },
    orderBy: { orderIndex: "asc" },
    select: { id: true, questionNum: true, syllabusTopic: true, answer: true, transcribedStem: true, transcribedOptions: true },
  });
  for (const q of qs) {
    console.log(`Q${q.questionNum}  id=${q.id}  topic="${q.syllabusTopic}"  answer="${q.answer}"`);
    console.log(`  stem: ${(q.transcribedStem ?? "").slice(0, 80)}`);
    console.log(`  opts: ${JSON.stringify(q.transcribedOptions)?.slice(0, 150)}`);
    console.log("");
  }
  await prisma.$disconnect();
})();
