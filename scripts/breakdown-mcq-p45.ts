import { prisma } from "../src/lib/db";

(async () => {
  const masters = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      OR: [
        { subject: { contains: "math", mode: "insensitive" } },
        { subject: { contains: "science", mode: "insensitive" } },
      ],
      AND: [{
        OR: [
          { level: { contains: "Primary 4", mode: "insensitive" } },
          { level: { contains: "Primary 5", mode: "insensitive" } },
          { level: { equals: "P4", mode: "insensitive" } },
          { level: { equals: "P5", mode: "insensitive" } },
        ],
      }],
    },
    select: {
      id: true, title: true, subject: true, level: true, examType: true, year: true, school: true, _count: { select: { questions: true } },
    },
  });

  // Bucket by "looks synthetic" vs "looks like a real exam"
  const synthetic: typeof masters = [];
  const real: typeof masters = [];
  for (const m of masters) {
    const t = (m.title ?? "").toLowerCase();
    const isSynth = t.includes("synthetic") || t.includes("[ai") || t.includes("ai-generated") || t.includes("variant");
    if (isSynth) synthetic.push(m); else real.push(m);
  }
  console.log(`Synthetic-titled papers: ${synthetic.length}  total Qs=${synthetic.reduce((s,m)=>s+m._count.questions,0)}`);
  console.log(`Real-titled papers:      ${real.length}  total Qs=${real.reduce((s,m)=>s+m._count.questions,0)}`);
  console.log("\nSample synthetic titles:");
  for (const m of synthetic.slice(0, 5)) console.log(`  ${m.title}  (${m._count.questions} qs)`);
  console.log("\nSample real titles:");
  for (const m of real.slice(0, 8)) console.log(`  ${m.title}  (${m._count.questions} qs)`);

  // MCQ per bucket
  async function countMcq(papers: typeof masters) {
    let mcq = 0, mcqPending = 0;
    for (const p of papers) {
      const qs = await prisma.examQuestion.findMany({
        where: { examPaperId: p.id },
        select: { transcribedOptions: true, transcribedOptionImages: true, answer: true, elaboration: true },
      });
      for (const q of qs) {
        const opts = q.transcribedOptions as unknown[] | null;
        const optImgs = q.transcribedOptionImages as unknown[] | null;
        const a = (q.answer ?? "").trim().replace(/[().]/g, "");
        const isMcq =
          (Array.isArray(opts) && opts.length === 4) ||
          (Array.isArray(optImgs) && optImgs.some(o => !!o)) ||
          a === "1" || a === "2" || a === "3" || a === "4";
        if (!isMcq) continue;
        mcq++;
        if (!q.elaboration) mcqPending++;
      }
    }
    return { mcq, mcqPending };
  }
  const synthMcq = await countMcq(synthetic);
  const realMcq = await countMcq(real);
  console.log(`\nMCQ in synthetic papers: ${synthMcq.mcq}  pending=${synthMcq.mcqPending}`);
  console.log(`MCQ in real papers:      ${realMcq.mcq}  pending=${realMcq.mcqPending}`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
