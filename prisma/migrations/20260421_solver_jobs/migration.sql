-- Transient store for AI-solver results so the client can reconnect and
-- fetch the outcome if its tab was backgrounded mid-call. Rows are
-- deleted opportunistically after ~15 minutes by the API route.
CREATE TABLE "solver_jobs" (
  "id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "result" JSONB,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "solver_jobs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "solver_jobs_createdAt_idx" ON "solver_jobs"("createdAt");
