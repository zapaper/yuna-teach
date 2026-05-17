import { prisma } from "../src/lib/db";

(async () => {
  // Look at recent OEQ paper questions where marksAwarded > 0 but
  // < marksAvailable — the "partial" case the user is seeing.
  const qs = await prisma.examQuestion.findMany({
    where: {
      examPaper: { paperType: { in: ["quiz", "focused"] } },
      transcribedSubparts: { not: undefined },
      marksAwarded: { gt: 0 },
      markingNotes: { not: null },
    },
    orderBy: { id: "desc" },
    take: 8,
    select: { id: true, questionNum: true, marksAwarded: true, marksAvailable: true,
      transcribedSubparts: true, markingNotes: true, examPaper: { select: { title: true } } },
  });
  for (const q of qs) {
    if (q.marksAwarded === q.marksAvailable) continue; // skip full-mark
    const subs = q.transcribedSubparts as Array<{ label: string; text: string }> | null;
    if (!subs || subs.length === 0) continue;
    console.log(`\n=== Q${q.questionNum} ${q.marksAwarded}/${q.marksAvailable} | "${q.examPaper.title}"`);
    console.log("subparts:");
    for (const sp of subs) {
      if (sp.label.startsWith("_")) continue;
      const m = String(sp.text ?? "").match(/\[\s*(\d+)\s*(?:m(?:ark)?s?)?\s*\]/i);
      console.log(`  (${sp.label}) avail=${m ? m[1] : "?"} text="${(sp.text ?? "").slice(0, 80)}"`);
    }
    console.log("markingNotes:");
    console.log("  " + (q.markingNotes ?? "").replace(/\n/g, "\n  "));
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
