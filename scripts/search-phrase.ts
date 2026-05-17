import { prisma } from "../src/lib/db";

(async () => {
  const phrase = "The debate over whether smartphones";
  const papers = await prisma.examPaper.findMany({
    where: {
      subject: { contains: "english", mode: "insensitive" },
      sourceExamId: null,
    },
    select: { id: true, title: true, metadata: true },
  });
  console.log(`Searching ${papers.length} master English papers...`);
  for (const p of papers) {
    const meta = p.metadata as Record<string, unknown> | null;
    const sect = meta?.sectionOcrTexts as Record<string, { ocrText?: string; passageOcrText?: string }> | undefined;
    if (!sect) continue;
    for (const [label, info] of Object.entries(sect)) {
      const text = info?.passageOcrText ?? info?.ocrText ?? "";
      if (typeof text === "string" && text.toLowerCase().includes(phrase.toLowerCase())) {
        console.log(`MATCH: ${p.id} "${p.title}" — section "${label}"`);
      }
    }
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
