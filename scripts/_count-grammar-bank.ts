import { prisma } from "../src/lib/db";

async function main() {
  const masterGrammar = await prisma.examQuestion.count({
    where: {
      syllabusTopic: "Grammar MCQ",
      examPaper: { sourceExamId: null, paperType: null },
    },
  });
  console.log(`Total Grammar MCQ master rows: ${masterGrammar}`);

  const byLevel = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: "Grammar MCQ",
      examPaper: { sourceExamId: null, paperType: null },
    },
    select: { examPaper: { select: { level: true, title: true } } },
  });
  const levelCounts = new Map<string, number>();
  for (const q of byLevel) {
    const k = q.examPaper.level ?? "unknown";
    levelCounts.set(k, (levelCounts.get(k) ?? 0) + 1);
  }
  console.log("\nBy level:");
  for (const [lv, n] of [...levelCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log("  " + String(n).padStart(4), lv);
  }

  const p5p6 = await prisma.examQuestion.count({
    where: {
      syllabusTopic: "Grammar MCQ",
      examPaper: {
        sourceExamId: null, paperType: null,
        OR: [
          { level: { in: ["P5", "Primary 5", "P6", "Primary 6", "PSLE", "5", "6"] } },
          { title: { contains: "PSLE", mode: "insensitive" } },
        ],
      },
    },
  });
  console.log(`\nP5/P6/PSLE only: ${p5p6}`);

  // How many of those P5-P6 are in [Synthetic Bank] (synthetic variants)?
  const bank = await prisma.examQuestion.count({
    where: {
      syllabusTopic: "Grammar MCQ",
      examPaper: {
        OR: [{ examType: "Synthetic" }, { title: { startsWith: "[Synthetic Bank]" } }],
      },
    },
  });
  console.log(`\n[Synthetic Bank] Grammar MCQ (accepted variants): ${bank}`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
