import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { classifyDifficultyBatch, type DifficultyInput } from "@/lib/gemini";

const BATCH = 5;

/** Fire-and-forget: classify every un-rated question on a newly-extracted
 *  paper. Runs AFTER the extraction finalises so the paper is already
 *  usable — difficulty labels populate in the background.
 *
 *  Mirrors the admin /api/admin/classify-difficulty POST logic but scoped
 *  to a single paperId and without request/response plumbing. Text-only
 *  classification (no images) to dodge Gemini vision timeouts that still
 *  trip on batches. Sentinel 0 written on failure so stubborn rows don't
 *  loop. */
export async function classifyPaperDifficulty(paperId: string): Promise<void> {
  try {
    const paper = await prisma.examPaper.findUnique({
      where: { id: paperId },
      select: { id: true, subject: true, level: true, title: true },
    });
    if (!paper) return;

    // Skip synthetic bank papers — they inherit difficulty from their source.
    if (paper.title?.startsWith("[Synthetic Bank]")) return;

    let batchNo = 0;
    while (true) {
      const questions = await prisma.examQuestion.findMany({
        where: {
          examPaperId: paperId,
          difficulty: null,
          transcribedStem: { not: null },
        },
        select: {
          id: true, transcribedStem: true, transcribedOptions: true,
          answer: true, syllabusTopic: true,
        },
        orderBy: { orderIndex: "asc" },
        take: BATCH,
      });
      if (questions.length === 0) break;

      const batch: DifficultyInput[] = questions.map((q) => {
        const opts = Array.isArray(q.transcribedOptions)
          ? (q.transcribedOptions as Prisma.JsonArray).filter((v): v is string => typeof v === "string")
          : null;
        return {
          id: q.id,
          stem: q.transcribedStem ?? "",
          options: opts,
          answer: q.answer,
          subject: paper.subject,
          level: paper.level,
          syllabusTopic: q.syllabusTopic,
          diagramBase64: null,
          optionImagesBase64: null,
        };
      });

      batchNo += 1;
      try {
        const ratings = await classifyDifficultyBatch(batch);
        for (const q of questions) {
          const r = ratings[q.id];
          const difficulty = r ? r.difficulty : 0; // 0 = sentinel ("tried, no rating")
          await prisma.examQuestion.update({
            where: { id: q.id },
            data: { difficulty },
          });
        }
        console.log(`[difficulty] Paper ${paperId} batch ${batchNo}: classified ${questions.length} (${Object.keys(ratings).length} rated, ${questions.length - Object.keys(ratings).length} sentinel-ed).`);
      } catch (err) {
        console.warn(`[difficulty] Paper ${paperId} batch ${batchNo} failed, marking sentinel:`, err);
        for (const q of questions) {
          try { await prisma.examQuestion.update({ where: { id: q.id }, data: { difficulty: 0 } }); } catch { /* ignore */ }
        }
      }
    }
    console.log(`[difficulty] Paper ${paperId} done.`);
  } catch (err) {
    console.error(`[difficulty] classifyPaperDifficulty(${paperId}) failed:`, err);
  }
}
