import { prisma } from "../src/lib/db";

// PSLE Life-Science deep-dive analysis.
//
// Two pools:
//   A. PSLE actual papers — titles containing "PSLE" — used as the
//      authoritative signal for what topics PSLE tests and how often.
//   B. School WA / Prelim papers — supplementary practice pool, drawn
//      on to give students enough volume per topic in the Deep Dive UI.
//
// Output:
//   • Per-topic % of PSLE questions (authoritative weighting)
//   • Per-topic total questions across both pools (practice volume)
//   • Sub-pattern breakdown using keyword scans on the stem

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

(async () => {
  const allQs = await prisma.examQuestion.findMany({
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
          { level: { contains: "Primary School", mode: "insensitive" } },
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

  const isActualPSLE = (title: string) => /\bPSLE\b/i.test(title);
  const psle = allQs.filter(q => isActualPSLE(q.examPaper.title));
  const school = allQs.filter(q => !isActualPSLE(q.examPaper.title));

  console.log(`Total master-paper P6/PSLE life-science questions: ${allQs.length}`);
  console.log(`  • PSLE (actual national exam): ${psle.length}`);
  console.log(`  • School WA / Prelim:          ${school.length}`);
  console.log();
  console.log("=".repeat(78));
  console.log("TOPIC WEIGHTING (PSLE actual papers only — authoritative)");
  console.log("=".repeat(78));

  const psleByTopic = new Map<string, number>();
  for (const q of psle) {
    const t = q.syllabusTopic ?? "unknown";
    psleByTopic.set(t, (psleByTopic.get(t) ?? 0) + 1);
  }
  const psleTotal = psle.length;
  const psleSorted = [...psleByTopic.entries()].sort((a, b) => b[1] - a[1]);
  for (const [topic, n] of psleSorted) {
    const pct = ((n / psleTotal) * 100).toFixed(1);
    console.log(`  ${String(n).padStart(3)}  ${pct.padStart(5)}%   ${topic}`);
  }

  console.log();
  console.log("=".repeat(78));
  console.log("PRACTICE-POOL VOLUME (PSLE + school papers combined)");
  console.log("=".repeat(78));
  const allByTopic = new Map<string, { psle: number; school: number }>();
  for (const q of allQs) {
    const t = q.syllabusTopic ?? "unknown";
    if (!allByTopic.has(t)) allByTopic.set(t, { psle: 0, school: 0 });
    const e = allByTopic.get(t)!;
    if (isActualPSLE(q.examPaper.title)) e.psle++;
    else e.school++;
  }
  const allSorted = [...allByTopic.entries()].sort((a, b) => (b[1].psle + b[1].school) - (a[1].psle + a[1].school));
  for (const [topic, { psle: ps, school: sc }] of allSorted) {
    console.log(`  ${String(ps + sc).padStart(4)} total   (PSLE ${String(ps).padStart(2)}  +  school ${String(sc).padStart(3)})   ${topic}`);
  }

  // ─── sub-pattern keyword scan ────────────────────────────────────────
  console.log();
  console.log("=".repeat(78));
  console.log("SUB-PATTERN KEYWORD SCAN (PSLE actual papers only)");
  console.log("=".repeat(78));

  type Pattern = { key: string; label: string; rx: RegExp };
  const PATTERNS: Record<string, Pattern[]> = {
    "Interactions within the environment": [
      { key: "food-chain", label: "food chain / food web", rx: /\bfood\s*(?:chain|web)\b/i },
      { key: "population", label: "population definition / count", rx: /\bpopulation\b/i },
      { key: "habitat", label: "habitat / community / ecosystem definition", rx: /\b(habitat|community|ecosystem)\b/i },
      { key: "predator-prey", label: "predator/prey dynamics", rx: /\b(predator|prey|feeds on|eats)\b/i },
      { key: "decomposer", label: "decomposer / decomposition", rx: /\bdecomposer|decomposit/i },
      { key: "pollution", label: "pollution / human impact / deforestation", rx: /\b(pollut|deforestat|pest\s*control|human\s*activit|cut\s*down)/i },
      { key: "aquarium", label: "aquarium / pond mutualism", rx: /\b(aquarium|aquatic|pond)\b/i },
      { key: "adaptation", label: "adaptation to environment", rx: /\b(adapt|adaptation|adapted)\b/i },
    ],
    "Photosynthesis": [
      { key: "requirements", label: "requirements (CO2 / water / light / chlorophyll)", rx: /\b(carbon\s*dioxide|sunlight|chlorophyll|stomata|leaves)\b/i },
      { key: "rate", label: "rate of photosynthesis (light / dark / variable)", rx: /\b(rate|under the sun|in the dark|amount of light)\b/i },
      { key: "products", label: "products (oxygen / food / glucose)", rx: /\b(oxygen|glucose|food)\b/i },
      { key: "exchange", label: "gas exchange day/night", rx: /\b(day|night|morning|evening|gas)\b/i },
      { key: "experiment", label: "experiment set-up / variables", rx: /\b(set[\s-]?up|experiment|investigate|variable|fair test)\b/i },
    ],
    "Reproduction in plants and animals": [
      { key: "pollination", label: "pollination / pollinators", rx: /\bpollinat/i },
      { key: "fertilisation", label: "fertilisation / ovary / ovule", rx: /\b(fertilis|ovary|ovule|ovaries)\b/i },
      { key: "seed-dispersal", label: "seed / fruit dispersal", rx: /\b(dispers|fruit|seed)\b/i },
      { key: "animal-repro", label: "animal reproduction / life stages", rx: /\b(egg|sperm|young|larva|nymph|tadpole|caterpillar)\b/i },
      { key: "parts", label: "reproductive parts (stamen / pistil / etc.)", rx: /\b(stamen|pistil|stigma|anther|petal|sepal)\b/i },
    ],
    "Human respiratory and circulatory systems": [
      { key: "exercise", label: "exercise / heart rate / breathing rate response", rx: /\b(exercise|running|jog|breathing rate|heart rate)\b/i },
      { key: "gas-exchange", label: "gases in/out (O2 / CO2)", rx: /\b(oxygen|carbon\s*dioxide|inhal|exhal|breathe)\b/i },
      { key: "blood-flow", label: "blood flow / pumping / heart parts", rx: /\b(blood|pump|heart|artery|vein|valve)\b/i },
      { key: "diagram", label: "diagram-labelled organ identification", rx: /\b(diagram|part|labelled|label)\b/i },
      { key: "transport", label: "circulatory transport (digested food / oxygen)", rx: /\b(transport|carries|deliver)\b/i },
    ],
    "Human digestive system": [
      { key: "order", label: "ordering parts of the digestive tract", rx: /\b(order|sequence|direction|first|then)\b/i },
      { key: "absorption", label: "absorption (small intestine)", rx: /\b(absorb|small intestine|villi)\b/i },
      { key: "digestion-meaning", label: "definition of digestion", rx: /\b(digestion is|breaking down|simpler substances)\b/i },
      { key: "saliva-stomach", label: "saliva / stomach / enzymes", rx: /\b(saliva|stomach|enzyme|juice)\b/i },
      { key: "blood-link", label: "link to circulatory system (digested food → blood)", rx: /\b(blood|bloodstream|circulator)\b/i },
    ],
    "Diversity of materials": [
      { key: "properties", label: "property identification (strength / flexibility / waterproof / transparent / float)", rx: /\b(strength|strong|flexib|waterproof|transparent|float|absorb|magnetic)\b/i },
      { key: "states", label: "solid / liquid / gas (state properties)", rx: /\b(solid|liquid|gas|definite shape|definite volume|compress)\b/i },
      { key: "classification", label: "classification flowchart", rx: /\b(flowchart|classif)\b/i },
      { key: "use-case", label: "real-world product application", rx: /\b(used to make|use of|material for)\b/i },
    ],
  };

  for (const [topic, qs] of psleByTopic) {
    const pats = PATTERNS[topic];
    if (!pats) continue;
    const topicQs = psle.filter(q => q.syllabusTopic === topic);
    console.log(`\n${topic} (${qs} PSLE questions):`);
    for (const p of pats) {
      const hits = topicQs.filter(q => p.rx.test(q.transcribedStem ?? "")).length;
      const pct = ((hits / qs) * 100).toFixed(0);
      console.log(`  ${String(hits).padStart(2)}/${qs}  ${pct.padStart(3)}%   ${p.label}`);
    }
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
