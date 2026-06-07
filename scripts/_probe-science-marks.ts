// Investigate a Science paper where MCQ default-mark (2) isn't being
// applied. Look at the stored marksAvailable per question + the section
// metadata that drives the default.

import { prisma } from "../src/lib/db";

const PAPER_ID = process.argv[2] ?? "cmptq7cua00bnzgzx1093rbt2";

async function main() {
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: {
      id: true, title: true, subject: true, level: true, school: true,
      year: true, semester: true, examType: true,
      metadata: true,
    },
  });
  if (!paper) { console.log(`paper ${PAPER_ID} not found`); return; }
  console.log(`paper: ${paper.title}`);
  console.log(`  subject=${paper.subject}  level=${paper.level}  examType=${paper.examType}`);
  console.log(`  school=${paper.school}  year=${paper.year}  semester=${paper.semester}`);
  console.log(`\nmetadata keys: ${Object.keys((paper.metadata as object) ?? {}).join(", ")}`);
  // structure / paperLabel-style hints in metadata
  const md = (paper.metadata ?? {}) as Record<string, unknown>;
  if (md.papers) {
    console.log(`metadata.papers: ${JSON.stringify(md.papers).slice(0, 400)}`);
  }
  if (md.sections) {
    console.log(`metadata.sections: ${JSON.stringify(md.sections).slice(0, 400)}`);
  }

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID },
    orderBy: { orderIndex: "asc" },
    select: {
      questionNum: true, answer: true, marksAvailable: true,
      transcribedOptions: true, transcribedOptionImages: true, transcribedOptionTable: true,
      transcribedSubparts: true,
    },
  });

  console.log(`\n${qs.length} questions:\n`);
  console.log(`Q    ans  marks  shape          ans-is-1-4`);
  console.log(`-`.repeat(60));
  for (const q of qs) {
    const opts = q.transcribedOptions as string[] | null;
    const optImgs = q.transcribedOptionImages as (string | null)[] | null;
    const optTable = q.transcribedOptionTable as object | null;
    const subs = q.transcribedSubparts as object[] | null;
    const shape = optTable ? "optionTable"
      : (optImgs && optImgs.some(x => x)) ? "optionImages"
      : (opts && opts.length > 0) ? "options(text)"
      : (subs && subs.length > 0) ? "OEQ-subparts"
      : "(empty)";
    const ansNorm = (q.answer ?? "").trim().replace(/[().]/g, "").trim();
    const ansIsMcq = /^[1-4]$/.test(ansNorm);
    const marksStr = q.marksAvailable == null ? "null" : String(q.marksAvailable);
    console.log(`Q${q.questionNum.padEnd(4)} ${(q.answer ?? "null").slice(0, 4).padEnd(5)} ${marksStr.padEnd(6)} ${shape.padEnd(14)} ${ansIsMcq}`);
  }

  // Summary: how many null-marks MCQs need backfilling?
  const nullMcq = qs.filter(q => {
    const ansNorm = (q.answer ?? "").trim().replace(/[().]/g, "").trim();
    return /^[1-4]$/.test(ansNorm) && q.marksAvailable == null;
  });
  console.log(`\n${nullMcq.length} MCQ-shaped questions with null marksAvailable: Q${nullMcq.map(q => q.questionNum).join(", Q")}`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
