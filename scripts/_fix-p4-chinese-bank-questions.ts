// One-off cleanup for P4 Chinese paper cmqdxv8eh000111t0px0v087h.
//
// 词语搭配 (Q11-Q14) and 短文填空 (Q15-Q18) were mis-extracted as MCQ
// with 4 word options each. The actual format is a shared phrase bank
// of 8 items at the top of the section; each question prompts a
// phrase + blank, and the student writes the number (1-8) from the
// bank that completes it. Same shape as 完成对话.
//
// Fix:
//   - clear transcribedOptions (no longer MCQ)
//   - normalize answer to "(N)" — strip the trailing word the OCR
//     pass tacked on (e.g. "(3) 摇摆身体" → "(3)", "5 担心" → "(5)")
//
// Dry-run by default; pass --apply to write.

import { prisma } from "../src/lib/db";

// Paper ID can be overridden via --paper <id>. Defaults to the
// first Nanyang P4 paper we cleaned up; second invocation should
// pass --paper cmqeqdqty00014ny153jypwb6.
const argv = process.argv.slice(2);
const paperIdx = argv.indexOf("--paper");
const PAPER_ID = paperIdx >= 0 ? argv[paperIdx + 1] : "cmqdxv8eh000111t0px0v087h";
const TOPICS = ["词语搭配", "短文填空"];
const apply = argv.includes("--apply");

function normalizeAnswer(raw: string | null | undefined): string | null {
  if (!raw) return raw ?? null;
  // Match a number 1-8 anywhere in the answer (optionally wrapped in
  // parens). The number is the canonical answer; everything else is
  // the OCR-tacked-on word that we drop.
  const m = raw.match(/\(?\s*([1-8])\s*\)?/);
  if (!m) return raw;
  return `(${m[1]})`;
}

(async () => {
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID, syllabusTopic: { in: TOPICS } },
    select: { id: true, questionNum: true, syllabusTopic: true, transcribedOptions: true, answer: true },
    orderBy: { orderIndex: "asc" },
  });
  console.log(`${apply ? "APPLY" : "DRY-RUN"} — touching ${qs.length} questions`);
  for (const q of qs) {
    const newAnswer = normalizeAnswer(q.answer);
    const hadOptions = Array.isArray(q.transcribedOptions) && q.transcribedOptions.length > 0;
    console.log(`  Q${q.questionNum} (${q.syllabusTopic}): options ${hadOptions ? "→ cleared" : "(already empty)"}; answer ${JSON.stringify(q.answer)} → ${JSON.stringify(newAnswer)}`);
    if (apply) {
      await prisma.examQuestion.update({
        where: { id: q.id },
        data: { transcribedOptions: [], answer: newAnswer },
      });
    }
  }
  if (!apply) console.log("\nPass --apply to write.");
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
