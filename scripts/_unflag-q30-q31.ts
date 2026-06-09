// Clear the stale [solve on demand] flags on PSLE Science 2025
// Q30a and Q31 — the answer keys were always fine, the matcher just
// didn't recognise the (a)(i) split-paren encoding for hyphenated
// labels. Fixed in 14ba4507; this script clears the existing
// markingNotes + flagged state so the admin flagged page is clean.

import { prisma } from "../src/lib/db";

(async () => {
  const targets = [
    { id: "cmpn9hsy8001p49oczpoaxcae", q: "30a" },
    { id: "cmpn9hsy9001t49ocy7lfojee", q: "31" },
  ];
  for (const t of targets) {
    const before = await prisma.examQuestion.findUnique({
      where: { id: t.id },
      select: { questionNum: true, flagged: true, markingNotes: true, answer: true },
    });
    console.log(`\n--- Q${t.q} (${t.id}) BEFORE ---`);
    console.log(`  flagged=${before?.flagged}`);
    console.log(`  notes:  ${before?.markingNotes?.slice(0, 200) ?? "(none)"}`);

    // Strip ONLY the [solve on demand] paragraph from markingNotes.
    // If the field also had earlier prefix-stripped notes ("Previous
    // notes:\n..."), recover those.
    const notes = before?.markingNotes ?? "";
    let cleanedNotes: string | null = null;
    const prevIdx = notes.indexOf("Previous notes:\n");
    if (notes.startsWith("[solve on demand]")) {
      if (prevIdx >= 0) {
        cleanedNotes = notes.slice(prevIdx + "Previous notes:\n".length).trim() || null;
      } else {
        cleanedNotes = null;
      }
    } else {
      // No-op safety guard — don't touch notes that aren't ours.
      cleanedNotes = notes;
    }

    await prisma.examQuestion.update({
      where: { id: t.id },
      data: { flagged: false, flaggedAt: null, markingNotes: cleanedNotes },
    });
    const after = await prisma.examQuestion.findUnique({
      where: { id: t.id },
      select: { flagged: true, markingNotes: true },
    });
    console.log(`--- Q${t.q} AFTER ---`);
    console.log(`  flagged=${after?.flagged}`);
    console.log(`  notes:  ${after?.markingNotes?.slice(0, 200) ?? "(none)"}`);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
