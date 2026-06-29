// Sub-topic histogram for Grammar MCQ + Grammar Cloze on PSLE master
// papers. Tells us what's already classified and what isn't.
import { prisma } from "@/lib/db";

async function main() {
  for (const section of ["Grammar MCQ", "Grammar Cloze"] as const) {
    console.log(`\n── ${section} ──`);
    const rows = await prisma.examQuestion.findMany({
      where: {
        syllabusTopic: section,
        examPaper: {
          subject: { equals: "English", mode: "insensitive" },
          sourceExamId: null,
          OR: [{ title: { contains: "PSLE", mode: "insensitive" } }, { level: { contains: "6", mode: "insensitive" } }],
        },
      },
      select: { subTopic: true },
    });
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.subTopic ?? "(null)", (counts.get(r.subTopic ?? "(null)") ?? 0) + 1);
    for (const [k, c] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${(c + "").padStart(5)}  ${k}`);
    }
    console.log(`  total: ${rows.length}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
