-- Optional typed flag note. Sits alongside flagVoiceNote so users can
-- pick whichever input method suits them.
ALTER TABLE "exam_questions"
  ADD COLUMN "flagText" TEXT;
