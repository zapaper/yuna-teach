import { prisma } from "../src/lib/db";

async function main() {
  const id = "cmpvv2rni005x1k55nmbwpva2";
  const p = await prisma.examPaper.findUnique({
    where: { id },
    select: {
      id: true, title: true, subject: true, paperType: true,
      sourceExamId: true, pdfPath: true, pageCount: true,
      assignedToId: true,
      metadata: true,
    },
  });
  console.log("Paper:", JSON.stringify(p, null, 2));
  if (p?.sourceExamId) {
    const src = await prisma.examPaper.findUnique({
      where: { id: p.sourceExamId },
      select: { id: true, title: true, pdfPath: true, subject: true },
    });
    console.log("Source:", src);
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
