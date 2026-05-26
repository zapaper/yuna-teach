-- AlterTable: English supplementary — structure v2
ALTER TABLE "english_supplementary_papers"
  ADD COLUMN "continuousTheme" TEXT,
  ADD COLUMN "listeningTexts" JSONB,
  ADD COLUMN "oralDays" JSONB,
  ADD COLUMN "oralModelAnswers" JSONB;
