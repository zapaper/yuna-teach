// One-off repair: for a quiz paper that was cloned before the
// 完成对话 fix, copy the canonical section metadata from the source
// paper so the quiz UI shows the right section title + word bank.
//
// Usage: npx tsx scripts/repair-quiz-dialogue.ts <quizPaperId>
import { prisma } from "../src/lib/db";

(async () => {
  const quizPaperId = process.argv[2];
  if (!quizPaperId) {
    console.error("Usage: npx tsx scripts/repair-quiz-dialogue.ts <quizPaperId>");
    process.exit(1);
  }
  const quiz = await prisma.examPaper.findUnique({
    where: { id: quizPaperId },
    select: { id: true, title: true, sourceExamId: true, metadata: true, questions: { select: { sourceQuestionId: true } } },
  });
  if (!quiz) { console.error("Paper not found"); process.exit(1); }

  // Resolve source paper. Prefer sourceExamId if present; else infer
  // from any question's sourceQuestionId.
  let sourcePaperId = quiz.sourceExamId;
  if (!sourcePaperId && quiz.questions.length > 0 && quiz.questions[0].sourceQuestionId) {
    const srcQ = await prisma.examQuestion.findUnique({
      where: { id: quiz.questions[0].sourceQuestionId },
      select: { examPaperId: true },
    });
    sourcePaperId = srcQ?.examPaperId ?? null;
  }
  if (!sourcePaperId) {
    console.error("Could not determine source paper id");
    process.exit(1);
  }
  console.log(`Source paper: ${sourcePaperId}`);
  const source = await prisma.examPaper.findUnique({
    where: { id: sourcePaperId },
    select: { title: true, metadata: true },
  });
  if (!source) { console.error("Source not found"); process.exit(1); }
  console.log(`  ${source.title}`);

  const srcMeta = (source.metadata ?? {}) as Record<string, unknown>;
  const srcSections = (srcMeta.sectionOcrTexts ?? {}) as Record<string, Record<string, unknown>>;
  const srcChinese = (srcMeta.chineseSections ?? []) as Array<{ label: string; startIndex: number; endIndex: number; passage?: string }>;

  // Find the source's 完成对话 entries
  const dialogueKey = Object.keys(srcSections).find(k => /完成对话|对话填空/.test(k));
  if (!dialogueKey) {
    console.error("Source paper has no 完成对话 section in sectionOcrTexts. Re-extract source first.");
    process.exit(1);
  }
  console.log(`  Source has section "${dialogueKey}"`);
  const srcDialogueOcr = srcSections[dialogueKey];

  // Update the QUIZ paper: stamp sectionOcrTexts["完成对话"] and ensure
  // chineseSections has the canonical label + passage. The quiz's
  // chineseSections may have an existing entry; relabel it.
  const quizMeta = (quiz.metadata ?? {}) as Record<string, unknown>;
  const quizSections = (quizMeta.sectionOcrTexts ?? {}) as Record<string, Record<string, unknown>>;
  quizSections["完成对话"] = srcDialogueOcr;
  // Remove any English-aliased stale key.
  for (const k of Object.keys(quizSections)) {
    if (k !== "完成对话" && /dialogue\s*completion|complete\s*dialogue|对话填空/i.test(k)) {
      console.log(`  Removing stale quiz key "${k}"`);
      delete quizSections[k];
    }
  }

  const quizChinese = (quizMeta.chineseSections ?? []) as Array<{ label: string; startIndex: number; endIndex: number; passage?: string }>;
  const dialogueSrc = srcChinese.find(s => /完成对话|对话填空/.test(s.label));
  const dialogueIdx = quizChinese.findIndex(s => /完成对话|对话填空|dialogue/i.test(s.label));
  if (dialogueIdx >= 0) {
    console.log(`  Quiz chineseSections[${dialogueIdx}] was "${quizChinese[dialogueIdx].label}" → "完成对话"`);
    quizChinese[dialogueIdx] = {
      ...quizChinese[dialogueIdx],
      label: "完成对话",
      // Carry over the passage (word bank + dialogue text) from source
      passage: dialogueSrc?.passage ?? (srcDialogueOcr.ocrText as string | undefined) ?? quizChinese[dialogueIdx].passage,
    };
  } else {
    console.log(`  Quiz had no 完成对话 / dialogue section entry — skipping chineseSections update`);
  }

  await prisma.examPaper.update({
    where: { id: quizPaperId },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { metadata: { ...quizMeta, sectionOcrTexts: quizSections, chineseSections: quizChinese } as any },
  });
  console.log("Repaired quiz paper metadata.");

  // Also relabel questions that still carry the English topic.
  const renamed = await prisma.examQuestion.updateMany({
    where: { examPaperId: quizPaperId, syllabusTopic: { not: "完成对话" }, OR: [
      { syllabusTopic: { contains: "dialogue", mode: "insensitive" } },
      { syllabusTopic: { contains: "对话填空", mode: "insensitive" } },
    ] },
    data: { syllabusTopic: "完成对话" },
  });
  console.log(`Renamed ${renamed.count} question(s) syllabusTopic → 完成对话`);

  await prisma.$disconnect();
})();
