-- Marks whether the admin awarded a +1 crystal alongside their reply
-- on this flagged question. Acts as the idempotency guard so a duplicate
-- /reply POST doesn't double-credit the kid's settings.bonusCrystals.
ALTER TABLE "exam_questions"
  ADD COLUMN "crystalAwarded" BOOLEAN NOT NULL DEFAULT false;
