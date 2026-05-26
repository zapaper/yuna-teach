-- CreateTable
CREATE TABLE "english_supplementary_papers" (
    "id" TEXT NOT NULL,
    "year" TEXT NOT NULL,
    "pdfPath" TEXT,
    "pageCount" INTEGER,
    "paper1Pages" JSONB,
    "paper3Pages" JSONB,
    "paper4Pages" JSONB,
    "paper1AnswerPages" JSONB,
    "paper3AnswerPages" JSONB,
    "paper4AnswerPages" JSONB,
    "paper1Text" TEXT,
    "paper3Text" TEXT,
    "paper4Text" TEXT,
    "paper1AnswerText" TEXT,
    "paper3AnswerText" TEXT,
    "paper4AnswerText" TEXT,
    "situationalWriting" JSONB,
    "continuousPrompts" JSONB,
    "listeningMcqs" JSONB,
    "oralReadingPassage" TEXT,
    "oralStimulusPicture" JSONB,
    "situationalModel" TEXT,
    "continuousModel" TEXT,
    "listeningAnswers" JSONB,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "errorMessage" TEXT,
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "english_supplementary_papers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "english_supplementary_papers_year_key" ON "english_supplementary_papers"("year");
