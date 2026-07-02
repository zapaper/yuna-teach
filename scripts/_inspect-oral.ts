import { prisma } from "../src/lib/db";
(async () => {
  const rows = await prisma.englishSupplementaryPaper.findMany({
    where: { pdfPath: { not: null } },
    orderBy: { year: "desc" },
    select: { year: true, oralDays: true },
  });
  for (const r of rows) {
    console.log("=== YEAR", r.year, "===");
    const days = r.oralDays as Array<{ day: number; stimulusDescription?: string; conversationPrompts?: unknown }> | null;
    if (!days) { console.log("  NO oralDays"); continue; }
    for (const d of days) {
      console.log(` Day ${d.day}:`);
      console.log(`  stimulus: ${(d.stimulusDescription ?? "").slice(0, 160)}`);
      const cp = d.conversationPrompts as Array<unknown> | undefined;
      if (Array.isArray(cp)) {
        cp.forEach((p, i) => {
          const text = typeof p === "string" ? p : JSON.stringify(p);
          console.log(`  Q${i + 1}: ${text.slice(0, 240)}`);
        });
      }
    }
  }
  await prisma.$disconnect();
})();
