import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const PAPER_ID = process.argv[2] ?? "cmp8gfuds0001uaerck6epajj";
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER_ID },
    select: { metadata: true },
  });
  const meta = paper?.metadata as Record<string, unknown> | null;
  const ocrTexts = (meta as { sectionOcrTexts?: Record<string, { ocrText?: string; passageOcrText?: string; pageIndices?: number[] }> } | null)?.sectionOcrTexts ?? {};
  for (const [k, v] of Object.entries(ocrTexts)) {
    console.log(`\n=== "${k}" (pages ${JSON.stringify(v.pageIndices ?? "n/a")}) ===`);
    if (v.ocrText) console.log("OCR (first 200 chars):", v.ocrText.slice(0, 200).replace(/\n/g, "\\n"));
    if (v.passageOcrText) console.log("Passage (first 200 chars):", v.passageOcrText.slice(0, 200).replace(/\n/g, "\\n"));
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
