-- AlterTable: structured extraction columns for ChineseSupplementaryPaper
ALTER TABLE "chinese_supplementary_papers"
  ADD COLUMN "compoOption1Topic" TEXT,
  ADD COLUMN "compoOption2" JSONB,
  ADD COLUMN "listeningMcqs" JSONB,
  ADD COLUMN "listeningPassages" JSONB,
  ADD COLUMN "compoOption1Model" TEXT,
  ADD COLUMN "compoOption2Model" TEXT,
  ADD COLUMN "listeningAnswers" JSONB;
