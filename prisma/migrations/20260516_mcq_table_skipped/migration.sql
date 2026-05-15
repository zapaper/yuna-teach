-- "Skipped" flag for the Admin → MCQ → Table conversion tool.
-- When the admin clicks Skip on a candidate question, set this to TRUE
-- so the same row never reappears in future rescans.
ALTER TABLE "exam_questions"
  ADD COLUMN "mcqTableSkipped" BOOLEAN NOT NULL DEFAULT false;
