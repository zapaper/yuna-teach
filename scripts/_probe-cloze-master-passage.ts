// Look at recent 短文填空 master class quiz papers to inspect the
// stored passage + question shape. User reports the per-question
// option pickers landing at wrong places in the passage AND extra
// "____" blanks showing up later.

import { prisma } from "../src/lib/db";

async function main() {
  const papers = await prisma.examPaper.findMany({
    where: {
      paperType: { in: ["quiz", "mastery"] },
      title: { contains: "短文填空", mode: "insensitive" },
    },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { id: true, title: true, createdAt: true, metadata: true },
  });
  console.log(`found ${papers.length} cloze master papers`);
  for (const p of papers) {
    console.log(`\n=== ${p.title}  (${p.id.slice(0, 12)}…)`);
    // Look at the chineseSections metadata to find the passage.
    const md = (p.metadata ?? {}) as Record<string, unknown>;
    const sections = (md.chineseSections ?? []) as Array<Record<string, unknown>>;
    if (Array.isArray(sections)) {
      for (const sec of sections) {
        const label = String(sec.label ?? sec.name ?? "");
        if (label.includes("短文填空")) {
          const passage = String(sec.passage ?? "");
          console.log(`  section: ${label}`);
          console.log(`  passage (${passage.length} chars):`);
          console.log("  ---");
          // Show passage with marker positions visible.
          const blankRe = /\*\*[^*]*\*\*/g;
          let count = 0;
          for (const m of passage.matchAll(blankRe)) {
            count++;
            console.log(`  blank #${count} at idx=${m.index}: ${JSON.stringify(m[0])}`);
          }
          console.log(`  total **...** blanks in passage: ${count}`);
          // Also count any literal "_______" runs that aren't inside **
          const literalUnderscores = (passage.match(/_{4,}/g) ?? []);
          console.log(`  literal "____" runs (≥4 underscores): ${literalUnderscores.length}`);
          // Show first 300 chars
          console.log(`  preview: ${passage.slice(0, 400).replace(/\n/g, "\\n")}`);
        }
      }
    }
    // Then list the actual questions to compare
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: p.id },
      orderBy: { orderIndex: "asc" },
      select: { questionNum: true, answer: true, transcribedOptions: true, syllabusTopic: true },
    });
    const clozeQs = qs.filter(q => (q.syllabusTopic ?? "").includes("短文填空"));
    console.log(`  ${clozeQs.length} cloze questions in this paper:`);
    for (const q of clozeQs) {
      const opts = q.transcribedOptions as string[] | null;
      console.log(`    Q${q.questionNum}  ans=${q.answer}  opts=${opts ? `[${opts.length}]` : "null"}`);
    }
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
