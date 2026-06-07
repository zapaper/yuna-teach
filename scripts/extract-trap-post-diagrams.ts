// Pull diagram crops (or full question images) for the 6 trap-post
// questions so the .docx generator can embed them.

import { prisma } from "../src/lib/db";
import { promises as fs } from "fs";
import path from "path";

const PAPER_IDS: Record<string, string> = {
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

// Same 6 picks as the post script. Output filename uses the post tag.
const PICKS = [
  { post: "1A_combined_2017", year: "2017", q: "P2-18" },
  { post: "1B_combined_2023", year: "2023", q: "P2-12" },
  { post: "2A_unitconv_2018", year: "2018", q: "24" },
  { post: "2B_unitconv_2021", year: "2021", q: "20" },
  { post: "3A_hidden_2019",   year: "2019", q: "13" },
  { post: "3B_hidden_2021",   year: "2021", q: "P2-15" },
];

async function main() {
  const outDir = path.join(__dirname, "trap-post-diagrams");
  await fs.mkdir(outDir, { recursive: true });
  for (const pick of PICKS) {
    const row = await prisma.examQuestion.findFirst({
      where: { examPaperId: PAPER_IDS[pick.year], questionNum: pick.q },
      select: { questionNum: true, marksAvailable: true, diagramImageData: true, imageData: true },
    });
    if (!row) { console.log(`MISSING ${pick.year} Q${pick.q}`); continue; }

    // diagramImageData is raw base64; imageData is data-URL.
    let buf: Buffer | null = null;
    let source = "";
    if (row.diagramImageData) {
      buf = Buffer.from(row.diagramImageData, "base64");
      source = "diagram-crop";
    } else if (row.imageData) {
      const m = row.imageData.match(/^data:(image\/(?:\w+));base64,(.+)$/);
      if (m) {
        buf = Buffer.from(m[2], "base64");
        source = "full-image";
      }
    }
    if (!buf) {
      console.log(`  ${pick.post}: NO IMAGE on disk (${row.diagramImageData ? "diagram present but unparseable" : "no diagram, no imageData — text-only question"})`);
      continue;
    }
    const fname = `${pick.post}.jpg`;
    await fs.writeFile(path.join(outDir, fname), buf);
    console.log(`  ${pick.post}: ${fname} (${(buf.length / 1024).toFixed(0)} KB, ${source})`);
  }
  console.log(`\nDiagrams in ${outDir}`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
