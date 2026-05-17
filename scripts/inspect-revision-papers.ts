import { prisma } from "../src/lib/db";
(async () => {
  const papers = await prisma.examPaper.findMany({
    where: { paperType: "quiz", title: { contains: "Revision" } },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      id: true, title: true, createdAt: true,
      questions: {
        select: { questionNum: true, transcribedStem: true, imageData: true, studentAnswer: true, marksAwarded: true, marksAvailable: true },
        take: 3,
        orderBy: { orderIndex: "asc" },
      },
    },
  });
  for (const p of papers) {
    console.log(`\n${p.createdAt.toISOString().slice(0, 16)}  ${p.id}  ${p.title}`);
    for (const q of p.questions) {
      const stemLen = q.transcribedStem?.length ?? 0;
      const imgLen = q.imageData?.length ?? 0;
      console.log(`  Q${q.questionNum}  transcribedStem=${stemLen}ch  imageData=${imgLen}ch  studentAnswer=${q.studentAnswer ? '"' + q.studentAnswer.slice(0, 40) + '"' : "null"}  marks=${q.marksAwarded}/${q.marksAvailable}`);
    }
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
