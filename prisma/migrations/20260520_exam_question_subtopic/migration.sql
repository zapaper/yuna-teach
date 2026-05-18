-- Master Class sub-topic tag for each ExamQuestion. Finer-grained
-- than `syllabusTopic` — within a topic like "Interactions within
-- the environment" the sub-topic is one of: definitions / causal-chain /
-- mutual-benefits / food-web-explaining / adaptation / decomposer /
-- human-impact. Null until classified.
ALTER TABLE "exam_questions"
  ADD COLUMN "subTopic" TEXT;

CREATE INDEX IF NOT EXISTS "exam_questions_subTopic_idx" ON "exam_questions"("subTopic");
