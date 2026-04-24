-- Per-page admin pen/eraser annotations on an exam paper. JSON object
-- keyed by zero-based page index, value is a PNG data URL.
ALTER TABLE "exam_papers"
  ADD COLUMN "annotationsByPage" JSONB;
