-- Difficulty rating 1-5 on ExamQuestion. Nullable — only populated by the
-- AI-classification backfill for clean-extracted master questions.
ALTER TABLE "exam_questions"
  ADD COLUMN "difficulty" INTEGER;
