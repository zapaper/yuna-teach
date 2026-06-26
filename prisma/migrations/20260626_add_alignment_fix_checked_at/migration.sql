-- Add a timestamp the alignment-fix tool stamps after a dry-run that
-- returned "no-change", so future findBroken() calls can exclude the
-- question while it's still fresh. Invalidates when subparts / answer
-- are edited (compare against examQuestion.updatedAt at query time).
ALTER TABLE "exam_questions" ADD COLUMN "alignmentFixCheckedAt" TIMESTAMP(3);
