import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const PAPER_ID = process.argv[2] ?? "cmp87u5hq0001vlyjgj72eb6d";
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER_ID, syllabusTopic: { contains: "语文应用" } },
    orderBy: { orderIndex: "asc" },
    select: { questionNum: true, transcribedStem: true, transcribedOptions: true },
  });
  for (const q of qs) {
    const stem = q.transcribedStem ?? "";
    // Multi-blank questions usually have 2+ bold groups OR a stem
    // pattern containing "____ ... ____" between two phrases.
    const boldGroups = (stem.match(/\*\*[^*]+\*\*/g) ?? []).length;
    if (boldGroups >= 2) {
      console.log(`Q${q.questionNum}  (${boldGroups} bold groups):`);
      console.log(`  stem: ${stem}`);
      console.log(`  options: ${JSON.stringify(q.transcribedOptions)}`);
      console.log();
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
