-- Add OEQ support to SyntheticQuestion. MCQ rows keep questionType="mcq"
-- (default) and leave the new columns null. OEQ rows use subparts +
-- answerText + marksAvailable; their options column stays as an empty
-- JSON array and correctAnswer is ignored.
ALTER TABLE "synthetic_questions"
  ADD COLUMN "questionType" TEXT NOT NULL DEFAULT 'mcq',
  ADD COLUMN "subparts" JSONB,
  ADD COLUMN "answerText" TEXT,
  ADD COLUMN "marksAvailable" INTEGER;
