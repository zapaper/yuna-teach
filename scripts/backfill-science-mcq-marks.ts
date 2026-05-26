// One-shot: backfill marksAvailable=2 for null-mark questions in
// Science Booklet A across all master papers.
//
// Why: until today, the structure-analysis step didn't reliably tag
// Science Booklet A questions as 2 marks each. New extractions get
// the fix automatically; existing papers need this one-time pass.
//
// Strategy: for every master ExamPaper with subject like "Science"
// AND title containing "Science", find questions whose questionNum
// parses as 1..28 AND have marksAvailable IS NULL. Set them to 2.
//
// Dry-run by default; pass --apply to write.

import { prisma } from "../src/lib/db";

async function main() {
  const apply = process.argv.includes("--apply");
  const papers = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      paperType: null,
      subject: { contains: "science", mode: "insensitive" },
    },
    select: { id: true, title: true, year: true, level: true, metadata: true },
  });
  console.log(`Found ${papers.length} Science master papers to inspect.`);

  let totalUpdated = 0;
  for (const p of papers) {
    // Verify Booklet A is part of this paper (extracted papers all
    // carry the "Booklet A" label in metadata.papers — guard against
    // single-booklet uploads that may not).
    const md = p.metadata as { papers?: Array<{ label?: string; expectedQuestions?: number; questionsStartPage?: number }> } | null;
    const hasBookletA = (md?.papers ?? []).some(x => (x.label ?? "").toLowerCase().includes("booklet a"));
    if (!hasBookletA) {
      console.log(`  skip [${p.year} ${p.level}] ${p.title} — no 'Booklet A' label in metadata`);
      continue;
    }
    // Find candidate questions: numeric questionNum 1..28, marks null.
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: p.id, marksAvailable: null },
      select: { id: true, questionNum: true },
    });
    const targets = qs.filter(q => {
      const n = parseInt(q.questionNum.replace(/^[A-Za-z]+\d*[-:_]?/, ""), 10);
      return Number.isFinite(n) && n >= 1 && n <= 28;
    });
    if (targets.length === 0) {
      console.log(`  ok   [${p.year} ${p.level}] ${p.title} — no null-mark Q1-28`);
      continue;
    }
    console.log(`  ${apply ? "FIX " : "DRY "}[${p.year} ${p.level}] ${p.title} — ${targets.length} questions → marks=2`);
    if (apply) {
      await prisma.examQuestion.updateMany({
        where: { id: { in: targets.map(t => t.id) } },
        data: { marksAvailable: 2 },
      });
      totalUpdated += targets.length;
    }
  }
  console.log(`\n${apply ? "Updated" : "Would update"} ${apply ? totalUpdated : "(dry-run — pass --apply to write)"} questions.`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
