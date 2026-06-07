// Pull the diagram crop for every 4-5 mark combined-figure area
// question across the 10 PSLE Math papers (2016-2025). Saves each
// diagram as a JPG/PNG in scripts/combined-figure-diagrams/ so the
// user can assemble them into a social media post.
//
// Source IDs come from scripts/dump-psle-math.ts. We filter the
// classified-v2 dump for trap = combined_figure_area_subtraction
// AND marksAvailable >= 4.

import { promises as fs } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";

type C = { questionNum: string; topic: string; traps: string[] };
type Q = {
  questionNum: string;
  marksAvailable: number | null;
  transcribedStem: string | null;
};
type Paper = { year: string; title: string; questions: Q[]; classifications: C[] };

const norm = (s: string) => s.replace(/^Q/, "");

// Paper IDs (year -> exam paper id), copied from dump-psle-math.ts.
const TARGET_IDS: Record<string, string> = {
  "2016": "cmpkf6jrh0045k71ouyjjn7di",
  "2017": "cmpjvf68f0001k71oubxp62rj",
  "2018": "cmpjs41lz0001gd26r66w0v8h",
  "2019": "cmpjqks9d00jyeplmr3l2i0s4",
  "2020": "cmpcc1qm70001k9ivvjooq54y",
  "2021": "cmpc6eev50001bg96i6jxx91o",
  "2022": "cmpjlj8un00dseplma0mky71q",
  "2023": "cmpjjfakf002veplm4qvcdwxh",
  "2024": "cmpjjgg9q002xeplmp67euvmd",
  "2025": "cmpjbfr0a0001hx5ot7bzhurl",
};

async function main() {
  const raw = await fs.readFile(path.join(__dirname, "psle-math-classified-v2.json"), "utf8");
  const papers: Paper[] = JSON.parse(raw);

  const outDir = path.join(__dirname, "combined-figure-diagrams");
  await fs.mkdir(outDir, { recursive: true });

  const targets: Array<{ year: string; questionNum: string; marks: number; stem: string }> = [];
  for (const p of papers) {
    const classByNum = new Map(p.classifications.map(c => [norm(c.questionNum), c]));
    for (const q of p.questions) {
      const c = classByNum.get(norm(q.questionNum));
      if (!c?.traps?.includes("combined_figure_area_subtraction")) continue;
      if ((q.marksAvailable ?? 0) < 4) continue;
      targets.push({
        year: p.year,
        questionNum: q.questionNum,
        marks: q.marksAvailable ?? 0,
        stem: (q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 200),
      });
    }
  }
  console.log(`Found ${targets.length} 4-5 mark combined-figure questions:\n`);
  for (const t of targets) console.log(`  ${t.year} Q${t.questionNum} (${t.marks}m): ${t.stem}`);

  console.log(`\nExtracting diagrams to ${outDir}/...\n`);

  let saved = 0;
  let skipped = 0;
  for (const t of targets) {
    const paperId = TARGET_IDS[t.year];
    const q = await prisma.examQuestion.findFirst({
      where: { examPaperId: paperId, questionNum: t.questionNum },
      select: { id: true, diagramImageData: true, imageData: true },
    });
    if (!q) { console.log(`  ${t.year} Q${t.questionNum}: question row not found`); skipped++; continue; }
    // diagramImageData is stored as raw base64 (no data URL prefix).
    // imageData is stored as a data URL. Handle both.
    let buf: Buffer | null = null;
    let ext = "jpg";
    let source = "";
    if (q.diagramImageData) {
      buf = Buffer.from(q.diagramImageData, "base64");
      ext = "jpg"; // diagrams are always JPEG (magic bytes /9j/)
      source = "diagram";
    } else if (q.imageData) {
      const m = q.imageData.match(/^data:(image\/(\w+));base64,(.+)$/);
      if (m) {
        ext = m[2] === "jpeg" ? "jpg" : m[2];
        buf = Buffer.from(m[3], "base64");
        source = "fullimage";
      }
    }
    if (!buf) { console.log(`  ${t.year} Q${t.questionNum}: no usable image`); skipped++; continue; }
    const filename = `${t.year}_Q${t.questionNum}_${t.marks}m_${source}.${ext}`;
    await fs.writeFile(path.join(outDir, filename), buf);
    console.log(`  ${t.year} Q${t.questionNum} (${t.marks}m): saved ${filename} (${(buf.length / 1024).toFixed(0)} KB, ${source})`);
    saved++;
  }
  console.log(`\nSaved ${saved}, skipped ${skipped}.`);
  console.log(`\nFiles are in: ${outDir}`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
