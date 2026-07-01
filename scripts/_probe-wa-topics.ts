// What does the WA1/WA2/WA3/EOY topic spread look like in the P4/P5
// bank? We derive it from paper.title which typically has the WA
// label baked in.
import "dotenv/config";
import { prisma } from "../src/lib/db";
(async () => {
  const rows = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        sourceExamId: null, paperType: null, extractionStatus: "ready",
        level: { in: ["Primary 4", "Primary 5"] },
      },
      syllabusTopic: { not: null },
    },
    select: {
      syllabusTopic: true, transcribedOptions: true,
      examPaper: { select: { level: true, subject: true, title: true } },
    },
  });
  console.log(`P4+P5 master rows (topic-tagged): ${rows.length}`);
  function labelOf(title: string): string {
    const t = title.toUpperCase();
    if (t.includes("WA1") || t.includes("MYE1")) return "WA1";
    if (t.includes("WA2") || t.includes("MYE2") || t.includes("SA1") || t.includes("MID YEAR")) return "WA2";
    if (t.includes("WA3")) return "WA3";
    if (t.includes("EOY") || t.includes("SA2") || t.includes("END OF YEAR") || t.includes("YEAR END")) return "EOY";
    if (t.includes("CA1") || t.includes("PRELIMINARY")) return "PRELIM";
    return "(unlabelled)";
  }
  const bucket = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!Array.isArray(r.transcribedOptions) || r.transcribedOptions.length === 0) continue;
    const level = r.examPaper.level ?? "?";
    const subj = (r.examPaper.subject ?? "").toLowerCase().includes("math") ? "Math"
      : (r.examPaper.subject ?? "").toLowerCase().includes("science") ? "Science"
      : (r.examPaper.subject ?? "").toLowerCase().includes("english") ? "English" : "?";
    const wa = labelOf(r.examPaper.title ?? "");
    const key = `${level} ${subj} ${wa}`;
    const sub = bucket.get(key) ?? new Map<string, number>();
    sub.set(r.syllabusTopic ?? "?", (sub.get(r.syllabusTopic ?? "?") ?? 0) + 1);
    bucket.set(key, sub);
  }
  const keys = [...bucket.keys()].sort();
  for (const k of keys) {
    console.log(`\n── ${k} ──`);
    const sub = bucket.get(k)!;
    const sorted = [...sub.entries()].sort((a, b) => b[1] - a[1]);
    for (const [t, n] of sorted) console.log(`    ${t.padEnd(56)}  ${n.toString().padStart(3)}`);
  }
  await prisma.$disconnect();
})();
