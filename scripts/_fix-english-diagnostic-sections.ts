import "dotenv/config";
import { prisma } from "../src/lib/db";
(async () => {
  // Fix the englishSections metadata on student666's and student67's
  // English diagnostic quizzes. The quiz page expects an array of
  // objects with { label, startIndex, endIndex }, not strings.
  const targets = ["cmr1oddrl00012zfh7hzacdi5", "cmr1nfba300017ut6rjl0h5o8"];
  for (const paperId of targets) {
    const p = await prisma.examPaper.findUnique({ where: { id: paperId }, select: { metadata: true, _count: { select: { questions: true } } } });
    if (!p) continue;
    const meta = (p.metadata ?? {}) as Record<string, unknown>;
    const qs = await prisma.examQuestion.findMany({ where: { examPaperId: paperId }, orderBy: { orderIndex: "asc" }, select: { id: true, syllabusTopic: true, transcribedOptions: true } });
    let grammarStart = -1, grammarEnd = -1, synthStart = -1, synthEnd = -1;
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i];
      const isMcq = Array.isArray(q.transcribedOptions) && (q.transcribedOptions as unknown[]).length >= 2;
      if (q.syllabusTopic === "Grammar MCQ" || isMcq) {
        if (grammarStart < 0) grammarStart = i;
        grammarEnd = i;
      } else {
        if (synthStart < 0) synthStart = i;
        synthEnd = i;
      }
    }
    const englishSections: Array<{ label: string; startIndex: number; endIndex: number }> = [];
    if (grammarStart >= 0) englishSections.push({ label: "Grammar MCQ", startIndex: grammarStart, endIndex: grammarEnd });
    if (synthStart >= 0) englishSections.push({ label: "Synthesis & Transformation", startIndex: synthStart, endIndex: synthEnd });
    await prisma.examPaper.update({ where: { id: paperId }, data: { metadata: { ...meta, englishSections } } });
    console.log(`  ${paperId}: sections = ${JSON.stringify(englishSections)}`);
  }
  await prisma.$disconnect();
})();
