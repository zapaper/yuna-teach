import { prisma } from "../src/lib/db";

(async () => {
  const REV = process.argv[2];
  if (!REV) { console.error("usage: inspect-source.ts <revisionPaperId>"); process.exit(1); }
  const rev = await prisma.examPaper.findUnique({
    where: { id: REV },
    select: {
      questions: {
        orderBy: { orderIndex: "asc" },
        select: { questionNum: true, sourceQuestionId: true, marksAwarded: true, marksAvailable: true, syllabusTopic: true },
      },
    },
  });
  if (!rev) { console.error("not found"); process.exit(1); }
  const sourceIds = rev.questions.map(q => q.sourceQuestionId).filter(Boolean) as string[];
  // Look up source MASTER questions and find their containing clone (most-recent completed clone)
  const masterQs = await prisma.examQuestion.findMany({
    where: { id: { in: sourceIds } },
    select: { id: true, examPaperId: true, examPaper: { select: { id: true, title: true } } },
  });
  console.log("Master question owners:");
  const byMaster = new Map<string, string[]>();
  for (const m of masterQs) {
    if (!byMaster.has(m.examPaperId)) byMaster.set(m.examPaperId, []);
    byMaster.get(m.examPaperId)!.push(m.id);
  }
  for (const [pid, qids] of byMaster) {
    const p = await prisma.examPaper.findUnique({ where: { id: pid }, select: { title: true } });
    console.log(`  Master ${pid}: "${p?.title}" — ${qids.length} questions referenced`);
  }

  // Find clones that include any of these source question ids and have been completed
  const clones = await prisma.examPaper.findMany({
    where: {
      assignedToId: { not: null },
      completedAt: { not: null },
      paperType: "quiz",
      questions: { some: { sourceQuestionId: { in: sourceIds } } },
    },
    orderBy: { completedAt: "desc" },
    take: 5,
    select: {
      id: true, title: true, completedAt: true, metadata: true,
      questions: {
        orderBy: { orderIndex: "asc" },
        select: { id: true, orderIndex: true, sourceQuestionId: true, syllabusTopic: true, marksAwarded: true, marksAvailable: true, studentAnswer: true },
      },
    },
  });
  for (const c of clones) {
    const meta = c.metadata as { revisionMode?: string; englishSections?: Array<{label:string;startIndex:number;endIndex:number;passage?:string}> } | null;
    if (meta?.revisionMode) continue; // skip other revision papers
    console.log(`\nCLONE ${c.id}  "${c.title}"  ${c.completedAt?.toISOString().slice(0,16)}`);
    if (meta?.englishSections) {
      for (const s of meta.englishSections) {
        const markers = s.passage ? [...s.passage.matchAll(/\*\*\((\d+)\)/g)].map(m => m[1]) : [];
        const secQs = c.questions.filter(q => q.orderIndex >= s.startIndex && q.orderIndex <= s.endIndex);
        const wrongCount = secQs.filter(q => q.marksAwarded != null && q.marksAvailable != null && q.marksAwarded < q.marksAvailable).length;
        const rightCount = secQs.filter(q => q.marksAwarded != null && q.marksAvailable != null && q.marksAwarded >= q.marksAvailable).length;
        const skippedCount = secQs.filter(q => q.marksAwarded == null).length;
        console.log(`  Section [${s.startIndex}-${s.endIndex}] "${s.label}"  markers=[${markers.join(",")}]  qs=${secQs.length}  wrong=${wrongCount}  right=${rightCount}  skipped=${skippedCount}`);
      }
    }
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
