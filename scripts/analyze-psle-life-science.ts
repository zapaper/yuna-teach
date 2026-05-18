import { prisma } from "../src/lib/db";

// PSLE life-science deep dive — pull all P6 / PSLE Science master
// questions tagged with a life-science syllabus topic and group them.
//
// Life-science topics (vs the physical-science ones — Light, Heat,
// Electricity, Forces, Magnets, Energy conversion):

const LIFE_TOPICS = [
  "Diversity of living things and non-living things",
  "Diversity of materials",   // sometimes appears under life-science classification q's
  "Cycles in plants and animals (Life cycles)",
  "Cycles in matter and water (Water cycle)",
  "Cycles in matter and water (matter)",
  "Plant transport system",
  "Human digestive system",
  "Human respiratory and circulatory systems",
  "Reproduction in plants and animals",
  "Photosynthesis",
  "Interactions within the environment",
];

(async () => {
  const questions = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: { in: LIFE_TOPICS, mode: "insensitive" },
      transcribedStem: { not: null },
      examPaper: {
        sourceExamId: null,
        paperType: null,
        subject: { contains: "science", mode: "insensitive" },
        OR: [
          { level: { contains: "Primary 6", mode: "insensitive" } },
          { level: { contains: "P6", mode: "insensitive" } },
          { level: { contains: "PSLE", mode: "insensitive" } },
        ],
      },
    },
    select: {
      id: true,
      questionNum: true,
      transcribedStem: true,
      transcribedOptions: true,
      answer: true,
      marksAvailable: true,
      syllabusTopic: true,
      examPaper: {
        select: { id: true, title: true, level: true, year: true },
      },
    },
  });

  // Group by topic
  const byTopic = new Map<string, typeof questions>();
  for (const q of questions) {
    const t = q.syllabusTopic ?? "unknown";
    if (!byTopic.has(t)) byTopic.set(t, []);
    byTopic.get(t)!.push(q);
  }

  // Sort topics by question count desc
  const sortedTopics = [...byTopic.entries()].sort((a, b) => b[1].length - a[1].length);

  console.log(`PSLE Life-Science master-paper questions: ${questions.length} total`);
  console.log("=".repeat(78));
  console.log();
  for (const [topic, qs] of sortedTopics) {
    const mcq = qs.filter(q => Array.isArray(q.transcribedOptions) && (q.transcribedOptions as unknown[]).length === 4).length;
    const oeq = qs.length - mcq;
    console.log(`${String(qs.length).padStart(3)}  ${topic.padEnd(60)}  (${mcq} MCQ / ${oeq} OEQ)`);
  }

  // Dump first 8 stems per topic for spot-checking patterns
  console.log("\n");
  console.log("=".repeat(78));
  console.log("SAMPLE STEMS PER TOPIC");
  console.log("=".repeat(78));
  for (const [topic, qs] of sortedTopics) {
    console.log(`\n## ${topic}  (${qs.length} questions)\n`);
    const sample = qs.slice(0, 8);
    for (const q of sample) {
      const stem = (q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 280);
      const tag = `[${q.examPaper.year ?? "?"} ${q.examPaper.title.slice(0, 40)} · Q${q.questionNum}${q.marksAvailable ? " " + q.marksAvailable + "m" : ""}]`;
      console.log(`  ${tag}`);
      console.log(`    ${stem}`);
      if (Array.isArray(q.transcribedOptions) && q.transcribedOptions.length === 4) {
        const opts = q.transcribedOptions as string[];
        console.log(`      (1)${opts[0]?.slice(0, 60)} (2)${opts[1]?.slice(0, 60)} (3)${opts[2]?.slice(0, 60)} (4)${opts[3]?.slice(0, 60)}`);
      }
      console.log(`    A: ${(q.answer ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
      console.log();
    }
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
