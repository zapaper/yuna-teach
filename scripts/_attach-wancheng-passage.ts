// Attaches the 完成对话 passage onto its chineseSections entry for a
// specific paper where extraction skipped the attach step (the
// section had been mis-labelled "Dialogue Completion" at the time
// of extraction, so the label-based gate in extraction.ts:1108
// fell through and the passage never landed on the section).
//
// Reads sectionOcrTexts["完成对话"].ocrText and writes it onto the
// matching chineseSections entry's `passage` field. No other section
// is touched.

import { prisma } from "../src/lib/db";

const PAPER = "cmq62fbk2001veykw3fwzjgq1";
const TARGET_LABEL = "完成对话";

(async () => {
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER },
    select: { title: true, metadata: true },
  });
  if (!paper) { console.error("paper not found"); process.exit(1); }
  console.log(`Paper: ${paper.title}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const md = (paper.metadata as Record<string, any>) ?? {};
  const sections = (md.chineseSections as Array<Record<string, unknown>> | undefined) ?? [];
  const target = sections.find((s) => s.label === TARGET_LABEL);
  if (!target) {
    console.error(`No "${TARGET_LABEL}" section found in metadata.chineseSections`);
    process.exit(1);
  }
  if (typeof target.passage === "string" && (target.passage as string).length > 0) {
    console.log(`"${TARGET_LABEL}" already has a passage (${(target.passage as string).length} chars). No change.`);
    return;
  }

  const ocrTexts = (md.sectionOcrTexts as Record<string, { ocrText?: string }> | undefined) ?? {};
  const ocr = ocrTexts[TARGET_LABEL]?.ocrText;
  if (!ocr) {
    console.error(`No OCR text at sectionOcrTexts["${TARGET_LABEL}"] — nothing to attach`);
    process.exit(1);
  }
  console.log(`Attaching ${ocr.length} chars from sectionOcrTexts["${TARGET_LABEL}"].ocrText to chineseSections entry`);
  target.passage = ocr;

  await prisma.examPaper.update({
    where: { id: PAPER },
    data: { metadata: md },
  });
  console.log("done");
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
