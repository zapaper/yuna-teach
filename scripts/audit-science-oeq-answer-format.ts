import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  // Science OEQ master questions (sourceQuestionId is null = master) with transcribedSubparts
  const questions = await prisma.examQuestion.findMany({
    where: {
      examPaper: { subject: { contains: "cience" } },
      sourceQuestionId: null,
      transcribedSubparts: { not: undefined },
    },
    select: {
      id: true,
      questionNum: true,
      answer: true,
      transcribedSubparts: true,
      examPaper: { select: { id: true, title: true, level: true } },
    },
  });

  console.log(`Scanning ${questions.length} science master questions with subparts…\n`);

  type Row = { paperId: string; paperTitle: string; level: string | null; qNum: string; qId: string; answer: string | null; reason: string };
  const oddities: Row[] = [];

  for (const q of questions) {
    const subs = q.transcribedSubparts as Array<{ label: string; text: string; answer?: string }> | null;
    if (!subs || subs.length === 0) continue;
    // We're only interested in multi-part questions
    if (subs.length < 2) continue;
    const ans = (q.answer ?? "").trim();
    if (!ans) continue;

    // Standard formats are:
    //   "(a) ... | (b) ... | (c) ..."
    //   "(a)(i) ... | (a)(ii) ... | (b)(i) ..."
    //   "a) ..."  (rare)
    // Odd formats we want to flag:
    //   "7a ..."  (question number prefixed to letter)
    //   "1. ..."  (numbered)
    //   "i) ... | ii) ..." (roman numerals without parent letter)
    //   no labels at all (just one block of text for a multi-part question)

    const hasStandardParen = /\(\s*([a-z])\s*\)(?:\s*\(\s*(i{1,4}|iv|vi{0,3}|v)\s*\))?/i.test(ans);
    const hasBareLetterParen = /(?:^|[|\n;])\s*([a-z])\)\s/i.test(ans); // "a) ..."
    const hasNumberLetterPrefix = /(?:^|[|\n;])\s*\d+\s*([a-z])(?:\)|:|\.)\s/i.test(ans); // "7a) " or "7a: "
    const hasOnlyRomanLabels = /(?:^|[|\n;])\s*\(?(i{1,4}|iv|vi{0,3}|v)\)/i.test(ans) && !hasStandardParen;
    const hasNumberedList = /(?:^|[|\n;])\s*\d+[.):]\s/.test(ans) && !hasStandardParen;

    let reason: string | null = null;
    if (hasNumberLetterPrefix) reason = "number+letter prefix (e.g. '7a')";
    else if (hasOnlyRomanLabels) reason = "roman labels without (a)/(b) parent";
    else if (hasNumberedList && !hasStandardParen && !hasBareLetterParen) reason = "numbered list, no (a)/a) labels";
    else if (!hasStandardParen && !hasBareLetterParen) {
      // Truly unlabelled: a multi-part question whose answer doesn't carry any part labels at all
      reason = "no part labels (multi-part question)";
    }

    if (reason) {
      oddities.push({
        paperId: q.examPaper.id,
        paperTitle: q.examPaper.title,
        level: q.examPaper.level,
        qNum: q.questionNum,
        qId: q.id,
        answer: ans.length > 200 ? ans.slice(0, 200) + "…" : ans,
        reason,
      });
    }
  }

  if (oddities.length === 0) {
    console.log("All multi-part science OEQ answer keys use a standard (a)/(b) or a)/b) format.");
    return;
  }

  console.log(`Found ${oddities.length} science OEQ answer keys with non-standard part labels:\n`);
  const byReason = new Map<string, Row[]>();
  for (const r of oddities) {
    if (!byReason.has(r.reason)) byReason.set(r.reason, []);
    byReason.get(r.reason)!.push(r);
  }
  for (const [reason, rows] of byReason) {
    console.log(`\n=== ${reason} — ${rows.length} questions ===`);
    for (const r of rows) {
      console.log(`  ${r.level ?? "?"}  ${r.paperTitle}  Q${r.qNum}  (${r.qId})`);
      console.log(`    answer: ${r.answer}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
