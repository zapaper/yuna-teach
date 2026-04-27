-- Filename of the voice note recorded when a user flagged this question.
-- Saved on disk under VOLUME_PATH/flag-voices/<paperId>/. Null when the
-- flag was raised without a recording.
ALTER TABLE "exam_questions"
  ADD COLUMN "flagVoiceNote" TEXT;
