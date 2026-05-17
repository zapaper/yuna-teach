import { prisma } from "../src/lib/db";

// For each revision-paper question, find which source clone provided
// it (= most-recent completed clone where the same sourceQuestionId
// was answered with marksAwarded < marksAvailable). This mirrors
// fetchMistakeQuestions's dedupe-by-sourceQuestionId logic.

(async () => {
  const REV = process.argv[2];
  const START = parseInt(process.argv[3] ?? "0");
  const END = parseInt(process.argv[4] ?? "999");
  if (!REV) { console.error("usage: <revId> <startIdx> <endIdx>"); process.exit(1); }

  const rev = await prisma.examPaper.findUnique({
    where: { id: REV },
    select: {
      assignedToId: true,
      questions: {
        orderBy: { orderIndex: "asc" },
        select: { id: true, questionNum: true, orderIndex: true, sourceQuestionId: true, syllabusTopic: true, marksAwarded: true, marksAvailable: true },
      },
    },
  });
  if (!rev) { console.error("not found"); process.exit(1); }
  const studentId = rev.assignedToId!;
  const targetQs = rev.questions.filter(q => q.orderIndex >= START && q.orderIndex <= END);

  // Find ALL completed clones for this student in time-desc order
  const allClones = await prisma.examPaper.findMany({
    where: {
      assignedToId: studentId,
      completedAt: { not: null },
      paperType: "quiz",
    },
    orderBy: { completedAt: "desc" },
    select: {
      id: true, title: true, completedAt: true, metadata: true,
      questions: { select: { id: true, orderIndex: true, sourceQuestionId: true, marksAwarded: true, marksAvailable: true, studentAnswer: true } },
    },
  });
  // Skip revision papers
  const clones = allClones.filter(c => {
    const m = c.metadata as { revisionMode?: string } | null;
    return !m?.revisionMode;
  });

  for (const rq of targetQs) {
    if (!rq.sourceQuestionId) { console.log(`Q${rq.questionNum} idx=${rq.orderIndex}: NO sourceQuestionId`); continue; }
    let found = false;
    for (const c of clones) {
      const cq = c.questions.find(q => q.sourceQuestionId === rq.sourceQuestionId);
      if (!cq) continue;
      if (cq.marksAwarded == null || cq.marksAvailable == null) continue;
      if (cq.marksAwarded >= cq.marksAvailable) continue;
      // This is the mistake source
      const meta = c.metadata as { englishSections?: Array<{label:string;startIndex:number;endIndex:number}> } | null;
      const sections = meta?.englishSections ?? [];
      const sectionPos = sections.findIndex(s => cq.orderIndex >= s.startIndex && cq.orderIndex <= s.endIndex);
      console.log(`Q${rq.questionNum} idx=${rq.orderIndex}  sourceQ=${rq.sourceQuestionId.slice(-8)}`);
      console.log(`  → mistake from clone ${c.id} (${c.completedAt!.toISOString().slice(0,16)}) "${c.title}"`);
      console.log(`    cloneQ.orderIndex=${cq.orderIndex}  sectionPos=${sectionPos}  sourceSectionKey="${c.id}::${sectionPos}"`);
      found = true;
      break;
    }
    if (!found) console.log(`Q${rq.questionNum} idx=${rq.orderIndex}: no mistake found in clones (orphan?)`);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
