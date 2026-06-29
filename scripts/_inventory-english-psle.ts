// Inventory English questions on PSLE-source master papers, grouped
// by syllabusTopic (section). Goal: pick the highest-volume section
// without an existing sub-topic classifier as the next build target.
import { prisma } from "@/lib/db";

async function main() {
  // Master papers only (sourceExamId null). PSLE = title or
  // examType containing "PSLE", level 6.
  const rows = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        subject: { equals: "English", mode: "insensitive" },
        sourceExamId: null,
        OR: [
          { title: { contains: "PSLE", mode: "insensitive" } },
          { examType: { contains: "PSLE", mode: "insensitive" } },
          { level: { contains: "6", mode: "insensitive" } },
        ],
      },
      syllabusTopic: { not: null },
    },
    select: {
      syllabusTopic: true,
      subTopic: true,
    },
  });
  const bySection = new Map<string, { total: number; tagged: number }>();
  for (const r of rows) {
    const k = r.syllabusTopic ?? "(null)";
    const cur = bySection.get(k) ?? { total: 0, tagged: 0 };
    cur.total++;
    if (r.subTopic) cur.tagged++;
    bySection.set(k, cur);
  }
  const sorted = [...bySection.entries()].sort((a, b) => b[1].total - a[1].total);
  console.log("PSLE English questions per section (master papers):");
  console.log("  count    subTopic-tagged    section");
  for (const [section, s] of sorted) {
    console.log(`  ${(s.total + "").padStart(5)}    ${(s.tagged + "").padStart(15)}    ${section}`);
  }
  console.log(`\nTotal: ${rows.length} PSLE English questions, ${sorted.length} sections.`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
