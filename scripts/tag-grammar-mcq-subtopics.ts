// One-off: classify every Grammar MCQ question in P6/PSLE English
// papers and write the result to ExamQuestion.subTopic. Re-runnable.
import { prisma } from "../src/lib/db";
import { classifyGrammarMcq, type GrammarSubTopic } from "../src/lib/master-class/classify-grammar";

(async () => {
  const papers = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null,
      subject: { contains: "english", mode: "insensitive" },
      OR: [{ level: "Primary 6" }, { level: "PSLE" }],
      NOT: { title: { startsWith: "Test Quiz" } },
    },
    select: { id: true, title: true },
  });
  const counts: Record<GrammarSubTopic | "null", number> = {
    "tag-questions": 0, "noun-number-rules": 0, "pronouns": 0,
    "verb-forms": 0, "connectors-tenses": 0, "idiomatic-prepositions": 0,
    "null": 0,
  };
  let updated = 0;
  let scanned = 0;
  for (const p of papers) {
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: p.id, syllabusTopic: "Grammar MCQ" },
      select: { id: true, transcribedStem: true, transcribedOptions: true, subTopic: true },
    });
    for (const q of qs) {
      scanned++;
      const opts = (q.transcribedOptions as string[] | null) ?? null;
      const sub = classifyGrammarMcq(q.transcribedStem, opts);
      if (sub) counts[sub]++; else counts.null++;
      if (sub && q.subTopic !== sub) {
        await prisma.examQuestion.update({ where: { id: q.id }, data: { subTopic: sub } });
        updated++;
      }
    }
  }
  console.log(`Scanned ${scanned} Grammar MCQs across ${papers.length} papers.`);
  console.log(`Updated subTopic on ${updated} questions.\n`);
  console.log(`Per-bucket counts:`);
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(28)}  ${v}`);
  }
  await prisma.$disconnect();
})();
