// Pull the original question images for the PSLE Science Forces
// questions cited in the forces master class.
// Mirrors extract-geometry-figures.ts.

import { prisma } from "../src/lib/db";
import { promises as fs } from "fs";
import path from "path";

const OUT_DIR = path.join(__dirname, "..", "public", "master-class", "forces");

const TARGETS = [
  { slide: "pattern-a", year: "2021", questionNum: "20", note: "PSLE 2021 Q20 — wooden block + magnet on slope (name all forces)" },
  { slide: "pattern-b", year: "2018", questionNum: "37", note: "PSLE 2018 Q37 — phone slipping from charger (compare forces)" },
  { slide: "pattern-c", year: "2021", questionNum: "40", note: "PSLE 2021 Q40 — spring-launched toy rocket (energy chain)" },
  { slide: "pattern-d", year: "2019", questionNum: "38", note: "PSLE 2019 Q38 — magnet on balance + object A (5-mark killer)" },
];

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const papers = await prisma.examPaper.findMany({
    where: { sourceExamId: null, NOT: { title: { startsWith: "Test Quiz" } }, subject: { contains: "science", mode: "insensitive" }, title: { contains: "PSLE", mode: "insensitive" } },
    select: { id: true, year: true, title: true },
  });
  const byYear = new Map<string, string>();
  for (const p of papers) if (p.year && !byYear.has(p.year)) byYear.set(p.year, p.id);

  for (const t of TARGETS) {
    const paperId = byYear.get(t.year);
    if (!paperId) { console.log(`❌ ${t.slide}: no paper for ${t.year}`); continue; }
    const cands = await prisma.examQuestion.findMany({
      where: { examPaperId: paperId, questionNum: t.questionNum },
      select: { questionNum: true, imageData: true, diagramImageData: true, marksAvailable: true, syllabusTopic: true },
    });
    if (cands.length === 0) { console.log(`❌ ${t.slide}: ${t.year} Q${t.questionNum} not found`); continue; }
    const pick = cands[0];
    const source = pick.diagramImageData ?? pick.imageData;
    if (!source) { console.log(`❌ ${t.slide}: no image`); continue; }

    let ext: string, b64: string;
    const dataUrlMatch = source.match(/^data:image\/(\w+);base64,(.+)$/);
    if (dataUrlMatch) {
      ext = dataUrlMatch[1]; b64 = dataUrlMatch[2];
    } else {
      b64 = source.trim();
      const head = Buffer.from(b64.slice(0, 16), "base64");
      ext = (head[0] === 0xff && head[1] === 0xd8) ? "jpeg" : (head[0] === 0x89 && head[1] === 0x50) ? "png" : "jpeg";
    }
    const outPath = path.join(OUT_DIR, `${t.slide}.${ext}`);
    await fs.writeFile(outPath, Buffer.from(b64, "base64"));
    console.log(`✅ ${t.slide}: ${t.year} Q${pick.questionNum} → ${path.basename(outPath)} (${Buffer.byteLength(b64, "base64")} bytes, ${pick.marksAvailable}m, ${pick.diagramImageData ? "diagram-only" : "full"})`);
  }
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
