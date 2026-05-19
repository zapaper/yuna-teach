// Extract the three chosen pattern question diagrams to
// public/master-class/patterns/<name>.png so the YAML slides can
// reference them by path.

import { prisma } from "../src/lib/db";
import * as fs from "fs";
import * as path from "path";

const PICKS: Array<{ id: string; outName: string }> = [
  // Pattern B (growing-sum, beads in rows)
  { id: "cmnzkkl0o00045nicwbczx5gp", outName: "pattern-b-beads" },
  // Pattern C (square numbers, n × n)
  { id: "cmo27n9pa001sr29q53o9o4ad", outName: "pattern-c-squares" },
  // Shape composition (Figure 2 from 4 triangles)
  { id: "cmm60lvkv00pi13aolqyhnz9m", outName: "shape-composition-triangles" },
];

(async () => {
  // The IDs above are guesses based on inspection — actually look up by
  // stem keywords + diagram presence so we always pick the right rows.
  const candidates = await prisma.examQuestion.findMany({
    where: {
      transcribedStem: { not: null },
      diagramImageData: { not: null },
      examPaper: {
        sourceExamId: null,
        paperType: null,
        subject: { contains: "Math", mode: "insensitive" },
      },
    },
    select: {
      id: true,
      transcribedStem: true,
      answer: true,
      diagramImageData: true,
      examPaper: { select: { title: true } },
    },
    take: 4000,
  });

  function find(predicate: (q: typeof candidates[number]) => boolean) {
    return candidates.find(predicate);
  }

  const beads = find(q =>
    /grey.*white.*bead/i.test(q.transcribedStem ?? "")
    && /Tao Nan/i.test(q.examPaper.title)
  );
  const rosyth = find(q =>
    /\bRosyth\b/i.test(q.examPaper.title)
    && /Study the pattern below/i.test(q.transcribedStem ?? "")
  );
  const triComp = find(q =>
    /\bACS\s*-?\s*J\b/i.test(q.examPaper.title)
    && /Figure 1 is an isosceles triangle/i.test(q.transcribedStem ?? "")
  );

  const finalPicks: Array<{ row: typeof candidates[number] | undefined; outName: string; note: string }> = [
    { row: beads,   outName: "pattern-b-beads",            note: "Pattern B (growing sums)" },
    { row: rosyth,  outName: "pattern-c-squares",          note: "Pattern C (square numbers)" },
    { row: triComp, outName: "shape-composition-triangles", note: "Shape composition" },
  ];

  const outDir = path.join(process.cwd(), "public", "master-class", "patterns");
  fs.mkdirSync(outDir, { recursive: true });

  for (const p of finalPicks) {
    if (!p.row?.diagramImageData) {
      console.log(`SKIP ${p.outName} — no row matched`);
      continue;
    }
    const data = p.row.diagramImageData;
    // Strip any data: prefix
    const b64 = data.replace(/^data:image\/[a-z]+;base64,/, "");
    const buf = Buffer.from(b64, "base64");
    const outPath = path.join(outDir, `${p.outName}.png`);
    fs.writeFileSync(outPath, buf);
    console.log(`OK   ${p.outName}  (${(buf.length / 1024).toFixed(1)} KB)  ${p.note}`);
    console.log(`     id=${p.row.id}  paper=${p.row.examPaper.title}`);
  }

  // suppress unused-var warning for the static PICKS list (kept as
  // intent-as-code in case lookup fails and we need a known-good id)
  void PICKS;
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
