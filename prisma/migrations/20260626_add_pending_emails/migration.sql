-- CreateTable
CREATE TABLE "pending_emails" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "toEmail" TEXT NOT NULL,
    "toName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attemptedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "pending_emails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pending_emails_status_createdAt_idx" ON "pending_emails"("status", "createdAt");

-- CreateIndex
CREATE INDEX "pending_emails_eventType_idx" ON "pending_emails"("eventType");
