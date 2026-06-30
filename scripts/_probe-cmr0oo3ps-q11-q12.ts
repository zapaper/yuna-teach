import "dotenv/config";
import { prisma } from "../src/lib/db";

(async () => {
  const paperId = "cmr0oo3ps001jb307o6lcclr0";
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: paperId, questionNum: { in: ["11", "12"] } },
    orderBy: { questionNum: "asc" },
    select: {
      id: true, questionNum: true,
      transcribedStem: true, transcribedSubparts: true,
      answer: true, studentAnswer: true,
      marksAwarded: true, marksAvailable: true, markingNotes: true,
      flagged: true, flagText: true,
      imageData: true, diagramImageData: true,
      sourceQuestionId: true,
    },
  });
  for (const q of qs) {
    console.log(`\n──── Q${q.questionNum} (${q.id}) ────`);
    console.log(`stem.len=${q.transcribedStem?.length ?? 0}  image.len=${q.imageData?.length ?? 0}  diagram.len=${q.diagramImageData?.length ?? 0}`);
    if (q.transcribedStem) {
      console.log(`stem text:\n  ${q.transcribedStem.replace(/\n/g, "\n  ")}`);
    }
    const subs = q.transcribedSubparts as Array<{label?: string; text?: string; diagramBase64?: string}> | null;
    if (subs?.length) {
      console.log(`subparts:`);
      for (const s of subs) {
        const diagL = s.diagramBase64?.length ?? 0;
        console.log(`  (${s.label}): ${s.text?.slice(0, 200) ?? ""} ${diagL ? `[diag ${diagL}B]` : ""}`);
      }
    }
    console.log(`answer: ${q.answer ?? "—"}`);
    console.log(`studentAnswer: ${q.studentAnswer ? JSON.stringify(q.studentAnswer).slice(0, 400) : "—"}`);
    console.log(`marks: ${q.marksAwarded ?? "—"}/${q.marksAvailable ?? "—"}`);
    console.log(`markingNotes: ${q.markingNotes ?? "—"}`);
    console.log(`flagged=${q.flagged} flagText=${q.flagText ?? "—"}`);
    console.log(`sourceQuestionId=${q.sourceQuestionId ?? "—"}`);
  }
  await prisma.$disconnect();
})();
