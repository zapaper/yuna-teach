import { prisma } from "../src/lib/db";

// Per sub-category, split MCQ vs OEQ. Tells us how much of each
// type the current Master Class slides cover.

const TOPIC = "Interactions within the environment";

const BUCKETS = [
  { key: "definition", coveredBy: "Slide 2 (Definitions)", rx: /\b(population|community|habitat|ecosystem)\b/i },
  { key: "food-web", coveredBy: "Slides 3+4 (Causal chain, Food-web reading)", rx: /(food\s*(?:chain|web)|predator|prey|feed\s*on|eats|food\s*source|less\s*food|disease|dying|kill|decrease.*population|population.*decrease)/i },
  { key: "adaptation", coveredBy: "Slide 7 (Adaptation)", rx: /\b(adapt|temperature|water vapour|humidity|amount of water|amount of light|environment.*condition)\b/i },
  { key: "mutualism", coveredBy: "Slide 6 (Mutualism)", rx: /\b(aquarium|aquatic|pond|mutual|both.*benefit|benefit.*from|nectar|provides shelter)\b/i },
  { key: "decomposer", coveredBy: "Slide 5 (Decomposer)", rx: /\bdecomposer|decomposit|bacteria|fungi|mould/i },
  { key: "human-impact", coveredBy: "(NOT covered)", rx: /\b(pollut|deforest|pesticide|pest\s*control|cut\s*down|human\s*activity|substance\s*X)\b/i },
  { key: "energy-producer", coveredBy: "Partly in Slide 4 (food-web)", rx: /\b(producer|energy chain|energy flow|sun|sunlight|directly from)/i },
];

(async () => {
  const qs = await prisma.examQuestion.findMany({
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
    select: {
      id: true,
      transcribedStem: true,
      transcribedOptions: true,
      answer: true,
    },
  });

  const isMcq = (q: typeof qs[number]) =>
    Array.isArray(q.transcribedOptions) && (q.transcribedOptions as unknown[]).length === 4;

  const mcq = qs.filter(isMcq);
  const oeq = qs.filter(q => !isMcq(q));

  console.log(`Total: ${qs.length}  (MCQ: ${mcq.length}  OEQ: ${oeq.length})\n`);

  // Classify each q into ONE bucket (first match wins)
  function classify(q: typeof qs[number]): string {
    const text = `${q.transcribedStem ?? ""} ${q.answer ?? ""}`;
    for (const b of BUCKETS) if (b.rx.test(text)) return b.key;
    return "(unclassified)";
  }

  const mcqByBucket: Record<string, number> = {};
  const oeqByBucket: Record<string, number> = {};
  for (const q of mcq) {
    const k = classify(q);
    mcqByBucket[k] = (mcqByBucket[k] ?? 0) + 1;
  }
  for (const q of oeq) {
    const k = classify(q);
    oeqByBucket[k] = (oeqByBucket[k] ?? 0) + 1;
  }

  console.log("Per sub-category:                                       MCQ          OEQ");
  console.log("─".repeat(80));
  let mcqCovered = 0;
  let oeqCovered = 0;
  for (const b of BUCKETS) {
    const m = mcqByBucket[b.key] ?? 0;
    const o = oeqByBucket[b.key] ?? 0;
    const mPct = mcq.length > 0 ? ((m / mcq.length) * 100).toFixed(0) : "0";
    const oPct = oeq.length > 0 ? ((o / oeq.length) * 100).toFixed(0) : "0";
    console.log(`  ${b.key.padEnd(20)}  ${String(m).padStart(3)} (${mPct.padStart(2)}%)   ${String(o).padStart(3)} (${oPct.padStart(2)}%)   ← ${b.coveredBy}`);
    if (!b.coveredBy.startsWith("(NOT")) {
      mcqCovered += m;
      oeqCovered += o;
    }
  }
  const mU = mcqByBucket["(unclassified)"] ?? 0;
  const oU = oeqByBucket["(unclassified)"] ?? 0;
  const mUPct = ((mU / mcq.length) * 100).toFixed(0);
  const oUPct = ((oU / oeq.length) * 100).toFixed(0);
  console.log(`  ${"(unclassified)".padEnd(20)}  ${String(mU).padStart(3)} (${mUPct.padStart(2)}%)   ${String(oU).padStart(3)} (${oUPct.padStart(2)}%)   ← coverage unknown`);

  console.log();
  console.log(`Classified questions covered by current slides:`);
  console.log(`  MCQ:  ${mcqCovered}/${mcq.length} = ${((mcqCovered / mcq.length) * 100).toFixed(0)}%`);
  console.log(`  OEQ:  ${oeqCovered}/${oeq.length} = ${((oeqCovered / oeq.length) * 100).toFixed(0)}%`);

  // Dump MCQ-only unclassified for spot-check
  if (mU > 0) {
    console.log("\nUnclassified MCQ samples (might indicate a missing slide):");
    for (const q of mcq.filter(q => classify(q) === "(unclassified)").slice(0, 8)) {
      const stem = (q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 200);
      console.log(`  ${stem || "(empty stem — diagram only)"}`);
    }
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
