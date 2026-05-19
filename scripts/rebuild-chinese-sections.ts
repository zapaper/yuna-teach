// Rebuild paper.metadata.chineseSections from the current
// sectionOcrTexts + question.syllabusTopic. Use when a previous
// extraction left a stale label (e.g. "Dialogue Completion") in the
// chineseSections array even though the questions and section OCR
// have already been canonicalised.
//
// Usage: npx tsx scripts/rebuild-chinese-sections.ts <paperId>
import { prisma } from "../src/lib/db";
import { buildChineseSections, type OcrEntry } from "../src/lib/extraction";

(async () => {
  const id = process.argv[2];
  if (!id) {
    console.error("Usage: npx tsx scripts/rebuild-chinese-sections.ts <paperId>");
    process.exit(1);
  }
  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: { id: true, title: true, metadata: true,
      questions: { orderBy: { orderIndex: "asc" }, select: { pageIndex: true, syllabusTopic: true } },
    },
  });
  if (!paper) { console.error("Paper not found"); process.exit(1); }
  console.log(`Paper: ${paper.title}`);
  const meta = (paper.metadata ?? {}) as Record<string, unknown>;
  const allOcr = (meta.sectionOcrTexts ?? {}) as Record<string, OcrEntry>;
  console.log("Existing chineseSections labels:", ((meta.chineseSections ?? []) as Array<{ label: string }>).map(s => s.label));
  const built = buildChineseSections(paper.questions, allOcr);
  console.log("\nRebuilt sections:");
  for (const s of built) {
    console.log(`  "${s.label}"  range ${s.startIndex}-${s.endIndex}  passageLen=${s.passage?.length ?? 0}`);
  }
  await prisma.examPaper.update({
    where: { id },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { metadata: { ...meta, chineseSections: built } as any },
  });
  console.log("\nUpdated.");
  await prisma.$disconnect();
})();
