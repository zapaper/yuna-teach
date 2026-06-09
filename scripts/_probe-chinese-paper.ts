import { prisma } from "../src/lib/db";

(async () => {
  const PAPER = process.argv[2] ?? "cmq667hfe0001afidsmbm6lfw";
  const p = await prisma.examPaper.findUnique({
    where: { id: PAPER },
    select: { title: true, metadata: true },
  });
  if (!p) { console.log("not found"); return; }
  console.log(`Paper: ${p.title}\n`);
  const md = p.metadata as Record<string, unknown> | null;
  const chineseSections = (md?.chineseSections as Array<Record<string, unknown>> | undefined) ?? [];
  console.log(`chineseSections (${chineseSections.length}):`);
  for (const s of chineseSections) {
    const keys = Object.keys(s).sort();
    const summary: Record<string, unknown> = {};
    for (const k of keys) {
      summary[k] = k === "passage" && typeof s[k] === "string"
        ? `${(s[k] as string).length} chars`
        : s[k];
    }
    console.log(`  ${JSON.stringify(summary)}`);
  }
  const ocrTexts = (md?.sectionOcrTexts as Record<string, { ocrText?: string }> | undefined) ?? {};
  console.log(`\nsectionOcrTexts keys (${Object.keys(ocrTexts).length}):`);
  for (const k of Object.keys(ocrTexts)) {
    console.log(`  "${k}": ${ocrTexts[k]?.ocrText?.length ?? 0} chars`);
  }
  // Per-question syllabusTopic counts
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER, syllabusTopic: { not: null } },
    select: { questionNum: true, syllabusTopic: true },
    orderBy: { orderIndex: "asc" },
  });
  const byTopic = new Map<string, string[]>();
  for (const q of qs) {
    const t = q.syllabusTopic ?? "(none)";
    if (!byTopic.has(t)) byTopic.set(t, []);
    byTopic.get(t)!.push(q.questionNum);
  }
  console.log("\nsyllabusTopic distribution:");
  for (const [topic, nums] of byTopic.entries()) {
    console.log(`  "${topic}": Q${nums.join(",")}`);
  }
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
