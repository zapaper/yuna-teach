import { prisma } from "../src/lib/db";
(async () => {
  const ID = "cmopk27fx0001102os8w2nffp";
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: ID },
    orderBy: { orderIndex: "asc" },
    select: { questionNum: true, transcribedOptions: true, transcribedOptionImages: true, answer: true, studentAnswer: true, marksAwarded: true, marksAvailable: true, markingNotes: true, syllabusTopic: true },
  });
  for (const q of qs) {
    const opts = q.transcribedOptions;
    const imgs = q.transcribedOptionImages;
    const optsLen = Array.isArray(opts) ? opts.length : "n/a";
    const imgsCount = Array.isArray(imgs) ? imgs.filter((o) => !!o).length : "n/a";
    console.log(`Q${q.questionNum}: opts.len=${optsLen}  imgsWithContent=${imgsCount}  topic="${q.syllabusTopic}"`);
    console.log(`  studentAnswer=${JSON.stringify(q.studentAnswer)}  answer=${JSON.stringify(q.answer)}  marks=${q.marksAwarded}/${q.marksAvailable}`);
    console.log(`  notes=${JSON.stringify(q.markingNotes)?.slice(0, 150)}`);
  }
  await prisma.$disconnect();
})();
