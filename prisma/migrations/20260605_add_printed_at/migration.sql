-- Track when a master / focused / quiz paper has been printed so the
-- student homepage can surface a self-serve scan-back camera icon
-- for that assignment.
ALTER TABLE "exam_papers" ADD COLUMN "printedAt" TIMESTAMP(3);
