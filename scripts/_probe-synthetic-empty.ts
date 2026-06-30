import "dotenv/config";
import { prisma } from "../src/lib/db";

(async () => {
  // Paper-wide sweep: aggregate synthetic shape across every question
  // in cmo82pjw3004y12oh6o2ub3kt so we see if the empty-image issue
  // is one master or paper-wide.
  const paperId = "cmo82pjw3004y12oh6o2ub3kt";
  const all = await prisma.examQuestion.findMany({
    where: { examPaperId: paperId },
    select: {
      id: true, questionNum: true, syntheticGenerated: true, syntheticSkipped: true,
      syntheticQuestions: {
        select: { id: true, variant: true, stem: true, answerText: true, diagramImageData: true },
      },
    },
    orderBy: { questionNum: "asc" },
  });
  let totalSynths = 0;
  let withImage = 0;
  let withStem = 0;
  let bothEmpty = 0;
  let masters = 0;
  const sampleEmpty: Array<{ qNum: string; synthId: string }> = [];
  const sampleOk: Array<{ qNum: string; synthId: string; stemLen: number; imgLen: number }> = [];
  for (const q of all) {
    masters++;
    for (const s of q.syntheticQuestions) {
      totalSynths++;
      const il = s.diagramImageData?.length ?? 0;
      const sl = s.stem?.length ?? 0;
      const al = s.answerText?.length ?? 0;
      if (il > 0) withImage++;
      if (sl > 0) withStem++;
      if (il === 0 && sl === 0 && al === 0) {
        bothEmpty++;
        if (sampleEmpty.length < 5) sampleEmpty.push({ qNum: q.questionNum, synthId: s.id });
      } else if (sampleOk.length < 5) {
        sampleOk.push({ qNum: q.questionNum, synthId: s.id, stemLen: sl, imgLen: il });
      }
    }
  }
  console.log(`Paper ${paperId}: ${masters} master questions, ${totalSynths} synthetic rows total`);
  console.log(`  with diagramImageData: ${withImage}`);
  console.log(`  with stem text:        ${withStem}`);
  console.log(`  fully empty (no stem, no answer, no diagram): ${bothEmpty}`);
  if (sampleEmpty.length > 0) {
    console.log(`  sample EMPTY rows:`);
    for (const s of sampleEmpty) console.log(`    q${s.qNum} synth=${s.synthId}`);
  }
  if (sampleOk.length > 0) {
    console.log(`  sample populated rows:`);
    for (const s of sampleOk) console.log(`    q${s.qNum} synth=${s.synthId}  stem.len=${s.stemLen}  diag.len=${s.imgLen}`);
  }

  const masterQId = "cmoeg3pid003fludqo463bze2";
  console.log(`\n── focal master (from URL anchor) ──`);
  const master = await prisma.examQuestion.findUnique({
    where: { id: masterQId },
    select: {
      id: true, questionNum: true, transcribedStem: true, answer: true,
      syntheticGenerated: true, syntheticSkipped: true,
      syntheticQuestions: {
        select: {
          id: true, variant: true, questionType: true,
          stem: true, subparts: true, answerText: true,
          diagramImageData: true, marksAvailable: true,
        },
      },
    },
  });
  if (!master) { console.log("not found"); return; }
  console.log(`Master q${master.questionNum} (${master.id})`);
  console.log(`syntheticGenerated=${master.syntheticGenerated} syntheticSkipped=${master.syntheticSkipped}`);
  console.log(`synthetic count: ${master.syntheticQuestions.length}`);
  for (const s of master.syntheticQuestions) {
    const diagLen = s.diagramImageData?.length ?? 0;
    const stemLen = s.stem?.length ?? 0;
    const ansLen = s.answerText?.length ?? 0;
    const subsRaw = s.subparts;
    const subsCount = Array.isArray(subsRaw) ? subsRaw.length : 0;
    console.log(`  ${s.id} v${s.variant} type=${s.questionType}  stem.len=${stemLen}  ans.len=${ansLen}  diag.len=${diagLen}  subparts=${subsCount}  marks=${s.marksAvailable}`);
    if (stemLen === 0 && ansLen === 0 && diagLen === 0) {
      console.log(`    ↳ EMPTY — all three fields blank`);
    }
  }
  await prisma.$disconnect();
})();
