import { prisma } from "../src/lib/db";

const ENGLISH_SYN = ["Synthesis / Transformation", "Synthesis & Transformation"];

async function main() {
  const masterRows = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: { in: ENGLISH_SYN },
      examPaper: {
        sourceExamId: null, paperType: null,
        NOT: [{ examType: "Synthetic" }, { title: { startsWith: "[Synthetic Bank]" } }],
      },
    },
    select: {
      id: true, subTopic: true, syntheticGenerated: true,
      examPaper: { select: { title: true, level: true, year: true } },
    },
  });

  type B = { psle: number; school: number; pending: number; generated: number; psleYears: Set<string> };
  const buckets: Record<string, B> = {};
  for (const r of masterRows) {
    const k = r.subTopic ?? "(untagged — misc)";
    const b = buckets[k] ?? { psle: 0, school: 0, pending: 0, generated: 0, psleYears: new Set() };
    const isPsle = /PSLE/i.test(r.examPaper.title) || /^psle$/i.test(r.examPaper.level ?? "");
    if (isPsle) { b.psle++; b.psleYears.add(r.examPaper.year ?? "?"); }
    else b.school++;
    if (r.syntheticGenerated) b.generated++; else b.pending++;
    buckets[k] = b;
  }
  console.log("=== Master English synthesis source pool — post 6-umbrella classification ===\n");
  console.log("Sub-topic".padEnd(28), "PSLE  School  Total  Pending  PSLE years");
  console.log("-".repeat(95));
  const order = [
    "reported-speech",
    "subordinator",
    "correlative-preference",
    "participle-clauses",
    "substitution-inversion",
    "noun-phrase",
    "(untagged — misc)",
  ];
  for (const k of order) {
    const b = buckets[k]; if (!b) continue;
    const years = [...b.psleYears].sort().join(",");
    console.log(
      k.padEnd(28),
      String(b.psle).padStart(4),
      String(b.school).padStart(6),
      String(b.psle + b.school).padStart(6),
      String(b.pending).padStart(8),
      `  ${years}`,
    );
  }
  // Any IDs I forgot
  for (const [k, b] of Object.entries(buckets)) {
    if (order.includes(k)) continue;
    const years = [...b.psleYears].sort().join(",");
    console.log(
      k.padEnd(28),
      String(b.psle).padStart(4),
      String(b.school).padStart(6),
      String(b.psle + b.school).padStart(6),
      String(b.pending).padStart(8),
      `  ${years}`,
    );
  }
  console.log();

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
