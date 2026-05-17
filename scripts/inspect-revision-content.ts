import { prisma } from "../src/lib/db";
const ID = process.argv[2] ?? "cmop3lmzy0023kmagw7ta2exh";
(async () => {
  const p = await prisma.examPaper.findUnique({
    where: { id: ID },
    select: {
      paperType: true, completedAt: true, score: true, markingStatus: true,
      questions: {
        select: { questionNum: true, transcribedStem: true, transcribedOptions: true, transcribedSubparts: true, imageData: true, studentAnswer: true, marksAwarded: true, marksAvailable: true },
        take: 3, orderBy: { orderIndex: "asc" },
      },
    },
  });
  console.log("paperType:", p?.paperType, " completedAt:", p?.completedAt?.toISOString().slice(0, 16), " score:", p?.score, " markingStatus:", p?.markingStatus);
  for (const q of p?.questions ?? []) {
    console.log(`\n--- Q${q.questionNum} ---`);
    console.log("transcribedStem:", JSON.stringify(q.transcribedStem?.slice(0, 200)));
    console.log("transcribedOptions:", JSON.stringify(q.transcribedOptions));
    console.log("transcribedSubparts:", JSON.stringify(q.transcribedSubparts)?.slice(0, 200));
    console.log("studentAnswer:", JSON.stringify(q.studentAnswer));
    console.log("marks:", q.marksAwarded, "/", q.marksAvailable);
    console.log("imageData starts:", q.imageData?.slice(0, 60));
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
