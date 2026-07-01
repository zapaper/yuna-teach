import "dotenv/config";
import { prisma } from "../src/lib/db";
(async () => {
  const rows = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        sourceExamId: null, paperType: null, extractionStatus: "ready",
        subject: { contains: "english", mode: "insensitive" },
      },
      syllabusTopic: { in: ["Grammar MCQ", "Grammar Cloze", "Synthesis / Transformation", "Synthesis & Transformation"] },
    },
    select: {
      syllabusTopic: true, subTopic: true, transcribedOptions: true,
      examPaper: { select: { level: true } },
    },
  });
  console.log(`English Grammar/Synthesis master rows: ${rows.length}`);
  const byLevel = new Map<string, number>();
  const byTopic = new Map<string, number>();
  const bySubTopic = new Map<string, number>();
  let withOpts = 0;
  for (const r of rows) {
    byLevel.set(r.examPaper.level ?? "(null)", (byLevel.get(r.examPaper.level ?? "(null)") ?? 0) + 1);
    byTopic.set(r.syllabusTopic ?? "?", (byTopic.get(r.syllabusTopic ?? "?") ?? 0) + 1);
    bySubTopic.set(r.subTopic ?? "(untagged)", (bySubTopic.get(r.subTopic ?? "(untagged)") ?? 0) + 1);
    if (Array.isArray(r.transcribedOptions) && r.transcribedOptions.length > 0) withOpts++;
  }
  console.log(`  by level:`, [...byLevel.entries()]);
  console.log(`  by topic:`, [...byTopic.entries()]);
  console.log(`  by sub-topic:`, [...bySubTopic.entries()].sort((a, b) => b[1] - a[1]));
  console.log(`  with transcribedOptions: ${withOpts}/${rows.length}`);
  await prisma.$disconnect();
})();
