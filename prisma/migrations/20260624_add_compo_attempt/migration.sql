-- CreateTable
CREATE TABLE "compo_attempts" (
    "id" TEXT NOT NULL,
    "uploaderId" TEXT,
    "label" TEXT,
    "questionImagePath" TEXT,
    "compositionImagePaths" JSONB NOT NULL,
    "studentTopic" TEXT,
    "optionType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "errorMessage" TEXT,
    "ocrText" TEXT,
    "ocrQuestionText" TEXT,
    "wrongWords" JSONB,
    "critique" JSONB,
    "recommendations" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "analysedAt" TIMESTAMP(3),

    CONSTRAINT "compo_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "compo_attempts_uploaderId_idx" ON "compo_attempts"("uploaderId");

-- CreateIndex
CREATE INDEX "compo_attempts_status_idx" ON "compo_attempts"("status");
