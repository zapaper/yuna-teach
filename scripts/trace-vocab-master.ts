import { prisma } from "../src/lib/db";
(async () => {
  const ID = "cmonui8ed006b8eod68tn71tr";
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: ID, questionNum: { in: ["6", "7", "8", "9"] } },
    orderBy: { orderIndex: "asc" },
    select: { questionNum: true, sourceQuestionId: true },
  });
  console.log("Clone vocab questions:");
  for (const q of qs) console.log(`  Q${q.questionNum}  src=${q.sourceQuestionId}`);

  const sourceIds = qs.map(q => q.sourceQuestionId).filter((x): x is string => !!x);
  const masters = await prisma.examQuestion.findMany({
    where: { id: { in: sourceIds } },
    select: { id: true, questionNum: true, examPaperId: true, examPaper: { select: { title: true } } },
  });
  for (const m of masters) {
    console.log(`  master ${m.id}  Q${m.questionNum}  in "${m.examPaper.title}" (${m.examPaperId})`);
  }

  // All masters should be from the same paper. Pull its metadata.
  const masterPaperIds = [...new Set(masters.map(m => m.examPaperId))];
  for (const mpid of masterPaperIds) {
    const mp = await prisma.examPaper.findUnique({
      where: { id: mpid },
      select: { id: true, title: true, metadata: true },
    });
    const meta = mp?.metadata as Record<string, unknown> | null;
    const sectionOcr = meta?.sectionOcrTexts as Record<string, { ocrText?: string; passageOcrText?: string }> | undefined;
    console.log(`\n=== Master "${mp?.title}" (${mp?.id}) sectionOcrTexts keys: ${sectionOcr ? Object.keys(sectionOcr).join(", ") : "(none)"} ===`);
    if (sectionOcr) {
      for (const [name, info] of Object.entries(sectionOcr)) {
        if (name.toLowerCase().includes("vocab") && name.toLowerCase().includes("cloze")) {
          console.log(`\n--- Master section "${name}" ocrText: ---`);
          console.log(info?.ocrText ?? "(empty)");
          console.log(`--- (${(info?.ocrText ?? "").length} chars) ---`);
          if (info?.passageOcrText) {
            console.log(`\n--- Master section "${name}" passageOcrText: ---`);
            console.log(info.passageOcrText);
          }
        }
      }
    }
  }
  await prisma.$disconnect();
})();
