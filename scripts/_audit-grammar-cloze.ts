// Sample 30 PSLE Grammar Cloze questions, eyeball what they look
// like, and check whether the 7-bucket Grammar MCQ taxonomy fits.
import { prisma } from "@/lib/db";

async function main() {
  const rows = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: "Grammar Cloze",
      answer: { not: null },
      examPaper: {
        subject: { equals: "English", mode: "insensitive" },
        sourceExamId: null,
        OR: [{ title: { contains: "PSLE", mode: "insensitive" } }, { level: { contains: "6", mode: "insensitive" } }],
      },
    },
    select: { id: true, transcribedStem: true, transcribedOptions: true, answer: true, examPaperId: true },
    take: 30,
  });
  for (const r of rows) {
    const opts = (r.transcribedOptions as string[] | null) ?? [];
    console.log(`\n[${r.id.slice(-6)}]`);
    console.log(`  answer: ${r.answer}`);
    console.log(`  opts:   ${opts.length > 0 ? opts.map(o => `"${o}"`).join(" | ") : "(no options)"}`);
    console.log(`  stem:   ${(r.transcribedStem ?? "").replace(/\s+/g, " ").slice(0, 240)}`);
  }
  console.log(`\nTotal sampled: ${rows.length}`);
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
