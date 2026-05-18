import { prisma } from "../src/lib/db";

// Recompute Slide 1 stats with the CORRECTED PSLE filter (includes
// the "P6 Life Science MCQ 2022-2024" compilation that we missed).

const TOPIC = "Interactions within the environment";
const PSLE_RX = /\bPSLE\b|P6 Life Science|PSLE Physical Science|PSLE Physical science/i;

(async () => {
  const all = await prisma.examQuestion.findMany({
    where: {
      transcribedStem: { not: null },
      examPaper: {
        sourceExamId: null,
        paperType: null,
        subject: { contains: "science", mode: "insensitive" },
      },
    },
    select: {
      syllabusTopic: true,
      transcribedOptions: true,
      marksAvailable: true,
      examPaper: { select: { title: true } },
    },
  });

  const pslePapers = all.filter(q => PSLE_RX.test(q.examPaper.title));
  const totalPsleQ = pslePapers.length;
  const totalPsleMarks = pslePapers.reduce((s, q) => s + (q.marksAvailable ?? 0), 0);

  const topicQ = pslePapers.filter(q => q.syllabusTopic === TOPIC);
  const topicMarks = topicQ.reduce((s, q) => s + (q.marksAvailable ?? 0), 0);

  const isMcq = (q: typeof topicQ[number]) =>
    Array.isArray(q.transcribedOptions) && (q.transcribedOptions as unknown[]).length === 4;
  const mcq = topicQ.filter(isMcq);
  const oeq = topicQ.filter(q => !isMcq(q));

  console.log("Corrected PSLE-content stats");
  console.log("=".repeat(60));
  console.log(`Total PSLE Science questions in bank:  ${totalPsleQ}`);
  console.log(`Total PSLE Science marks:              ${totalPsleMarks}`);
  console.log();
  console.log(`Interactions topic questions:          ${topicQ.length}  (${((topicQ.length / totalPsleQ) * 100).toFixed(1)}%)`);
  console.log(`Interactions topic marks:              ${topicMarks}     (${((topicMarks / totalPsleMarks) * 100).toFixed(1)}% of PSLE Sci marks)`);
  console.log();
  console.log(`MCQ in topic:  ${mcq.length}  (${((mcq.length / topicQ.length) * 100).toFixed(0)}%)`);
  console.log(`OEQ in topic:  ${oeq.length}  (${((oeq.length / topicQ.length) * 100).toFixed(0)}%)`);
  console.log();

  // % of PSLE Life-Science only (more relevant for the headline)
  const LIFE_TOPICS = [
    "Diversity of living things and non-living things",
    "Diversity of materials",
    "Cycles in plants and animals (Life cycles)",
    "Cycles in matter and water (Water cycle)",
    "Plant transport system",
    "Human digestive system",
    "Human respiratory and circulatory systems",
    "Reproduction in plants and animals",
    "Photosynthesis",
    "Interactions within the environment",
  ];
  const psleLife = pslePapers.filter(q => q.syllabusTopic && LIFE_TOPICS.includes(q.syllabusTopic));
  const psleLifeMarks = psleLife.reduce((s, q) => s + (q.marksAvailable ?? 0), 0);
  const topicVsLifeQ = ((topicQ.length / psleLife.length) * 100).toFixed(1);
  const topicVsLifeMarks = ((topicMarks / psleLifeMarks) * 100).toFixed(1);
  console.log(`PSLE Life-Science Q's:    ${psleLife.length}`);
  console.log(`PSLE Life-Science marks:  ${psleLifeMarks}`);
  console.log();
  console.log(`Topic as % of Life-Science Q's:    ${topicVsLifeQ}%`);
  console.log(`Topic as % of Life-Science marks:  ${topicVsLifeMarks}%`);

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
