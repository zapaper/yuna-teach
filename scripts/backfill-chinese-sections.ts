// One-off: build the `chineseSections` metadata array for an already-
// extracted Chinese paper. Mirrors the buildChineseSections helper now
// shipped in src/lib/extraction.ts, but runs against a saved paper so
// it doesn't require re-extraction. Usage:
//   npx tsx scripts/backfill-chinese-sections.ts <paperId>
// Pass no id to backfill EVERY Chinese paper that's missing the
// metadata field.

import { PrismaClient } from "@prisma/client";

type OcrEntry = { ocrText?: string; passageOcrText?: string; pageIndices?: number[] };
type Sec = { label: string; startIndex: number; endIndex: number; passage?: string };

function build(
  questions: Array<{ pageIndex: number; syllabusTopic: string | null }>,
  sectionOcrTexts: Record<string, OcrEntry> | null,
): Sec[] {
  if (questions.length === 0) return [];
  const sections: Sec[] = [];
  let curLabel = "";
  let curStart = -1;
  let curBoundaryPage = -1;
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const label = (q.syllabusTopic ?? "").trim();
    const isCompSec = label.includes("阅读理解");
    const boundaryPage = isCompSec ? q.pageIndex : -1;
    const startsNew = label !== curLabel || boundaryPage !== curBoundaryPage;
    if (startsNew && curStart >= 0) {
      sections.push({ label: curLabel, startIndex: curStart, endIndex: i - 1 });
    }
    if (startsNew) { curLabel = label; curStart = i; curBoundaryPage = boundaryPage; }
  }
  if (curStart >= 0) sections.push({ label: curLabel, startIndex: curStart, endIndex: questions.length - 1 });

  if (!sectionOcrTexts) return sections;
  const ocr = sectionOcrTexts;
  const ocrKeys = Object.keys(ocr);
  const find = (label: string, pages: Set<number>): string | null => {
    for (const k of ocrKeys.filter(k => k.startsWith(label + " (pp"))) {
      const m = k.match(/\(pp(\d+)-(\d+)\)$/);
      if (!m) continue;
      const a = parseInt(m[1], 10); const b = parseInt(m[2], 10);
      for (let p = a; p <= b; p++) if (pages.has(p)) return k;
    }
    for (const k of ocrKeys) {
      if (k !== label && !k.startsWith(label + " (")) continue;
      const e = ocr[k];
      if (!e?.pageIndices) continue;
      if (e.pageIndices.some(p => pages.has(p))) return k;
    }
    if (ocrKeys.includes(label)) return label;
    return null;
  };
  let lastCompPassage: string | undefined;
  let lastCompPages: Set<number> | undefined;
  for (const sec of sections) {
    const pages = new Set<number>();
    for (let i = sec.startIndex; i <= sec.endIndex; i++) pages.add(questions[i].pageIndex);
    const k = find(sec.label, pages);
    const e = k ? ocr[k] : null;
    if (sec.label.includes("阅读理解")) {
      const p = e?.passageOcrText;
      if (p) { sec.passage = p; lastCompPassage = p; lastCompPages = pages; }
      else if (lastCompPassage && lastCompPages) {
        const minPrev = Math.min(...lastCompPages); const maxPrev = Math.max(...lastCompPages);
        const minThis = Math.min(...pages); const maxThis = Math.max(...pages);
        const adjacent = (minThis - maxPrev <= 1 && minThis - maxPrev >= 0) || (minPrev - maxThis <= 1 && minPrev - maxThis >= 0);
        if (adjacent) sec.passage = lastCompPassage;
      }
    } else if (sec.label.includes("短文填空") || sec.label.includes("完成对话") || sec.label.includes("对话填空")) {
      sec.passage = e?.ocrText;
    }
  }
  return sections;
}

const prisma = new PrismaClient();
async function main() {
  const paperId = process.argv[2];
  const where = paperId
    ? { id: paperId }
    : { subject: { contains: "chinese", mode: "insensitive" as const } };
  const papers = await prisma.examPaper.findMany({
    where,
    select: { id: true, title: true, subject: true, metadata: true },
  });
  for (const paper of papers) {
    const meta = (paper.metadata as Record<string, unknown> | null) ?? {};
    if ((meta as { chineseSections?: unknown }).chineseSections && !paperId) {
      console.log(`SKIP ${paper.id} — already has chineseSections`);
      continue;
    }
    const ocr = (meta as { sectionOcrTexts?: Record<string, OcrEntry> }).sectionOcrTexts ?? null;
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: paper.id },
      orderBy: { orderIndex: "asc" },
      select: { pageIndex: true, syllabusTopic: true },
    });
    const chineseSections = build(qs, ocr);
    console.log(`\n${paper.id} | ${paper.title}`);
    for (const s of chineseSections) {
      console.log(`  ${s.label.padEnd(20)} [${s.startIndex}-${s.endIndex}] ${s.passage ? `passage=${s.passage.length}ch` : "(no passage)"}`);
    }
    await prisma.examPaper.update({
      where: { id: paper.id },
      data: { metadata: { ...meta, chineseSections } },
    });
    console.log(`  → saved ${chineseSections.length} sections`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
