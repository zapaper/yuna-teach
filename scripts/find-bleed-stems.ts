// Find Science split-segment questions where the c-segment's
// transcribedStem CLEARLY contains (a)/(b) parts that belong to its
// sibling. These are the bleed cases the user is reporting.
//
// New broader checks:
//  - subparts list for a "*c" segment contains label "a" or "b" → BLEED
//  - answer field for "*c" starts with "(a)" or has "(a) … | (b) … | (c)" → BLEED
import { prisma } from "../src/lib/db";
async function main() {
  const qs = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        sourceExamId: null, paperType: null,
        subject: { contains: "science", mode: "insensitive" },
      },
      questionNum: { contains: "c", mode: "insensitive" },
    },
    select: { id: true, questionNum: true, answer: true, transcribedStem: true, transcribedSubparts: true, examPaper: { select: { id: true, title: true } } },
  });
  const candidates = qs.filter(q => /^\d+[a-z]+$/i.test(q.questionNum) && q.questionNum.match(/c/i));
  console.log(`Total c-segments: ${candidates.length}\n`);
  let bleedCount = 0;
  for (const q of candidates) {
    const subs = (q.transcribedSubparts as Array<{ label: string; text?: string }> | null) ?? [];
    const myLabels = new Set(subs.map(s => s.label.toLowerCase()));
    const answer = q.answer ?? "";

    const issues: string[] = [];
    // 1. Subparts list contains a/b that AREN'T this segment's own
    if (myLabels.has("a") && !q.questionNum.match(/a/i)) issues.push("subparts has (a)");
    if (myLabels.has("b") && !q.questionNum.match(/b/i)) issues.push("subparts has (b)");
    // 2. Answer field contains (a) or (b) that aren't in this segment's subParts
    if (!q.questionNum.match(/a/i) && /(^|\s|\|)\(?a\)\s+\S/i.test(answer)) issues.push("answer has (a)");
    if (!q.questionNum.match(/b/i) && /(^|\s|\|)\(?b\)\s+\S/i.test(answer)) issues.push("answer has (b)");

    if (issues.length > 0) {
      bleedCount++;
      if (bleedCount <= 12) {
        console.log(`[${q.examPaper.title.slice(0, 50)}] Q${q.questionNum}  ⚠ ${issues.join(", ")}`);
        console.log(`  subs: [${subs.map(s => s.label).join(",")}]`);
        console.log(`  answer:  ${answer.slice(0, 240)}`);
        console.log();
      }
    }
  }
  console.log(`\nTotal c-segments with apparent a/b bleed: ${bleedCount}/${candidates.length}`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
