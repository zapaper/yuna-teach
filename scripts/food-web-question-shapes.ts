import { prisma } from "../src/lib/db";

// Pull food-web / food-chain questions in the Interactions topic and
// classify them by SHAPE (not by content). Goal: surface the
// non-causal-reasoning question types so we can add a slide on them.

const TOPIC = "Interactions within the environment";

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
      examPaper: { select: { title: true } },
    },
  });

  // Keep only food-chain/web/predator-prey questions
  const foodweb = qs.filter(q => {
    const t = `${q.transcribedStem ?? ""} ${q.answer ?? ""}`;
    return /food\s*(chain|web)|predator|prey|feeds on|food\s*source/i.test(t);
  });

  console.log(`Total food-chain/food-web questions in topic: ${foodweb.length}`);
  console.log();

  // ── Shape classifiers (each q can hit multiple) ──
  type Shape = { key: string; label: string; rx: RegExp; description: string };
  const SHAPES: Shape[] = [
    { key: "causal-decrease", label: "Causal: population X decreases", rx: /\b(decrease|decreases|decreasing|dying|killed|disease|removed|drastic)\b/i, description: "Predict effect when one species drops" },
    { key: "causal-increase", label: "Causal: population X increases", rx: /\b(increase|increases|increasing|drastic.*increase|more.*food)\b/i, description: "Predict effect when one species grows" },
    { key: "graph-match", label: "Match graph to scenario", rx: /\b(graph|chart).*(correctly|shows|how|population)/i, description: "Pick the graph that matches predicted change" },
    { key: "role-id", label: "Identify role (producer/consumer/decomposer)", rx: /\b(producer|consumer|decomposer).*(which|identify|are|is)/i, description: "Tag organisms by role" },
    { key: "arrow-read", label: "Arrow reading / count predators", rx: /\b(arrow|directly|eats|feeds on|prey of|eaten by|food source for)/i, description: "Trace who eats whom" },
    { key: "energy-source", label: "Source of energy / Sun", rx: /\b(sun|sunlight|energy.*from|energy chain|directly from the sun)/i, description: "Trace energy back to the Sun" },
    { key: "count", label: "Count chains / organisms / arrows", rx: /\b(how many|number of|count).*\b(chain|food|arrow|organism)/i, description: "Counting questions" },
    { key: "competition", label: "Competition / shared food source", rx: /\b(compet|share.*food|same.*food|both eat)/i, description: "Two species competing" },
    { key: "true-statement", label: "Which statement is true / correct", rx: /\bwhich.*(statement|of the following).*(true|correct)/i, description: "MCQ true-false among 4" },
    { key: "comparison", label: "Compare habitats / communities", rx: /\b(habitat.*A.*B|compare|differ|both habitats)/i, description: "Compare two habitats / communities" },
    { key: "name-define", label: "Definition of population/community/habitat", rx: /\bwhat\s*is\s*(a\s*)?(population|community|habitat|ecosystem)/i, description: "Definition recall" },
  ];

  const hits: Record<string, number> = {};
  type Sample = { id: string; stem: string; ans: string; src: string };
  const samples: Record<string, Sample[]> = {};
  for (const q of foodweb) {
    const text = `${q.transcribedStem ?? ""} ${q.answer ?? ""}`;
    for (const s of SHAPES) {
      if (s.rx.test(text)) {
        hits[s.key] = (hits[s.key] ?? 0) + 1;
        if (!samples[s.key]) samples[s.key] = [];
        if (samples[s.key].length < 2) {
          samples[s.key].push({
            id: q.id.slice(-6),
            stem: (q.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 220),
            ans: (q.answer ?? "").replace(/\s+/g, " ").slice(0, 120),
            src: q.examPaper.title.slice(0, 38),
          });
        }
      }
    }
  }

  const sorted = SHAPES.slice().sort((a, b) => (hits[b.key] ?? 0) - (hits[a.key] ?? 0));
  console.log(`SHAPE                                              hits  %        description`);
  console.log("─".repeat(120));
  for (const s of sorted) {
    const n = hits[s.key] ?? 0;
    const pct = ((n / foodweb.length) * 100).toFixed(0);
    console.log(`${s.label.padEnd(52)}  ${String(n).padStart(3)}  ${pct.padStart(3)}%   ${s.description}`);
  }

  console.log("\n\nSAMPLES per shape:");
  for (const s of sorted) {
    if (!samples[s.key]?.length) continue;
    console.log(`\n## ${s.label}`);
    for (const x of samples[s.key]) {
      console.log(`  [${x.src} · ${x.id}] ${x.stem}`);
      if (x.ans) console.log(`  A: ${x.ans}`);
    }
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
