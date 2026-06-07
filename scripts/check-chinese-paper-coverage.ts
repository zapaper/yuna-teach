// For each PSLE Chinese paper master in DB, check pageIndex coverage.
// PSLE Chinese is normally Paper 1 (composition) + Paper 2 (language
// use) + Paper 3 (oral). The PDFs on disk are combined documents.
// If pageIndex jumps from low pages straight to mid-document, the
// Paper 1 composition pages were skipped during extraction.

import { prisma } from "../src/lib/db";

const CHINESE_PAPERS = [
  { year: "2025", id: "cmphn6npc000112g1sdstau5j" },
  { year: "2024", id: "cmp9e8vzc0001ug93w4cq50y1" },
  { year: "2023", id: "cmp9msmx800018gvnz0suifzq" },
  { year: "2022", id: "cmp9muf3q00038gvnb269c3ht" },
  { year: "2021", id: "cmp9tqp7r004p11pg1emv5dty" },
  { year: "2020", id: "cmparv40c0003e4lrg48z2b7v" },
  { year: "2019", id: "cmparuwvl0001e4lryp826f9w" },
  { year: "2018", id: "cmphqacp9000198jkrd6ambui" },
  { year: "2017", id: "cmphphlfd0001ivva0cvmq0du" },
  { year: "2016", id: "cmphqli6g002b98jke0olegzj" },
];

async function main() {
  console.log("year\tpaperType\tpageCount\tquestion_pages_min\tmax\tunique\tmetadata_keys");
  for (const { year, id } of CHINESE_PAPERS) {
    const paper = await prisma.examPaper.findUnique({
      where: { id },
      select: { pageCount: true, metadata: true, paperType: true },
    });
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: id },
      select: { pageIndex: true, questionNum: true, syllabusTopic: true },
    });
    const pages = qs.map(q => q.pageIndex).filter((p): p is number => p != null);
    const min = pages.length ? Math.min(...pages) : -1;
    const max = pages.length ? Math.max(...pages) : -1;
    const unique = [...new Set(pages)].sort((a, b) => a - b);
    const metaKeys = paper?.metadata && typeof paper.metadata === "object"
      ? Object.keys(paper.metadata as Record<string, unknown>).join(",")
      : "(none)";
    console.log(`${year}\t${paper?.paperType ?? "null"}\t${paper?.pageCount ?? "?"}\t${min}\t${max}\t[${unique.join(",")}]\t${metaKeys}`);
  }

  // Look at the topics covered. If only Paper 2 was extracted, we'd
  // expect Pinyin / Vocabulary / Sentence / Comprehension MCQ topics.
  // Composition (作文) and Oral (口试) wouldn't appear as syllabusTopic.
  console.log("\n=== Topics across PSLE Chinese 2025 (sample) ===");
  const q2025 = await prisma.examQuestion.findMany({
    where: { examPaperId: "cmphn6npc000112g1sdstau5j" },
    select: { questionNum: true, syllabusTopic: true, pageIndex: true },
    orderBy: { orderIndex: "asc" },
  });
  for (const q of q2025) {
    console.log(`  Q${q.questionNum} (page ${q.pageIndex}): ${q.syllabusTopic ?? "(no topic)"}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
