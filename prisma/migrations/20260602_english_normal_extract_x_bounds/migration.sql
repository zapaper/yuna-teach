-- English Normal Extract Phase 2: per-question horizontal bounds.
-- yStartPct / yEndPct already exist; xStartPct / xEndPct extend the
-- crop into 2D for Booklet B sections (Grammar Cloze, Editing,
-- Comp Cloze) where a single question doesn't span the full page.

ALTER TABLE "exam_questions" ADD COLUMN "xStartPct" DOUBLE PRECISION;
ALTER TABLE "exam_questions" ADD COLUMN "xEndPct" DOUBLE PRECISION;
