-- Cross-cutting skill tags on ExamQuestion. Orthogonal to syllabusTopic
-- and subTopic. Drives Lumi's "skill across topics" quizzes — e.g. a
-- kid weak on graph-trend-describe gets a quiz of fresh Qs sharing
-- that skill regardless of which topic they came from.
--
-- Plain TEXT[] (not a JSONB array, not a join table) because:
--   · single-table reads are the hot path; no joins to fan out
--   · empty default matches "untagged" cleanly
--   · GIN index makes "WHERE 'foo' = ANY(skillTags)" a sub-ms hit if
--     we need it later

ALTER TABLE "exam_questions"
  ADD COLUMN "skillTags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
