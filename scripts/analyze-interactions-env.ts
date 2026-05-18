import { prisma } from "../src/lib/db";

// Pull every master-paper Science question tagged with the
// "Interactions within the environment" topic and dump
// stem + answer + options so we can read patterns.

(async () => {
  const topics = [
    "Interactions within the environment",
    "Interactions within Environment",
    "interactions within the environment",
    "Interaction with Environment",
  ];

  const questions = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: { in: topics, mode: "insensitive" },
      transcribedStem: { not: null },
      examPaper: {
        sourceExamId: null,
        paperType: null,
        subject: { contains: "science", mode: "insensitive" },
      },
    },
    select: {
      id: true,
      questionNum: true,
      transcribedStem: true,
      transcribedOptions: true,
      answer: true,
      marksAvailable: true,
      examPaper: {
        select: { id: true, title: true, level: true, year: true },
      },
    },
  });

  console.log(`Found ${questions.length} master-paper Science questions on "Interactions within the environment"\n`);

  const mcq = questions.filter(q => Array.isArray(q.transcribedOptions) && (q.transcribedOptions as unknown[]).length === 4);
  const oeq = questions.filter(q => !Array.isArray(q.transcribedOptions) || (q.transcribedOptions as unknown[]).length !== 4);
  console.log(`  ${mcq.length} MCQ · ${oeq.length} OEQ\n`);
  console.log("=".repeat(78));

  for (const [idx, q] of questions.entries()) {
    console.log(`\n--- ${idx + 1}. Q${q.questionNum} · ${q.examPaper.title} (${q.examPaper.level ?? "?"} ${q.examPaper.year ?? ""}) · ${q.marksAvailable ?? "?"}m ---`);
    console.log(`Stem: ${(q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 400)}`);
    if (Array.isArray(q.transcribedOptions) && q.transcribedOptions.length === 4) {
      const opts = q.transcribedOptions as string[];
      console.log(`  (1) ${opts[0]?.slice(0, 80)}`);
      console.log(`  (2) ${opts[1]?.slice(0, 80)}`);
      console.log(`  (3) ${opts[2]?.slice(0, 80)}`);
      console.log(`  (4) ${opts[3]?.slice(0, 80)}`);
    }
    console.log(`Answer: ${(q.answer ?? "").slice(0, 300)}`);
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
