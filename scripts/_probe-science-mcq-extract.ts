// Investigate why first-pass clean extract on Science MCQ papers
// labels table/image-option MCQs as OEQ. The fix in transcribe-mcq
// POST (line 199-219) routes on q.answer = "1".."4" — confirm whether
// that signal is actually present at first-pass time, and what the
// detected types look like.

import { prisma } from "../src/lib/db";
import { detectQuestionType } from "../src/lib/gemini";

// Nan Hua P6 Prelim Science paper the user flagged previously.
const PAPER_ID = "cmptcpjld0030hch8jpw3h8e7";

async function main() {
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: { id: true, title: true, subject: true },
  });
  if (!paper) { console.log("paper not found"); return; }
  console.log(`paper: ${paper.title} (${paper.subject})`);

  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID },
    orderBy: { orderIndex: "asc" },
    select: {
      id: true, questionNum: true, answer: true, marksAvailable: true,
      transcribedStem: true, transcribedOptions: true, transcribedOptionImages: true,
      transcribedOptionTable: true, transcribedSubparts: true,
      imageData: true,
    },
  });

  // Look at first 28 Qs (the MCQ section). Show: questionNum, answer raw,
  // is answer "1-4" shape, what was stored (options vs subparts).
  console.log(`\nQ  ans  answerLooksMcq  stored-as  hasOpts  hasOptTable  hasSubparts`);
  console.log(`-`.repeat(85));
  const mcqOutput: typeof qs = [];
  for (const q of qs.slice(0, 28)) {
    const ansNormalized = (q.answer ?? "").trim().replace(/[().]/g, "").trim();
    const answerLooksMcq = /^[1-4]$/.test(ansNormalized);
    const hasOpts = !!(q.transcribedOptions && (q.transcribedOptions as unknown[]).length > 0);
    const hasOptTable = !!q.transcribedOptionTable;
    const hasSubparts = !!(q.transcribedSubparts && (q.transcribedSubparts as unknown[]).length > 0);
    const storedAs = (hasOpts || hasOptTable) ? "MCQ"
      : hasSubparts ? "OEQ"
      : "(none — not extracted yet)";
    console.log(`Q${q.questionNum.padEnd(4)} ${(q.answer ?? "null").padEnd(8)} ${String(answerLooksMcq).padEnd(8)}  ${storedAs.padEnd(20)} ${hasOpts}  ${hasOptTable}  ${hasSubparts}`);
    if (answerLooksMcq && storedAs === "OEQ") mcqOutput.push(q);
  }

  if (mcqOutput.length === 0) {
    console.log(`\nNo answer-first mismatches in stored data. Either:`);
    console.log(`  - answers were populated AFTER the first extract pass, OR`);
    console.log(`  - first extract correctly routed these to MCQ but UI rendered something else, OR`);
    console.log(`  - paper was re-extracted (per-question) and the stored state is post-fix`);
  } else {
    console.log(`\n${mcqOutput.length} questions where ans=1-4 but stored as OEQ — these are mismatches.`);
    console.log(`Probing detectQuestionType on first one to see what vision returns:`);
    const sample = mcqOutput[0];
    if (sample.imageData) {
      const base64 = sample.imageData.replace(/^data:image\/\w+;base64,/, "");
      const detected = await detectQuestionType(base64);
      console.log(`  Q${sample.questionNum}: vision detected → "${detected}"  (answer="${sample.answer}")`);
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
