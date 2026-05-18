import { prisma } from "../src/lib/db";

// What's the most-tested Physical-Science topic on PSLE?

const PHYSICAL_TOPICS = [
  "Light energy and uses",
  "Heat energy and uses",
  "Electrical system and circuits",
  "Energy conversion",
  "Interaction of forces (Magnets)",
  "Interaction of forces (Frictional force, gravitational force, elastic spring force)",
  "Diversity of materials",
  "Cycles in matter and water (Water cycle)",
  "Cycles in matter and water (matter)",
  "Plant transport system",
];

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

  const psle = all.filter(q => PSLE_RX.test(q.examPaper.title));
  const phys = psle.filter(q => q.syllabusTopic && PHYSICAL_TOPICS.includes(q.syllabusTopic));
  const totalPsleMarks = psle.reduce((s, q) => s + (q.marksAvailable ?? 0), 0);
  const physMarks = phys.reduce((s, q) => s + (q.marksAvailable ?? 0), 0);

  console.log(`PSLE Science total: ${psle.length} Q · ${totalPsleMarks} marks`);
  console.log(`Physical-science Q's: ${phys.length} · ${physMarks} marks (${((physMarks / totalPsleMarks) * 100).toFixed(1)}% of PSLE Sci marks)\n`);

  const byTopic = new Map<string, { q: number; marks: number }>();
  for (const q of phys) {
    const t = q.syllabusTopic ?? "unknown";
    if (!byTopic.has(t)) byTopic.set(t, { q: 0, marks: 0 });
    const e = byTopic.get(t)!;
    e.q++;
    e.marks += q.marksAvailable ?? 0;
  }

  const sorted = [...byTopic.entries()].sort((a, b) => b[1].marks - a[1].marks);
  console.log("Physical-science topic breakdown (PSLE only):");
  console.log("  Q   Marks   %Phys-Sci   %PSLE-Sci   Topic");
  for (const [topic, e] of sorted) {
    const pPhys = ((e.marks / physMarks) * 100).toFixed(1);
    const pPSLE = ((e.marks / totalPsleMarks) * 100).toFixed(1);
    console.log(`  ${String(e.q).padStart(2)}  ${String(e.marks).padStart(3)}    ${pPhys.padStart(5)}%      ${pPSLE.padStart(5)}%      ${topic}`);
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
