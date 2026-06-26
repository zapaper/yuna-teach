ALTER TABLE "compo_attempts" ADD COLUMN "useOpenAIForOcr" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "compo_attempts" ADD COLUMN "ocrTextOpenAI" TEXT;
