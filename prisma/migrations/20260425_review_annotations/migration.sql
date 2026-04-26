-- Parent's red-pen annotations on the quiz review page. JSON object
-- keyed by "passage:<sectionIdx>" or "question:<questionId>", value is
-- a PNG data URL of the canvas.
ALTER TABLE "exam_papers"
  ADD COLUMN "reviewAnnotations" JSONB;
