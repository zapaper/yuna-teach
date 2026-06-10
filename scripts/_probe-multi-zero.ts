import { prisma } from "../src/lib/db";
(async () => {
  const PAPERS = process.argv.slice(2);
  for (const id of PAPERS) {
    const p = await prisma.examPaper.findUnique({
      where: { id },
      select: { id: true, title: true, subject: true, paperType: true, markingStatus: true, score: true, totalMarks: true, completedAt: true, assignedTo: { select: { name: true } } },
    });
    if (!p) { console.log(`\n${id}: NOT FOUND`); continue; }
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: id },
      select: { marksAwarded: true, marksAvailable: true },
    });
    let aw = 0, av = 0, marked = 0;
    for (const q of qs) {
      aw += q.marksAwarded ?? 0;
      av += q.marksAvailable ?? 0;
      if (q.marksAwarded !== null) marked++;
    }
    console.log(`\n${p.title}  (${id})`);
    console.log(`  subject=${p.subject}  status=${p.markingStatus}  completedAt=${p.completedAt?.toISOString()}`);
    console.log(`  paper.score=${p.score}  paper.totalMarks=${p.totalMarks}`);
    console.log(`  sum of question marks: ${aw} / ${av}  (${marked}/${qs.length} questions marked)`);
    console.log(`  → ${aw === 0 ? "(student got 0 — genuine zero)" : `MISMATCH: paper.score should be ${aw}, not ${p.score}`}`);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
