import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const m = await prisma.examPaper.findUnique({
    where: { id: "cmp6f6ihd002g37vduhg9twau" },
    select: { title: true, metadata: true, sourceExamId: true },
  });
  if (!m) return console.log("not found");
  console.log("Title:", m.title);
  console.log("sourceExamId:", m.sourceExamId);
  const meta = m.metadata as Record<string, unknown> | null;
  console.log("metadata top keys:", meta ? Object.keys(meta) : "(none)");
  const ocr = meta?.sectionOcrTexts as Record<string, { ocrText?: string; passageOcrText?: string }> | undefined;
  if (!ocr) return console.log("no sectionOcrTexts");
  console.log("\nsectionOcrTexts keys:", Object.keys(ocr));
  for (const [name, data] of Object.entries(ocr)) {
    console.log(`\n=== "${name}" ===`);
    console.log("data keys:", Object.keys(data));
    if (data.ocrText) console.log("ocrText (first 800):\n" + data.ocrText.slice(0, 800));
    if (data.passageOcrText) console.log("\npassageOcrText (first 1200):\n" + data.passageOcrText.slice(0, 1200));
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
