import { prisma } from "../src/lib/db";
async function main() {
  const id = "cmq0tgcuc00011e0qqv3pfcjc";
  const p = await prisma.examPaper.findUnique({
    where: { id },
    select: { id: true, subject: true, paperType: true, sourceExamId: true, pageCount: true, metadata: true },
  });
  console.log("clone:", JSON.stringify({ id: p?.id, subject: p?.subject, paperType: p?.paperType, sourceExamId: p?.sourceExamId, pageCount: p?.pageCount }, null, 2));
  const meta = p?.metadata as Record<string, unknown> | null;
  console.log("clone.metadata keys:", Object.keys(meta ?? {}));
  console.log("clone.metadata.normalExtractChinese:", JSON.stringify(meta?.normalExtractChinese, null, 2));
  if (p?.sourceExamId) {
    const src = await prisma.examPaper.findUnique({ where: { id: p.sourceExamId }, select: { id: true, pageCount: true, metadata: true } });
    const smeta = src?.metadata as Record<string, unknown> | null;
    console.log("\nsource:", src?.id, "pageCount=", src?.pageCount);
    console.log("source.metadata.normalExtractChinese:", JSON.stringify(smeta?.normalExtractChinese, null, 2));
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
