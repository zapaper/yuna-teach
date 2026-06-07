// Sweep ALL recently-marked papers for prose-sum vs marksAwarded
// mismatches. Don't write — just report.
import { prisma } from "../src/lib/db";

async function main() {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const papers = await prisma.examPaper.findMany({
    where: { markingStatus: { in: ["complete", "released"] }, completedAt: { gte: since } },
    select: { id: true, title: true, subject: true, completedAt: true, score: true, totalMarks: true, assignedToId: true },
    orderBy: { completedAt: "desc" },
    take: 200,
  });
  console.log(`Scanning ${papers.length} papers marked in the last 14 days…\n`);

  const mismatches: Array<{ paperId: string; title: string; questionNum: string; stored: number; prose: number; subject: string }> = [];

  for (const p of papers) {
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: p.id },
      select: { questionNum: true, marksAvailable: true, marksAwarded: true, markingNotes: true },
    });
    for (const q of qs) {
      if (!q.markingNotes) continue;
      const marksAvailable = q.marksAvailable ?? 0;
      if (marksAvailable <= 0) continue;
      const sepIdx = q.markingNotes.indexOf(" | ");
      const notesStr = sepIdx >= 0 ? q.markingNotes.slice(sepIdx + 3) : q.markingNotes;
      const partRe = /(?:^|[\n|])\s*(?:Part\s*)?\(([a-z])\)\s*:?\s*([\s\S]*?)(?=(?:^|[\n|])\s*(?:Part\s*)?\([a-z]\)\s*:?|$)/gi;
      const partAwards: number[] = [];
      for (const m of notesStr.matchAll(partRe)) {
        const chunk = m[2];
        const aw = chunk.match(/awarded\s+(\d+(?:\.\d+)?)\s*mark(?:s|\(s\))?\b/i);
        if (aw) partAwards.push(parseFloat(aw[1]));
      }
      if (partAwards.length < 2) continue;
      const proseSum = Math.min(marksAvailable, partAwards.reduce((s, v) => s + v, 0));
      const stored = q.marksAwarded ?? 0;
      if (Math.abs(proseSum - stored) > 0.0001) {
        mismatches.push({ paperId: p.id, title: p.title, questionNum: q.questionNum, stored, prose: proseSum, subject: p.subject });
      }
    }
  }
  console.log(`Mismatches: ${mismatches.length}`);
  for (const m of mismatches.slice(0, 50)) {
    console.log(`  ${m.paperId} (${m.subject}, ${m.title.slice(0, 60)}) Q${m.questionNum}: stored=${m.stored} → prose=${m.prose}`);
  }
  if (mismatches.length > 50) console.log(`  … ${mismatches.length - 50} more`);
  process.exit(0);
}
main();
