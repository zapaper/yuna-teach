import { prisma } from "../src/lib/db";

// Trace why companions aren't being added for a given revision section.
// Usage: tsx scripts/trace-companions.ts <revisionPaperId> <sectionStartIndex>

(async () => {
  const REV = process.argv[2];
  const START = parseInt(process.argv[3] ?? "0");
  if (!REV) { console.error("usage: trace-companions.ts <revisionPaperId> <sectionStartIndex>"); process.exit(1); }

  const rev = await prisma.examPaper.findUnique({
    where: { id: REV },
    select: {
      metadata: true,
      questions: {
        orderBy: { orderIndex: "asc" },
        select: { id: true, questionNum: true, orderIndex: true, sourceQuestionId: true, syllabusTopic: true, marksAwarded: true, marksAvailable: true },
      },
    },
  });
  if (!rev) { console.error("not found"); process.exit(1); }
  const meta = rev.metadata as { englishSections?: Array<{label:string;startIndex:number;endIndex:number;passage?:string}> } | null;
  const sec = meta?.englishSections?.find(s => s.startIndex === START);
  if (!sec) { console.error("no section at startIndex", START); process.exit(1); }
  console.log(`Section "${sec.label}" [${sec.startIndex}-${sec.endIndex}]`);
  const markers = sec.passage ? [...sec.passage.matchAll(/\*\*\((\d+)\)/g)].map(m => parseInt(m[1])) : [];
  console.log(`Markers: ${markers.length} -> [${markers.join(",")}]`);

  const sectionQs = rev.questions.slice(sec.startIndex, sec.endIndex + 1);
  console.log(`Revision section questions: ${sectionQs.length}`);
  const sourceIds = sectionQs.map(q => q.sourceQuestionId).filter(Boolean) as string[];

  // For each source question, find which clone(s) had it and which clone-section it was in
  const sourceQs = await prisma.examQuestion.findMany({
    where: { id: { in: sourceIds } },
    select: { id: true, questionNum: true, examPaperId: true },
  });
  const masterIdByQ = new Map(sourceQs.map(q => [q.id, q.examPaperId]));

  // Find clones that include any of these source ids
  const clones = await prisma.examPaper.findMany({
    where: {
      paperType: "quiz",
      completedAt: { not: null },
      questions: { some: { sourceQuestionId: { in: sourceIds } } },
    },
    orderBy: { completedAt: "desc" },
    select: {
      id: true, title: true, completedAt: true, metadata: true,
      questions: {
        orderBy: { orderIndex: "asc" },
        select: { id: true, orderIndex: true, sourceQuestionId: true, syllabusTopic: true, marksAwarded: true, marksAvailable: true, studentAnswer: true },
      },
    },
  });
  // Filter out other revision papers
  const realClones = clones.filter(c => {
    const m = c.metadata as { revisionMode?: string } | null;
    return !m?.revisionMode;
  });
  console.log(`\nFound ${realClones.length} real (non-revision) source clones containing any of these source questions`);

  // For each clone, find the section that contains them and report
  const seenForRevQ = new Map<string, string[]>();
  for (const c of realClones) {
    const meta = c.metadata as { englishSections?: Array<{label:string;startIndex:number;endIndex:number;passage?:string}> } | null;
    const sections = meta?.englishSections ?? [];
    for (let i = 0; i < sections.length; i++) {
      const s = sections[i];
      const secQs = c.questions.filter(q => q.orderIndex >= s.startIndex && q.orderIndex <= s.endIndex);
      const matched = secQs.filter(q => q.sourceQuestionId && sourceIds.includes(q.sourceQuestionId));
      if (matched.length === 0) continue;
      const totalInSec = secQs.length;
      const wrongInSec = secQs.filter(q => q.marksAwarded != null && q.marksAvailable != null && q.marksAwarded < q.marksAvailable).length;
      const rightInSec = secQs.filter(q => q.marksAwarded != null && q.marksAvailable != null && q.marksAwarded >= q.marksAvailable).length;
      const skipInSec = secQs.filter(q => q.marksAwarded == null).length;
      const sectionMarkers = s.passage ? [...s.passage.matchAll(/\*\*\((\d+)\)/g)].map(m => m[1]) : [];
      console.log(`  CLONE ${c.id} (${c.completedAt!.toISOString().slice(0,16)}) "${c.title}"`);
      console.log(`    section ${i} "${s.label}" markers=[${sectionMarkers.join(",")}] qs=${totalInSec} wrong=${wrongInSec} right=${rightInSec} skip=${skipInSec}`);
      console.log(`    sourceQs matched here: ${matched.length}`);
      for (const m of matched) {
        const revQ = sectionQs.find(rq => rq.sourceQuestionId === m.sourceQuestionId);
        const list = seenForRevQ.get(revQ!.questionNum) ?? [];
        list.push(`${c.id.slice(-6)}@sec${i}`);
        seenForRevQ.set(revQ!.questionNum, list);
      }
    }
  }
  console.log("\nWhich clone-section each revision question came from:");
  for (const [qn, sources] of seenForRevQ) {
    console.log(`  Q${qn}: ${sources.join(", ")}`);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
