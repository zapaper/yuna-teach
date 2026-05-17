import { prisma } from "../src/lib/db";

(async () => {
  const PAPER_ID = "cmor3lvg9002fmsjf9qasvmje";
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID },
    orderBy: { orderIndex: "asc" },
    select: { questionNum: true, sourceQuestionId: true, transcribedSubparts: true, answer: true },
  });
  // Pull masters
  const sourceIds = qs.map(q => q.sourceQuestionId).filter(Boolean) as string[];
  const masters = await prisma.examQuestion.findMany({
    where: { id: { in: sourceIds } },
    select: { id: true, questionNum: true, transcribedSubparts: true, answer: true },
  });
  const mById = new Map(masters.map(m => [m.id, m]));

  console.log("Clone -> Master alignment:");
  for (const q of qs) {
    const m = q.sourceQuestionId ? mById.get(q.sourceQuestionId) : null;
    if (!m) { console.log(`  Q${q.questionNum}: NO MASTER FOUND`); continue; }

    const cloneSubFirst = (q.transcribedSubparts as Array<{text: string}> | null)?.[0]?.text?.slice(0, 60) ?? "(none)";
    const masterSubFirst = (m.transcribedSubparts as Array<{text: string}> | null)?.[0]?.text?.slice(0, 60) ?? "(none)";
    const subMatch = cloneSubFirst === masterSubFirst;
    const ansMatch = (q.answer ?? "").slice(0, 60) === (m.answer ?? "").slice(0, 60);
    const flag = (subMatch && ansMatch) ? "OK" : "‼ MISMATCH";
    console.log(`  ${flag} Q${q.questionNum} → master Q${m.questionNum} (${q.sourceQuestionId})`);
    if (!subMatch) {
      console.log(`     clone sub : "${cloneSubFirst}"`);
      console.log(`     master sub: "${masterSubFirst}"`);
    }
    if (!ansMatch) {
      console.log(`     clone ans : "${(q.answer ?? "").slice(0, 60)}"`);
      console.log(`     master ans: "${(m.answer ?? "").slice(0, 60)}"`);
    }
  }
  await prisma.$disconnect();
})();
