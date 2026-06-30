// For every question in the [Synthetic Bank] Mathematics paper, walk
// sourceQuestionId back to its master and report what the master has
// that the bank row is missing (diagrams, subpart diagrams, etc.). If
// the masters DO have diagrams that didn't propagate to the bank rows,
// that's the cloning bug — synthetic-bank generation lost the diagram.
//
// Run: npx tsx scripts/_probe-bank-vs-masters.ts

import "dotenv/config";
import { prisma } from "../src/lib/db";

(async () => {
  const bankPaperId = "cmo82pjw3004y12oh6o2ub3kt";
  const bankRows = await prisma.examQuestion.findMany({
    where: { examPaperId: bankPaperId },
    select: {
      id: true, questionNum: true, sourceQuestionId: true,
      diagramImageData: true, imageData: true, transcribedSubparts: true,
    },
    orderBy: { questionNum: "asc" },
  });

  const masterIds = [...new Set(bankRows.map(r => r.sourceQuestionId).filter((x): x is string => !!x))];
  console.log(`Bank has ${bankRows.length} rows pointing to ${masterIds.length} distinct masters`);

  const masters = await prisma.examQuestion.findMany({
    where: { id: { in: masterIds } },
    select: {
      id: true, questionNum: true,
      diagramImageData: true, imageData: true,
      transcribedSubparts: true,
      examPaper: { select: { id: true, title: true } },
    },
  });
  const byId = new Map(masters.map(m => [m.id, m]));

  type SubP = { label?: string; diagramBase64?: string };
  let masterHasDiagram = 0;
  let masterHasSubpartDiagrams = 0;
  let bankHasDiagram = 0;
  let bankHasSubpartDiagrams = 0;
  let masterHasButBankMissing = 0;
  const sampleMissing: Array<{ bankQNum: string; masterId: string; masterPaper: string; masterDiagLen: number; masterSubpartImgs: number }> = [];

  for (const r of bankRows) {
    const m = r.sourceQuestionId ? byId.get(r.sourceQuestionId) : null;
    if (!m) continue;
    const md = (m.diagramImageData?.length ?? 0) > 0;
    const mi = (m.imageData?.length ?? 0) > 0;
    const mSubs = (m.transcribedSubparts as SubP[] | null) ?? [];
    const mSubImgCount = mSubs.filter(s => (s.diagramBase64?.length ?? 0) > 0).length;
    const bd = (r.diagramImageData?.length ?? 0) > 0;
    const bSubs = (r.transcribedSubparts as SubP[] | null) ?? [];
    const bSubImgCount = bSubs.filter(s => (s.diagramBase64?.length ?? 0) > 0).length;

    if (md) masterHasDiagram++;
    if (mSubImgCount > 0) masterHasSubpartDiagrams++;
    if (bd) bankHasDiagram++;
    if (bSubImgCount > 0) bankHasSubpartDiagrams++;

    const masterHasVisual = md || mSubImgCount > 0;
    const bankHasVisual = bd || bSubImgCount > 0;
    if (masterHasVisual && !bankHasVisual) {
      masterHasButBankMissing++;
      if (sampleMissing.length < 8) {
        sampleMissing.push({
          bankQNum: r.questionNum,
          masterId: m.id,
          masterPaper: m.examPaper.title ?? "—",
          masterDiagLen: m.diagramImageData?.length ?? 0,
          masterSubpartImgs: mSubImgCount,
        });
      }
    }
  }

  console.log(`\n── master has visual (top-level diagram or subpart diagrams) ──`);
  console.log(`  master diagramImageData populated: ${masterHasDiagram}/${bankRows.length}`);
  console.log(`  master subpart diagramBase64 populated: ${masterHasSubpartDiagrams}/${bankRows.length}`);
  console.log(`\n── bank row has visual ──`);
  console.log(`  bank diagramImageData populated: ${bankHasDiagram}/${bankRows.length}`);
  console.log(`  bank subpart diagramBase64 populated: ${bankHasSubpartDiagrams}/${bankRows.length}`);
  console.log(`\n── DELTA: master has visual but bank row doesn't ──`);
  console.log(`  ${masterHasButBankMissing}/${bankRows.length}`);
  if (sampleMissing.length > 0) {
    console.log(`  Samples (bank row → master that DOES have diagram):`);
    for (const s of sampleMissing) {
      console.log(`    bank q${s.bankQNum.padStart(3)}  →  master ${s.masterId} (paper: ${s.masterPaper})  topDiag=${s.masterDiagLen}  subpartImgs=${s.masterSubpartImgs}`);
    }
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
