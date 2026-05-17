import { prisma } from "../src/lib/db";
import { fetchMistakeQuestions, fetchPassageCompanions, orderMistakesForRevision } from "../src/lib/revision";

(async () => {
  const studentId = process.argv[2];
  if (!studentId) { console.error("usage: <studentId>"); process.exit(1); }
  const count = parseInt(process.argv[3] ?? "30");

  const mistakes = await fetchMistakeQuestions(studentId, "english", Math.max(count * 3, 60));
  console.log(`fetched ${mistakes.length} mistakes`);
  // Show how many have sourceSectionKey
  const withKey = mistakes.filter(m => m.sourceSectionKey).length;
  console.log(`  with sourceSectionKey: ${withKey}`);
  const withPassage = mistakes.filter(m => m.englishSection?.passage).length;
  console.log(`  with englishSection.passage: ${withPassage}`);

  const chosen = orderMistakesForRevision("english", mistakes).slice(0, count);
  console.log(`\nchose top ${chosen.length} after slice(0, ${count})`);
  console.log(`  with sourceSectionKey: ${chosen.filter(m => m.sourceSectionKey).length}`);
  console.log(`  with englishSection.passage: ${chosen.filter(m => m.englishSection?.passage).length}`);

  // Show grouping by sourceSectionKey
  const bySection = new Map<string, number>();
  for (const m of chosen) {
    const key = m.sourceSectionKey ?? "(no-key)";
    bySection.set(key, (bySection.get(key) ?? 0) + 1);
  }
  console.log("\nChosen mistakes grouped by sourceSectionKey:");
  for (const [k, v] of bySection) console.log(`  ${k}: ${v}`);

  const companions = await fetchPassageCompanions(chosen);
  console.log(`\nfetchPassageCompanions returned ${companions.length} companions`);
  const cBySection = new Map<string, number>();
  for (const m of companions) {
    const key = m.sourceSectionKey ?? "(no-key)";
    cBySection.set(key, (cBySection.get(key) ?? 0) + 1);
  }
  console.log("Companions grouped by sourceSectionKey:");
  for (const [k, v] of cBySection) console.log(`  ${k}: ${v}`);

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
