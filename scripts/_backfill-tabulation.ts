// Resync marksAwarded from per-part "Awarded N mark(s)" lines in
// markingNotes for the given paper. Idempotent — safe to re-run.
import { prisma } from "../src/lib/db";

const PAPER = process.argv[2] || "cmq34sx5b004qgnicjxy3flh6";

async function main() {
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: PAPER },
    select: { id: true, questionNum: true, marksAvailable: true, marksAwarded: true, markingNotes: true },
  });
  let fixes = 0;
  for (const q of qs) {
    if (!q.markingNotes) continue;
    const marksAvailable = q.marksAvailable ?? 0;
    if (marksAvailable <= 0) continue;
    const sepIdx = q.markingNotes.indexOf(" | ");
    const notesStr = sepIdx >= 0 ? q.markingNotes.slice(sepIdx + 3) : q.markingNotes;
    const partRe = /(?:^|[\n|])\s*(?:Part\s*)?\(([a-z])\)\s*:?\s*([\s\S]*?)(?=(?:^|[\n|])\s*(?:Part\s*)?\([a-z]\)\s*:?|$)/gi;
    const partAwards: { label: string; awarded: number }[] = [];
    for (const m of notesStr.matchAll(partRe)) {
      const chunk = m[2];
      const awardMatch = chunk.match(/awarded\s+(\d+(?:\.\d+)?)\s*mark(?:s|\(s\))?\b/i);
      if (!awardMatch) continue;
      partAwards.push({ label: m[1].toLowerCase(), awarded: parseFloat(awardMatch[1]) });
    }
    if (partAwards.length < 2) continue;
    const proseSum = Math.min(marksAvailable, partAwards.reduce((s, p) => s + Math.max(0, p.awarded), 0));
    const stored = q.marksAwarded ?? 0;
    if (Math.abs(proseSum - stored) < 0.0001) continue;
    console.log(`Q${q.questionNum}: ${stored} → ${proseSum} (parts: ${partAwards.map(p => `${p.label}=${p.awarded}`).join(", ")})`);
    await prisma.examQuestion.update({ where: { id: q.id }, data: { marksAwarded: proseSum } });
    fixes++;
  }
  if (fixes > 0) {
    const all = await prisma.examQuestion.findMany({
      where: { examPaperId: PAPER }, select: { marksAwarded: true },
    });
    const newScore = all.reduce((s, q) => s + (q.marksAwarded ?? 0), 0);
    await prisma.examPaper.update({ where: { id: PAPER }, data: { score: newScore } });
    console.log(`\nFixed ${fixes} questions. New paper score: ${newScore}`);
  } else {
    console.log("No mismatches.");
  }
  process.exit(0);
}
main();
