import { prisma } from "../src/lib/db";

// Compute the precise stats for Slide 1 of the Interactions Master Class:
//   • % of total PSLE Science questions on this topic
//   • % of total PSLE Science marks on this topic
//   • MCQ vs OEQ split within the topic
//   • Within-topic sub-category breakdown (adaptation, population/community,
//     food chain, mutualism, human impact, decomposer)

const TOPIC = "Interactions within the environment";

(async () => {
  // ALL PSLE-actual Science questions in the master bank, any topic.
  const allPSLE = await prisma.examQuestion.findMany({
    where: {
      transcribedStem: { not: null },
      examPaper: {
        sourceExamId: null,
        paperType: null,
        subject: { contains: "science", mode: "insensitive" },
        title: { contains: "PSLE", mode: "insensitive" },
      },
    },
    select: {
      id: true,
      syllabusTopic: true,
      transcribedStem: true,
      transcribedOptions: true,
      answer: true,
      marksAvailable: true,
      examPaper: { select: { title: true, year: true } },
    },
  });

  const totalPSLE = allPSLE.length;
  const totalMarks = allPSLE.reduce((s, q) => s + (q.marksAvailable ?? 0), 0);

  const interactionsQs = allPSLE.filter(q => q.syllabusTopic === TOPIC);
  const interactionsMarks = interactionsQs.reduce((s, q) => s + (q.marksAvailable ?? 0), 0);

  const interMcq = interactionsQs.filter(q =>
    Array.isArray(q.transcribedOptions) && (q.transcribedOptions as unknown[]).length === 4
  );
  const interOeq = interactionsQs.filter(q =>
    !Array.isArray(q.transcribedOptions) || (q.transcribedOptions as unknown[]).length !== 4
  );

  console.log(`PSLE Science master-bank questions: ${totalPSLE}`);
  console.log(`PSLE Science master-bank marks:     ${totalMarks}`);
  console.log();
  console.log(`Interactions topic — questions:    ${interactionsQs.length}  (${((interactionsQs.length / totalPSLE) * 100).toFixed(1)}% of PSLE Science Q's)`);
  console.log(`Interactions topic — marks:        ${interactionsMarks}  (${((interactionsMarks / totalMarks) * 100).toFixed(1)}% of PSLE Science marks)`);
  console.log();
  console.log(`MCQ within topic:  ${interMcq.length}  (${((interMcq.length / interactionsQs.length) * 100).toFixed(0)}%)`);
  console.log(`OEQ within topic:  ${interOeq.length}  (${((interOeq.length / interactionsQs.length) * 100).toFixed(0)}%)`);
  console.log();

  // ── Sub-category breakdown ───────────────────────────────────────────
  // We classify each question into at most ONE bucket by checking stem +
  // answer text against an ordered list of patterns. Order matters —
  // earlier matches win, so put the more specific patterns first.
  type Bucket = { key: string; label: string; rx: RegExp };
  const BUCKETS: Bucket[] = [
    { key: "definition", label: "definition of population/community/habitat/ecosystem", rx: /\b(population|community|habitat|ecosystem)\b/i },
    { key: "adaptation", label: "adaptation to environment (temperature/light/water tolerance)", rx: /\b(adapt|temperature|water vapour|humidity|amount of water|amount of light|environment.*condition)\b/i },
    { key: "food-web", label: "food chain / food web disruption (predator-prey dynamics)", rx: /(food\s*(?:chain|web)|predator|prey|feed\s*on|eats|food\s*source|less\s*food|disease|dying|kill|decrease.*population|population.*decrease)/i },
    { key: "mutualism", label: "mutualism (aquarium / pond / pollinator)", rx: /\b(aquarium|aquatic|pond|mutual|both.*benefit|benefit.*from|nectar|provides shelter)\b/i },
    { key: "human-impact", label: "human impact (pollution / deforestation / pest control)", rx: /\b(pollut|deforest|pesticide|pest\s*control|cut\s*down|human\s*activity|substance\s*X)\b/i },
    { key: "decomposer", label: "decomposers (bacteria / fungi / decomposition)", rx: /\bdecomposer|decomposit|bacteria|fungi|mould/i },
    { key: "producer-energy", label: "producers / energy flow", rx: /\b(producer|energy chain|energy flow|sun|sunlight)\b/i },
  ];

  const counts: Record<string, number> = {};
  const unclassified: typeof interactionsQs = [];

  for (const q of interactionsQs) {
    const text = `${q.transcribedStem ?? ""} ${q.answer ?? ""}`;
    let matched = false;
    for (const b of BUCKETS) {
      if (b.rx.test(text)) {
        counts[b.key] = (counts[b.key] ?? 0) + 1;
        matched = true;
        break;
      }
    }
    if (!matched) unclassified.push(q);
  }

  console.log("Sub-category breakdown of Interactions questions (PSLE only):");
  for (const b of BUCKETS) {
    const n = counts[b.key] ?? 0;
    const pct = ((n / interactionsQs.length) * 100).toFixed(0);
    console.log(`  ${String(n).padStart(2)}/${interactionsQs.length}  ${pct.padStart(3)}%   ${b.label}`);
  }
  console.log(`  ${String(unclassified.length).padStart(2)}/${interactionsQs.length}   --   (unclassified)`);

  if (unclassified.length > 0) {
    console.log("\nUnclassified samples for spot-check:");
    for (const q of unclassified.slice(0, 5)) {
      console.log(`  ${q.examPaper.title} Q${q.id.slice(-6)}: ${(q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }

  // ── Sub-category breakdown on the BROADER pool (PSLE + school P6) ────
  // PSLE-only is N=11 which is too small for stable %. The broader P6/PSLE
  // pool (~77 questions) gives statistically meaningful sub-category %.
  const broaderPool = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: TOPIC,
      transcribedStem: { not: null },
      examPaper: {
        sourceExamId: null,
        paperType: null,
        subject: { contains: "science", mode: "insensitive" },
        OR: [
          { level: { contains: "Primary 6", mode: "insensitive" } },
          { level: { contains: "P6", mode: "insensitive" } },
          { level: { contains: "PSLE", mode: "insensitive" } },
          { level: { contains: "Primary School", mode: "insensitive" } },
        ],
      },
    },
    select: { id: true, transcribedStem: true, answer: true },
  });

  const broadCounts: Record<string, number> = {};
  let broadUnclass = 0;
  for (const q of broaderPool) {
    const text = `${q.transcribedStem ?? ""} ${q.answer ?? ""}`;
    let matched = false;
    for (const b of BUCKETS) {
      if (b.rx.test(text)) {
        broadCounts[b.key] = (broadCounts[b.key] ?? 0) + 1;
        matched = true;
        break;
      }
    }
    if (!matched) broadUnclass++;
  }

  console.log(`\nBroader pool (P6 + PSLE, N=${broaderPool.length}) sub-categories:`);
  for (const b of BUCKETS) {
    const n = broadCounts[b.key] ?? 0;
    const pct = ((n / broaderPool.length) * 100).toFixed(0);
    console.log(`  ${String(n).padStart(2)}/${broaderPool.length}  ${pct.padStart(3)}%   ${b.label}`);
  }
  console.log(`  ${String(broadUnclass).padStart(2)}/${broaderPool.length}   --   (unclassified)`);

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
