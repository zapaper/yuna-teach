import { prisma } from "../src/lib/db";
(async () => {
  // The URL is /exam/cmpn9gcda000149ocsxpjju2w — could be master or clone.
  // Resolve the master first so we look at the canonical answer key.
  const PAPER = "cmpn9gcda000149ocsxpjju2w";
  const paper = await prisma.examPaper.findUnique({
    where: { id: PAPER },
    select: { id: true, title: true, paperType: true, sourceExamId: true },
  });
  console.log(`paper="${paper?.title}" type=${paper?.paperType} sourceExamId=${paper?.sourceExamId ?? "(master)"}`);
  const masterId = paper?.sourceExamId ?? PAPER;

  for (const queryPaper of [PAPER, ...(paper?.sourceExamId ? [masterId] : [])]) {
    console.log(`\n========== paperId=${queryPaper} ==========`);
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: queryPaper, questionNum: { in: ["30", "30a", "30ab", "30abc", "31"] } },
      select: { id: true, questionNum: true, answer: true, transcribedSubparts: true, flagged: true, markingNotes: true },
      orderBy: { orderIndex: "asc" },
    });
    for (const q of qs) {
      console.log(`\n--- Q${q.questionNum} (id=${q.id}) flagged=${q.flagged} ---`);
      const subs = (q.transcribedSubparts as Array<{ label: string; text?: string }> | null) ?? [];
      const realLabels = subs.filter(s => !s.label.startsWith("_")).map(s => s.label);
      console.log(`  subpart labels: [${realLabels.join(", ")}]`);
      console.log(`  answer: ${(q.answer ?? "").slice(0, 400)}`);
      if (q.markingNotes) console.log(`  notes:  ${q.markingNotes.slice(0, 200)}`);

      // Run the same auto-solve trigger check the client uses
      const ans = (q.answer ?? "").toLowerCase();
      const labels = realLabels.map(l => l.toLowerCase());
      const missing = labels.filter(l => {
        if (ans.includes(`(${l})`)) return false;
        if (ans.includes(`(${l}-`)) return false;
        if (new RegExp(`(^|[\\s|])${l}\\)`, "i").test(ans)) return false;
        if (new RegExp(`\\d+${l}[\\s:)]`, "i").test(ans)) return false;
        return true;
      });
      if (missing.length > 0) {
        console.log(`  → would trigger auto-solve: labels NOT matched = [${missing.join(", ")}]`);
      } else {
        console.log(`  → check passes: every label matched in answer`);
      }
    }
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
