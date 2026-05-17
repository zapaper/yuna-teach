import { prisma } from "../src/lib/db";
(async () => {
  const ID = "cmol7pjnm002f13njt1ey0gnn";
  const p = await prisma.examPaper.findUnique({
    where: { id: ID },
    select: { id: true, title: true, paperType: true, score: true, totalMarks: true, completedAt: true, markingStatus: true, sourceExamId: true, _count: { select: { questions: true } } },
  });
  console.log("paper:", p);
  if (p?.score != null && p.totalMarks) {
    const pct = Math.round((p.score / parseFloat(p.totalMarks)) * 100);
    console.log(`paper.score / totalMarks = ${p.score}/${p.totalMarks} = ${pct}%`);
  }
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: ID },
    select: { questionNum: true, marksAwarded: true, marksAvailable: true },
  });
  let aw = 0, av = 0;
  for (const q of qs) { aw += q.marksAwarded ?? 0; av += q.marksAvailable ?? 0; }
  console.log(`sum from questions: ${aw}/${av} = ${Math.round(aw / av * 100)}%`);

  // For clones, the review page mark route (when sourceExamId is set) builds
  // questions from the master and aggregates. Check master too.
  if (p?.sourceExamId) {
    const masterQs = await prisma.examQuestion.findMany({
      where: { examPaperId: p.sourceExamId },
      select: { questionNum: true, marksAvailable: true },
    });
    let masterAv = 0;
    for (const q of masterQs) masterAv += q.marksAvailable ?? 0;
    console.log(`master total available: ${masterAv}`);
    const cloneByNum = new Map(qs.map(q => [q.questionNum, q]));
    let mergedAw = 0, mergedAv = 0;
    for (const mq of masterQs) {
      const cq = cloneByNum.get(mq.questionNum);
      mergedAw += cq?.marksAwarded ?? 0;
      mergedAv += mq.marksAvailable ?? 0;
    }
    console.log(`merged-from-master sum: ${mergedAw}/${mergedAv} = ${Math.round(mergedAw / mergedAv * 100)}%`);
  }
  await prisma.$disconnect();
})();
