-- Hot-path indexes. All CREATE INDEX IF NOT EXISTS so re-runs are safe.
-- Built CONCURRENTLY would be nicer for prod but Prisma's migrate
-- deploy can't run statements in a CONCURRENTLY-compatible transaction.
-- These tables are well under 1M rows each, so a brief AccessShareLock
-- block during the build is acceptable.

-- spelling_tests(user_id): /api/tests filters here. Was 4.5 s seq-scan.
CREATE INDEX IF NOT EXISTS "spelling_tests_userId_idx" ON "spelling_tests"("userId");

-- exam_papers hot-path filters (student home + parent dashboard + tutor)
CREATE INDEX IF NOT EXISTS "exam_papers_assignedToId_idx"  ON "exam_papers"("assignedToId");
CREATE INDEX IF NOT EXISTS "exam_papers_userId_idx"        ON "exam_papers"("userId");
CREATE INDEX IF NOT EXISTS "exam_papers_sourceExamId_idx"  ON "exam_papers"("sourceExamId");
CREATE INDEX IF NOT EXISTS "exam_papers_completedAt_idx"   ON "exam_papers"("completedAt");
CREATE INDEX IF NOT EXISTS "exam_papers_markingStatus_idx" ON "exam_papers"("markingStatus");
CREATE INDEX IF NOT EXISTS "exam_papers_paperType_idx"     ON "exam_papers"("paperType");

-- exam_questions: every nested-questions query filters by examPaperId.
CREATE INDEX IF NOT EXISTS "exam_questions_examPaperId_idx"      ON "exam_questions"("examPaperId");
CREATE INDEX IF NOT EXISTS "exam_questions_sourceQuestionId_idx" ON "exam_questions"("sourceQuestionId");

-- Skipped-marks scan support. Original attempt was a composite
-- (examPaperId, studentAnswer) but studentAnswer can hold the full
-- OEQ working — Mark's largest row was 28 KB, well past Postgres'
-- 8 KB B-tree row cap, which made CREATE INDEX fail with
-- 'index row requires N bytes, maximum size is 8191'.
-- A PARTIAL index over only the __SKIPPED__ rows is a tiny fraction
-- of the table, gives the /api/exam skipped-marks query an
-- index-only scan, and avoids the row-size cap entirely.
CREATE INDEX IF NOT EXISTS "exam_questions_skipped_idx"
  ON "exam_questions"("examPaperId")
  WHERE "studentAnswer" = '__SKIPPED__';

-- parent_students(student_id): /api/users for a student does
-- `studentLinks` lookup filtered by studentId. The existing composite
-- unique (parentId, studentId) can only serve parentId-leading queries.
CREATE INDEX IF NOT EXISTS "parent_students_studentId_idx" ON "parent_students"("studentId");
