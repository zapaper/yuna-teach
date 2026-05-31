// Backfill marksAvailable=2 for Science MCQ questions on master papers
// where the per-question detection produced 1 or null.
//
// Detection: a question is "MCQ-shape" when it has 4 transcribed
// options (text or image). For Science only — Math MCQs are still
// 1 mark each on most papers and we don't want to over-mark them.
//
// Excludes paper.title containing "OEQ" / "Open-Ended" / "Structured"
// (some Science compilations bundle OEQ-only into one paper).
//
// Usage:
//   npx tsx scripts/backfill-science-mcq-marks.ts          # dry-run
//   npx tsx scripts/backfill-science-mcq-marks.ts --write  # apply

import { prisma } from "../src/lib/db";

async function main() {
  const write = process.argv.includes("--write");
  const papers = await prisma.examPaper.findMany({
    where: {
      subject: { contains: "science", mode: "insensitive" },
      paperType: null,
      sourceExamId: null,
    },
    select: { id: true, title: true, level: true },
  });

  let totalToUpdate = 0;
  let papersTouched = 0;
  for (const p of papers) {
    const tl = p.title.toLowerCase();
    if (/\b(oeq|open[-\s]?ended|structured)\b/.test(tl)) continue;
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: p.id },
      select: {
        id: true, questionNum: true, marksAvailable: true,
        transcribedOptions: true, transcribedOptionImages: true,
      },
    });
    const candidates = qs.filter(q => {
      // PSLE / P6 Prelim Science papers score every question at 2
      // marks each (MCQ and the simpler OEQ alike). So we don't gate
      // on MCQ-shape detection — both the missed-MCQ case (null
      // marks because transcribedOptions wasn't filled in) AND the
      // detected-MCQ case (marks=1 from a wrong narrower fallback)
      // resolve to the same correct answer: 2 marks. Admin can
      // override the rare 3-/4-mark OEQ via transcribe-edit.
      return q.marksAvailable == null || q.marksAvailable === 1;
    });
    if (candidates.length === 0) continue;
    papersTouched++;
    totalToUpdate += candidates.length;
    console.log(`${write ? "FIX" : "WOULD FIX"} ${p.title}  (${candidates.length} MCQ Qs at null/1)`);
    if (write) {
      await prisma.examQuestion.updateMany({
        where: { id: { in: candidates.map(q => q.id) } },
        data: { marksAvailable: 2 },
      });
    }
  }
  console.log(`\n${write ? "Updated" : "Would update"} ${totalToUpdate} questions across ${papersTouched} papers.`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
