-- Admin "Clear" action in /admin/see-answer-image sweep: marks a
-- question as reviewed so the sweep never resurfaces it. The sweep's
-- "see image" regex stays unchanged — this is a per-question override
-- so the answer text itself can be left as-is.
ALTER TABLE "exam_questions" ADD COLUMN "seeAnswerImageCleared" BOOLEAN NOT NULL DEFAULT false;
