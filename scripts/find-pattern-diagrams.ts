// Find real DB questions for the Patterns master class that have a
// usable diagram. We want:
//   Pattern B (triangular) — count grows by +2,+3,+4,+5... or
//     formula n(n+1)/2 in the answer
//   Pattern C (square numbers) — counts 1,4,9,16 or formula n²
// Each must have diagramImageData (so we can render an actual image
// on the slide) plus a clean stem + answer.

import { prisma } from "../src/lib/db";
import * as fs from "fs";
import * as path from "path";

const PATTERN_RX = /\b(pattern|sequence|figure\s*\d|missing number|next term)\b/i;

type Row = {
  id: string;
  paper: string;
  topic: string | null;
  marks: number | null;
  stem: string;
  answer: string | null;
  hasDiagram: boolean;
  diagramSize: number;
};

(async () => {
  const rows = await prisma.examQuestion.findMany({
    where: {
      transcribedStem: { not: null },
      examPaper: {
        sourceExamId: null,
        paperType: null,
        subject: { contains: "Math", mode: "insensitive" },
      },
    },
    select: {
      id: true, transcribedStem: true, answer: true,
      marksAvailable: true, syllabusTopic: true,
      diagramImageData: true,
      examPaper: { select: { title: true } },
    },
    take: 4000,
  });
  const hits: Row[] = [];
  for (const q of rows) {
    if (!q.transcribedStem) continue;
    if (!PATTERN_RX.test(q.transcribedStem)) continue;
    hits.push({
      id: q.id,
      paper: q.examPaper.title,
      topic: q.syllabusTopic,
      marks: q.marksAvailable,
      stem: q.transcribedStem.replace(/\s+/g, " ").slice(0, 500),
      answer: (q.answer ?? "").replace(/\s+/g, " ").slice(0, 400),
      hasDiagram: !!q.diagramImageData,
      diagramSize: q.diagramImageData?.length ?? 0,
    });
  }
  const withDiagram = hits.filter(h => h.hasDiagram);
  console.log(`Total pattern questions: ${hits.length}`);
  console.log(`With diagram: ${withDiagram.length}`);

  // Filter for likely Pattern B (triangular) — answer/stem mentions
  // n(n+1)/2 or shows counts like 1,3,6,10,15 or +2,+3,+4
  const patternB = withDiagram.filter(h => {
    const s = (h.stem + " " + h.answer).toLowerCase();
    return /n\s*\(\s*n\s*[+\-]\s*1\s*\)\s*\/\s*2|triangular|1,\s*3,\s*6,\s*10|2,\s*5,\s*9,\s*14|\+2.*\+3.*\+4|\+3.*\+4.*\+5/.test(s);
  });
  // Filter for Pattern C (square numbers)
  const patternC = withDiagram.filter(h => {
    const s = (h.stem + " " + h.answer).toLowerCase();
    return /(figure\s*n|\bn\b)\s*[×x*]\s*(figure\s*n|\bn\b)|n\^?2|n\s*²|square\s+number|1,\s*4,\s*9,\s*16|2,\s*4,\s*8,\s*16|\(n\s*\+\s*1\)\s*\^?\s*2|\(n\s*\+\s*1\)\s*²/.test(s);
  });

  console.log("\n=== Pattern B candidates (triangular) ===");
  for (const r of patternB.slice(0, 8)) {
    console.log(`\n[${r.id}] ${r.paper} | ${r.marks}m | ${(r.diagramSize / 1024).toFixed(1)}KB`);
    console.log(`  stem: ${r.stem.slice(0, 300)}`);
    console.log(`  answer: ${r.answer?.slice(0, 250)}`);
  }
  console.log("\n=== Pattern C candidates (squares) ===");
  for (const r of patternC.slice(0, 8)) {
    console.log(`\n[${r.id}] ${r.paper} | ${r.marks}m | ${(r.diagramSize / 1024).toFixed(1)}KB`);
    console.log(`  stem: ${r.stem.slice(0, 300)}`);
    console.log(`  answer: ${r.answer?.slice(0, 250)}`);
  }
  // Dump everything with diagrams for manual review.
  const out = path.join(process.cwd(), "scripts", "pattern-diagrams-dump.json");
  fs.writeFileSync(out, JSON.stringify(withDiagram, null, 2));
  console.log(`\nFull dump (with-diagrams only): ${out}`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
