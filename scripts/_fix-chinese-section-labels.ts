// Normalises English-translated Chinese section labels back to their
// canonical 中文 form on a single paper, then re-attaches passages from
// sectionOcrTexts. Generalised version of _fix-dialogue-completion-label
// — same problem but for any section the extractor accidentally
// translated. Iterates the chineseSections array + per-question
// syllabusTopic field and updates both.
//
// Usage:
//   DATABASE_URL=... npx tsx scripts/_fix-chinese-section-labels.ts <paperId>

import { prisma } from "../src/lib/db";

const LABEL_MAP: Record<string, string> = {
  // English → canonical Chinese label
  "Dialogue Completion": "完成对话",
  "Short Passage Cloze": "短文填空",
  "Passage Cloze": "短文填空",
  "Chinese Language Application": "语文应用 MCQ",
  "Language Application MCQ": "语文应用 MCQ",
  "Comprehension MCQ": "阅读理解 MCQ",
  "Comprehension OEQ": "阅读理解 OEQ",
  "Comprehension A": "阅读理解 A",
  "Comprehension B OEQ": "阅读理解 B OEQ",
};
const PASSAGE_KEYS = new Set(["短文填空", "完成对话", "对话填空"]);

(async () => {
  const PAPER = process.argv[2];
  if (!PAPER) {
    console.error("Usage: _fix-chinese-section-labels.ts <paperId>");
    process.exit(1);
  }
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER },
    select: { title: true, metadata: true },
  });
  if (!paper) { console.error("paper not found"); process.exit(1); }
  console.log(`Paper: ${paper.title}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const md = (paper.metadata as Record<string, any>) ?? {};
  const sections = (md.chineseSections as Array<Record<string, unknown>> | undefined) ?? [];
  const ocrTexts = (md.sectionOcrTexts as Record<string, { ocrText?: string }> | undefined) ?? {};

  let sectionRenames = 0;
  let passagesAttached = 0;
  for (const s of sections) {
    const label = s.label as string;
    if (label in LABEL_MAP) {
      const canonical = LABEL_MAP[label];
      console.log(`  Section "${label}" → "${canonical}"`);
      s.label = canonical;
      sectionRenames++;
      // Attach passage from sectionOcrTexts if the section needs one
      // and doesn't have one yet.
      if (PASSAGE_KEYS.has(canonical) && (typeof s.passage !== "string" || (s.passage as string).length === 0)) {
        const ocr = ocrTexts[canonical]?.ocrText;
        if (ocr) {
          s.passage = ocr;
          passagesAttached++;
          console.log(`    + attached passage (${ocr.length} chars) from sectionOcrTexts["${canonical}"]`);
        }
      }
    }
  }
  if (sectionRenames > 0) {
    await prisma.examPaper.update({
      where: { id: PAPER },
      data: { metadata: md },
    });
    console.log(`metadata: ${sectionRenames} section(s) relabelled, ${passagesAttached} passage(s) re-attached`);
  } else {
    console.log("metadata.chineseSections: nothing to relabel");
  }

  // Per-question syllabusTopic relabels
  for (const [oldLabel, newLabel] of Object.entries(LABEL_MAP)) {
    const r = await prisma.examQuestion.updateMany({
      where: { examPaperId: PAPER, syllabusTopic: oldLabel },
      data: { syllabusTopic: newLabel },
    });
    if (r.count > 0) console.log(`examQuestion.syllabusTopic: relabelled ${r.count} question(s) "${oldLabel}" → "${newLabel}"`);
  }

  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
