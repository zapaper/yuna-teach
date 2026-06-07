// Inspect what the OpenAI run wrote into a few OEQ rows on the eval
// clones. Shows the marker's stored output (marksAwarded + notes)
// next to the expected mark, so we can tell whether it returned
// well-formed JSON with 0/insufficient or returned garbage that the
// parser fell back to 0 on.

import { prisma } from "../src/lib/db";

const CLONE_PREFIXES = [
  "cmptea0xm",   // P4 Focused: Cycles in matter
  "cmptee7xd",   // P4 Focused: Geometry
  "cmpteihao",   // Mastery: Interactions
  "cmptes0rt",   // P6 Focused: Fractions
  "cmptf4fmw",   // P6 Focused: Respiratory
];

async function main() {
  for (const pref of CLONE_PREFIXES) {
    const p = await prisma.examPaper.findFirst({
      where: { id: { startsWith: pref } },
      select: { id: true, title: true, score: true, totalMarks: true, markingStatus: true },
    });
    if (!p) { console.log(`(no paper for ${pref})`); continue; }
    console.log(`\n=== ${p.title}`);
    console.log(`  id=${p.id}  score=${p.score}/${p.totalMarks}  status=${p.markingStatus}`);
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: p.id },
      orderBy: { orderIndex: "asc" },
      select: {
        questionNum: true, marksAvailable: true, marksAwarded: true,
        markingNotes: true, studentAnswer: true, answer: true,
      },
    });
    // Show only OEQs (no MCQ-style numeric answers)
    for (const q of qs) {
      const ansNorm = (q.answer ?? "").trim().replace(/[().]/g, "").trim();
      const isMcq = /^[1-4]$/.test(ansNorm) || /^[A-D]$/i.test(ansNorm);
      if (isMcq) continue;
      const sa = q.studentAnswer ?? "(null)";
      const saPreview = sa.startsWith("data:image") ? "[ink]" : sa.slice(0, 80);
      console.log(`  Q${q.questionNum}  ${q.marksAwarded}/${q.marksAvailable}m`);
      console.log(`    studentAnswer: "${saPreview}"`);
      console.log(`    markingNotes:  "${(q.markingNotes ?? "(null)").slice(0, 200)}"`);
    }
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
