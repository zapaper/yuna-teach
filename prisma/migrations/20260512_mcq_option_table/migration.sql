-- Table-format MCQ options. When the original paper presents the four
-- answer choices as a 4-row table (e.g. Science questions comparing
-- properties across two columns "Liquid" vs "Gas"), we now store the
-- columns + per-option row values here instead of flattening to a
-- single-string options array.
--
-- Shape: { columns: string[], rows: string[][] }
--   rows has exactly 4 entries, each a string[] of length columns.length.
--
-- Mutually exclusive with transcribedOptions and transcribedOptionImages —
-- the quiz UI picks the renderer based on which of the three is non-null.
ALTER TABLE "exam_questions"
  ADD COLUMN "transcribedOptionTable" JSONB;
