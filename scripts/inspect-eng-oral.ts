import { prisma } from "../src/lib/db";
async function main() {
  const rows = await prisma.englishSupplementaryPaper.findMany({
    orderBy: { year: "asc" },
    select: { year: true, oralDays: true, oralModelAnswers: true, oralReadingPassage: true, oralStimulusPicture: true },
  });
  for (const r of rows) {
    console.log(`\n=== ${r.year} ===`);
    console.log("oralDays:", JSON.stringify(r.oralDays, null, 2)?.slice(0, 800));
    if (r.oralReadingPassage) console.log("oralReadingPassage:", String(r.oralReadingPassage).slice(0, 200));
    if (r.oralStimulusPicture) console.log("oralStimulusPicture:", JSON.stringify(r.oralStimulusPicture).slice(0, 300));
    console.log("oralModelAnswers count:", (r.oralModelAnswers as unknown[])?.length ?? 0);
    if (r.oralModelAnswers && Array.isArray(r.oralModelAnswers) && r.oralModelAnswers.length > 0) {
      console.log("first model answer:", JSON.stringify(r.oralModelAnswers[0], null, 2).slice(0, 500));
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
