import { prisma } from "../src/lib/db";

(async () => {
  const ADMIN_ID = "cmmfmehcz0000bbbfnwwiko75";
  const since = new Date(Date.now() - 14 * 86400_000);
  const papers = await prisma.examPaper.findMany({
    where: {
      paperType: { in: ["quiz", "focused"] },
      completedAt: { gte: since },
      markingStatus: "complete",
      assignedTo: { name: { equals: "Mark lim", mode: "insensitive" } },
    },
    select: {
      id: true, title: true, subject: true, score: true, totalMarks: true,
      questions: {
        select: { questionNum: true, transcribedSubparts: true, transcribedOptions: true, transcribedOptionImages: true, answer: true, studentAnswer: true, marksAwarded: true, marksAvailable: true, markingNotes: true },
        orderBy: { orderIndex: "asc" },
      },
    },
    orderBy: { completedAt: "desc" },
  });

  for (const p of papers) {
    const flaggedQs: typeof p.questions = [];
    for (const q of p.questions) {
      const opts = q.transcribedOptions;
      const imgs = q.transcribedOptionImages;
      const isMcq = (Array.isArray(opts) && opts.length === 4) || (Array.isArray(imgs) && imgs.some((o) => !!o));
      if (isMcq) continue;
      const subs = q.transcribedSubparts as Array<{ label: string; text: string }> | null;
      const realSubs = (subs ?? []).filter((s) => !s.label.startsWith("_"));
      if (realSubs.length === 0) continue; // single-canvas, skip
      if (q.studentAnswer === "__SKIPPED__") continue;
      const notes = q.markingNotes ?? "";
      const stu = q.studentAnswer ?? "";
      if (!/\bblank\b/i.test(notes) && !/\bblank\b/i.test(stu)) continue;
      if (/No written answer found/i.test(notes)) continue;
      flaggedQs.push(q);
    }
    if (flaggedQs.length === 0) continue;
    console.log(`\n=== ${p.id}  "${p.title}"  ${p.score}/${p.totalMarks}`);
    console.log(`    https://www.markforyou.com/exam/${p.id}/review?userId=${ADMIN_ID}`);
    for (const q of flaggedQs) {
      console.log(`  Q${q.questionNum}  ${q.marksAwarded}/${q.marksAvailable}`);
      console.log(`    studentAnswer: ${(q.studentAnswer ?? "").slice(0, 200)}`);
      console.log(`    notes: ${(q.markingNotes ?? "").replace(/\s+/g, " ").slice(0, 250)}`);
    }
  }
  await prisma.$disconnect();
})();
