// One-shot DB fix for PSLE CHINESE 2017 (paper cmphofdc80001hqjexjvvngxt).
//
// Bugs left by the structure-analysis pass:
//   1. The 阅读理解 A 组 MCQ portion (Q30-Q32, page 20) was emitted as
//      questionNum "QQ30"/"QQ31"/"QQ32" (double-Q prefix) and given
//      orderIndex 0/1/2 — so they sit at the TOP of the question list
//      instead of between Q29 and Q33.
//   2. The papers metadata wrongly split Paper 2 into "Booklet A" and
//      "Booklet B" — Chinese Paper 2 is one booklet.
//   3. The chineseSections array has a stray "阅读理解 MCQ" entry
//      covering Q[0..2] (the QQ30-32 entries) instead of being merged
//      with the A 组 OEQ entry.
//
// Fix: rename QQ→Q on the three questions, re-sort orderIndex by
// (pageIndex, current questionNum), collapse the Booklet A/B split,
// and rebuild chineseSections from the corrected question topics.

import { prisma } from "../src/lib/db";
import { buildChineseSections, type OcrEntry } from "../src/lib/extraction";

const PAPER_ID = "cmphofdc80001hqjexjvvngxt";

(async () => {
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: {
      id: true, title: true, metadata: true,
      questions: { orderBy: { orderIndex: "asc" }, select: { id: true, questionNum: true, pageIndex: true, syllabusTopic: true } },
    },
  });
  if (!paper) throw new Error("Paper not found");
  console.log(`Fixing: ${paper.title}`);

  // 1. Rename QQ30/QQ31/QQ32 → Q30/Q31/Q32 in DB.
  const bogus = paper.questions.filter(q => /^Q{2,}\d+/.test(q.questionNum));
  for (const q of bogus) {
    const fixed = q.questionNum.replace(/^Q+/, "Q");
    console.log(`  rename ${q.questionNum} → ${fixed}`);
    await prisma.examQuestion.update({ where: { id: q.id }, data: { questionNum: fixed } });
  }

  // 2. Re-sort orderIndex by (pageIndex asc, then numeric question num asc).
  // Reload after rename so we use the canonical numbers.
  const fresh = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID },
    select: { id: true, questionNum: true, pageIndex: true },
  });
  const numOf = (qn: string) => {
    const m = qn.replace(/^Q+/, "").match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : 9999;
  };
  fresh.sort((a, b) => {
    if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
    return numOf(a.questionNum) - numOf(b.questionNum);
  });
  for (let i = 0; i < fresh.length; i++) {
    if (fresh[i] !== undefined) {
      await prisma.examQuestion.update({ where: { id: fresh[i].id }, data: { orderIndex: i } });
    }
  }
  console.log(`  re-indexed ${fresh.length} questions (page-major, then numeric)`);

  // 3. Collapse Paper 2 Booklet A/B in metadata into a single Paper 2 entry.
  const meta = (paper.metadata ?? {}) as Record<string, unknown>;
  const papers = (meta.papers as Array<{ label: string; skipExtraction?: boolean; pageIndices?: number[] }> | undefined) ?? [];
  const collapsedPapers: typeof papers = [];
  let paper2Pages: number[] = [];
  for (const p of papers) {
    if (p.label === "Paper 2 Booklet A" || p.label === "Paper 2 Booklet B") {
      paper2Pages = paper2Pages.concat(p.pageIndices ?? []);
    } else {
      collapsedPapers.push(p);
    }
  }
  if (paper2Pages.length > 0 || papers.some(p => p.label.startsWith("Paper 2 Booklet"))) {
    collapsedPapers.push({ label: "Paper 2", skipExtraction: false, pageIndices: paper2Pages.length > 0 ? paper2Pages : undefined });
    console.log(`  collapsed Booklet A + B → single Paper 2`);
  }

  // 4. Rebuild chineseSections from the corrected questions + existing OCR.
  const reloaded = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID },
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
    where: { id: PAPER_ID },
    data: { metadata: { ...meta, papers: collapsedPapers, chineseSections: built } as Record<string, unknown> },
  });
  console.log(`\nDone.`);
  await prisma.$disconnect();
})();
