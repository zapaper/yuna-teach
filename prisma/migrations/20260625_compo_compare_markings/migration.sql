-- AlterTable
ALTER TABLE "compo_attempts"
  ADD COLUMN "compareToMarkings" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "ocrTextWithMarkings" TEXT;
