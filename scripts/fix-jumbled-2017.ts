// One-shot DB fix for jumbled PSLE CHINESE 2017 extractions.
//
// Bugs:
//   1. Some questions stored with a bare "Q" prefix ("Q30", "Q31", "Q32")
//      while others are bare digits. The sort step parses parseInt("Q30")
//      → NaN → 0, sending them to ord=0,1,2 ahead of Q1-Q29.
//   2. Spurious "Paper 2 Booklet A" / "Paper 2 Booklet B" split.
//   3. chineseSections needs rebuild after we fix questionNum & reorder.
//
// Code fix in extraction.ts is also in place — this script is for the
// two existing extractions in the DB. Pass paper IDs as CLI args.

import { prisma } from "../src/lib/db";
import { buildChineseSections, type OcrEntry } from "../src/lib/extraction";

// Filter out non-id args (e.g. dotenv_config_path=.env).
const PAPER_IDS = process.argv.slice(2).filter(a => /^cm[0-9a-z]{20,}$/i.test(a));
if (PAPER_IDS.length === 0) {
  // Default targets — the two known broken 2017 extractions.
  PAPER_IDS.push("cmphofdc80001hqjexjvvngxt");
  PAPER_IDS.push("cmphozav10001zlwc4eez751s");
}

(async () => {
  for (const id of PAPER_IDS) {
    const paper = await prisma.examPaper.findUnique({
      where: { id },
      select: {
        id: true, title: true, metadata: true,
        questions: { orderBy: { orderIndex: "asc" }, select: { id: true, questionNum: true, pageIndex: true, syllabusTopic: true } },
      },
    });
    if (!paper) { console.log(`Skip ${id}: not found`); continue; }
    console.log(`\nFixing: ${paper.title} (${id})`);

    // 1. Strip bare "Q"/"q" prefix from questionNum so parseInt works
    //    consistently in the sort below.
    const renamed: Array<{ id: string; from: string; to: string }> = [];
    for (const q of paper.questions) {
      const cleaned = q.questionNum.replace(/^[QqPp]+/, "").trim();
      if (cleaned !== q.questionNum && cleaned.length > 0) {
        await prisma.examQuestion.update({ where: { id: q.id }, data: { questionNum: cleaned } });
        renamed.push({ id: q.id, from: q.questionNum, to: cleaned });
      }
    }
    if (renamed.length > 0) {
      console.log(`  renamed ${renamed.length} questions:`);
      for (const r of renamed) console.log(`    "${r.from}" → "${r.to}"`);
    }

    // 2. Re-sort orderIndex by (pageIndex asc, then numeric question num asc).
    const fresh = await prisma.examQuestion.findMany({
      where: { examPaperId: id },
      select: { id: true, questionNum: true, pageIndex: true },
    });
    const numOf = (qn: string) => {
      const m = qn.match(/\d+/);
      return m ? parseInt(m[0], 10) : 9999;
    };
    fresh.sort((a, b) => {
      if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
      return numOf(a.questionNum) - numOf(b.questionNum);
    });
    for (let i = 0; i < fresh.length; i++) {
      await prisma.examQuestion.update({ where: { id: fresh[i].id }, data: { orderIndex: i } });
    }
    console.log(`  re-indexed ${fresh.length} questions (page-major, then numeric)`);

    // 3. Collapse Paper 2 Booklet A/B in metadata into a single Paper 2 entry.
    const meta = (paper.metadata ?? {}) as Record<string, unknown>;
    const papers = (meta.papers as Array<{ label: string; skipExtraction?: boolean; pageIndices?: number[] }> | undefined) ?? [];
    const collapsedPapers: typeof papers = [];
    let paper2Pages: number[] = [];
    let hadBooklets = false;
    for (const p of papers) {
      if (p.label === "Paper 2 Booklet A" || p.label === "Paper 2 Booklet B") {
        hadBooklets = true;
        paper2Pages = paper2Pages.concat(p.pageIndices ?? []);
      } else {
        collapsedPapers.push(p);
      }
    }
    if (hadBooklets) {
      collapsedPapers.push({ label: "Paper 2", skipExtraction: false, pageIndices: paper2Pages.length > 0 ? paper2Pages : undefined });
      console.log(`  collapsed Booklet A + B → single Paper 2`);
    }

    // 4. Rebuild chineseSections from the corrected questions + existing OCR.
    const reloaded = await prisma.examQuestion.findMany({
      where: { examPaperId: id },
      orderBy: { orderIndex: "asc" },
      select: { pageIndex: true, syllabusTopic: true },
    });
    const allOcr = (meta.sectionOcrTexts ?? {}) as Record<string, OcrEntry>;
    const built = buildChineseSections(reloaded, allOcr);
    console.log(`  rebuilt chineseSections:`);
    for (const s of built) {
      console.log(`    "${s.label}"  Q[${s.startIndex}..${s.endIndex}]`);
    }

    await prisma.examPaper.update({
      where: { id },
      data: { metadata: { ...meta, papers: collapsedPapers, chineseSections: built } as Record<string, unknown> },
    });
  }
  console.log(`\nDone.`);
  await prisma.$disconnect();
})();
