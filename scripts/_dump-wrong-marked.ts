// Dump the marker output (markingNotes + studentAnswer + expected
// answer) for every question that gpt-4.1-mini got wrong in the
// most recent eval.

import { prisma } from "../src/lib/db";

const WRONG: { clonePrefix: string; paperLabel: string; qs: { num: string; expected: number; got: number }[] }[] = [
  { clonePrefix: "cmpuga9uy", paperLabel: "P4 Cycles in matter",
    qs: [{ num: "6", expected: 2, got: 0 }, { num: "9", expected: 2, got: 1 }] },
  { clonePrefix: "cmpugantq", paperLabel: "P4 Geometry",
    qs: [{ num: "8", expected: 2, got: 1 }, { num: "9", expected: 2, got: 0 }] },
  { clonePrefix: "cmpugb9a5", paperLabel: "Mastery Interactions",
    qs: [{ num: "11", expected: 4, got: 3 }, { num: "16", expected: 3, got: 2 }] },
  { clonePrefix: "cmpugc9x5", paperLabel: "P6 Fractions",
    qs: [{ num: "6", expected: 2, got: 0 }, { num: "8", expected: 1, got: 0 }] },
  { clonePrefix: "cmpugcq9w", paperLabel: "P6 Geometry",
    qs: [{ num: "6", expected: 3, got: 1 }, { num: "7", expected: 0, got: 2 }, { num: "8", expected: 2, got: 0 }] },
  { clonePrefix: "cmpugczd0", paperLabel: "P6 Ratio",
    qs: [{ num: "6", expected: 2, got: 0 }, { num: "10", expected: 1, got: 0 }] },
  { clonePrefix: "cmpugd92j", paperLabel: "P6 Respiratory",
    qs: [{ num: "10", expected: 3, got: 2 }] },
];

async function main() {
  for (const group of WRONG) {
    const paper = await prisma.examPaper.findFirst({
      where: { id: { startsWith: group.clonePrefix } },
      select: { id: true, title: true },
    });
    if (!paper) { console.log(`(clone ${group.clonePrefix} not found)`); continue; }
    console.log(`\n============================================================`);
    console.log(`${group.paperLabel}  (${paper.id.slice(0, 12)}…)`);
    console.log(`============================================================`);

    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: paper.id, questionNum: { in: group.qs.map(q => q.num) } },
      orderBy: { orderIndex: "asc" },
      select: {
        questionNum: true, marksAvailable: true, marksAwarded: true,
        markingNotes: true, studentAnswer: true, answer: true, transcribedStem: true,
      },
    });
    for (const q of qs) {
      const meta = group.qs.find(g => g.num === q.questionNum)!;
      console.log(`\n--- Q${q.questionNum}  ${q.marksAwarded}/${q.marksAvailable}m  (expected ${meta.expected}, got ${meta.got}, Δ${(meta.got - meta.expected) >= 0 ? "+" : ""}${meta.got - meta.expected})`);
      console.log(`STEM: ${(q.transcribedStem ?? "(null)").slice(0, 280)}`);
      console.log(`\nEXPECTED ANSWER:`);
      console.log(q.answer ?? "(null)");
      console.log(`\nSTUDENT ANSWER (detected):`);
      console.log(q.studentAnswer ?? "(null)");
      console.log(`\nMARKER NOTES:`);
      console.log(q.markingNotes ?? "(null)");
    }
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
