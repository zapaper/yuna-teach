// Sample 30 questions tagged "noun-number-rules" and inspect whether
// they're predominantly SVA (subject-verb-agreement on a singular vs
// plural verb) or genuinely cover the wider quantifier/mass-noun
// territory the existing description claims.
import { prisma } from "@/lib/db";

async function main() {
  const rows = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: "Grammar MCQ",
      subTopic: "noun-number-rules",
      examPaper: {
        subject: { equals: "English", mode: "insensitive" },
        sourceExamId: null,
        OR: [{ title: { contains: "PSLE", mode: "insensitive" } }, { level: { contains: "6", mode: "insensitive" } }],
      },
    },
    select: { id: true, transcribedStem: true, transcribedOptions: true, answer: true },
    take: 30,
  });
  for (const r of rows) {
    const opts = (r.transcribedOptions as string[] | null) ?? [];
    console.log(`\n[${r.id.slice(-6)}] answer=${r.answer}`);
    console.log(`  stem: ${(r.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 180)}`);
    console.log(`  opts: ${opts.map(o => `"${o}"`).join(" | ")}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
