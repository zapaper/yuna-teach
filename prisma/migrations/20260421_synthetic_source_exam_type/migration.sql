-- Tag each Synthetic Bank question with the examType of its ORIGINAL source
-- paper (WA1/WA2/EOY/Prelim). Nullable — only populated for rows that came
-- through the synthetic generator.
ALTER TABLE "exam_questions"
  ADD COLUMN "syntheticSourceExamType" TEXT;
