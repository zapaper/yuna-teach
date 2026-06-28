-- Parent Essay Coach: link each compo attempt to a specific child
-- so the parent's list view can scope history to the currently
-- selected student. Nullable for backwards compatibility with
-- existing admin uploads where the student wasn't known.

ALTER TABLE "compo_attempts"
  ADD COLUMN "studentId" TEXT;

CREATE INDEX "compo_attempts_studentId_idx" ON "compo_attempts"("studentId");
