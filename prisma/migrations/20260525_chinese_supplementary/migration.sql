-- CreateTable
CREATE TABLE "chinese_supplementary_papers" (
    "id" TEXT NOT NULL,
    "year" TEXT NOT NULL,
    "pdfPath" TEXT,
    "pageCount" INTEGER,
    "paper1Pages" JSONB,
    "paper3Pages" JSONB,
    "paper1AnswerPages" JSONB,
    "paper3AnswerPages" JSONB,
    "paper1Text" TEXT,
    "paper3Text" TEXT,
    "paper1AnswerText" TEXT,
    "paper3AnswerText" TEXT,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "errorMessage" TEXT,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chinese_supplementary_papers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chinese_supplementary_papers_year_key" ON "chinese_supplementary_papers"("year");
