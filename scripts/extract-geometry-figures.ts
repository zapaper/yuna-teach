// Pull the original question images for the PSLE Math Geometry
// questions cited in the math-geometry-angles master class. Save them
// as PNGs under public/master-class/math-geometry-angles/ so the
// `diagramImage` field can reference them.

import { prisma } from "../src/lib/db";
import { promises as fs } from "fs";
import path from "path";

const OUT_DIR = path.join(__dirname, "..", "public", "master-class", "math-geometry-angles");

// Each entry maps a slide pattern to the PSLE source question.
// year + questionNum match ExamPaper.year and ExamQuestion.questionNum
// (we'll match flexibly since questionNum may be "27" or "P2-7" etc).
const TARGETS = [
  { slide: "pattern-a", year: "2020", questionNum: "23",   note: "PSLE 2020 Q23 — equilateral + reflex angle (180 vs 360 trap)" },
  { slide: "pattern-b", year: "2017", questionNum: "27",   note: "PSLE 2017 Q27 — parallelogram + transversal (co-interior)" },
  { slide: "pattern-c", year: "2021", questionNum: "P2-13", note: "PSLE 2021 QP2-13 — trapezium with isosceles, 4-mark" },
  { slide: "pattern-d", year: "2016", questionNum: "P2-7",  note: "PSLE 2016 QP2-7 — parallelogram + rhombus glued, 4-mark" },
  { slide: "pattern-e", year: "2022", questionNum: "13",   note: "PSLE 2022 Q13 — folded rectangle to trapezium" },
];

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  // Find all 10 PSLE Math papers by year — these are the master papers
  // (sourceExamId null, title contains "PSLE Math" or just year + Math).
  const papers = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      subject: { contains: "math", mode: "insensitive" },
      year: { not: null },
      NOT: { title: { startsWith: "Test Quiz" } },
      title: { contains: "PSLE", mode: "insensitive" },
    },
    select: { id: true, title: true, year: true },
  });
  const byYear = new Map<string, string>();
  for (const p of papers) {
    if (p.year && !byYear.has(p.year)) byYear.set(p.year, p.id);
  }
  console.log("Found PSLE Math papers:");
  for (const [y, id] of byYear) console.log(`  ${y}: ${id}`);
  console.log();

  for (const t of TARGETS) {
    const paperId = byYear.get(t.year);
    if (!paperId) { console.log(`❌ ${t.slide}: no paper for ${t.year}`); continue; }

    // questionNum may be "23" or "Q23" or "P2-13" — match flexibly. P2
    // questions are in Booklet B (typically question_num >= some
    // threshold, but the simplest is to look for the exact questionNum
    // as stored OR with common prefixes/suffixes).
    const candidates = await prisma.examQuestion.findMany({
      where: {
        examPaperId: paperId,
        OR: [
          { questionNum: t.questionNum },
          { questionNum: `Q${t.questionNum}` },
          { questionNum: { endsWith: `-${t.questionNum}` } },
          { questionNum: { contains: `P2-${t.questionNum}` } },
          { questionNum: { contains: `Q${t.questionNum}` } },
        ],
      },
      select: { id: true, questionNum: true, imageData: true, marksAvailable: true, syllabusTopic: true },
    });
    if (candidates.length === 0) { console.log(`❌ ${t.slide} (${t.year} Q${t.questionNum}): no match`); continue; }

    // Prefer one tagged as Geometry if multiple.
    const pick = candidates.find(q => (q.syllabusTopic ?? "").toLowerCase().includes("geomet")) ?? candidates[0];
    if (candidates.length > 1) {
      console.log(`⚠ ${t.slide} (${t.year} Q${t.questionNum}): ${candidates.length} matches, using questionNum="${pick.questionNum}" (topic="${pick.syllabusTopic}")`);
    }

    if (!pick.imageData) { console.log(`❌ ${t.slide}: ${pick.questionNum} has no imageData`); continue; }

    // imageData is a data URL like "data:image/png;base64,iVBORw0..." —
    // strip the prefix.
    const dataUrl = pick.imageData;
    const m = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!m) { console.log(`❌ ${t.slide}: imageData isn't a data URL`); continue; }
    const ext = m[1];
    const b64 = m[2];
    const outPath = path.join(OUT_DIR, `${t.slide}.${ext}`);
    await fs.writeFile(outPath, Buffer.from(b64, "base64"));
    const bytes = Buffer.byteLength(b64, "base64");
    console.log(`✅ ${t.slide}: ${t.year} Q${pick.questionNum} → ${path.basename(outPath)} (${bytes} bytes, ${pick.marksAvailable}m)`);
  }

  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
