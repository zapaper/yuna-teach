-- Denormalise metadata.revisionMode → isRevision column so /api/exam
-- can skip pulling the JSONB metadata column for every paper just to
-- derive a single boolean. The metadata fetch was ~2 s of the 7 s
-- dashboard refresh on a busy parent.

ALTER TABLE "exam_papers"
  ADD COLUMN "isRevision" BOOLEAN NOT NULL DEFAULT false;

-- Backfill from existing JSONB. revisionMode is a string like "review"
-- or "practice" set by the student-revision admin route. Anything
-- non-null/non-empty counts.
UPDATE "exam_papers"
SET "isRevision" = true
WHERE metadata->>'revisionMode' IS NOT NULL
  AND metadata->>'revisionMode' != '';
