-- Paper 4 answer-blob classification.
--
-- paper4AnswerText is a raw OCR dump from the tutor-published PSLE
-- English yearly papers. Because those tutor books each format their
-- model-answer sections differently, the "Paper 4 answer" region
-- across years actually contains a mix:
--   - Some years hold real SBC (Stimulus-Based Conversation) model
--     responses to prompts (a), (b), (c). Example: 2024.
--   - Other years hold Paper 3 (Listening Comprehension) MCQ answers
--     that spilled into that PDF section. Examples: 2025, 2023.
--   - Most years have a partial mix (SBC header present but no clean
--     ABC prompts detected). Examples: 2016-2019, 2021, 2022.
--   - Some years are empty. Example: 2020 (blob is empty).
--
-- Rather than re-classifying the blob on every read, we label the row
-- once via paper4AnswerContentKind. A follow-up code pass (Gemini)
-- extracts SBC content into the structured oralModelAnswers field when
-- kind='sbc_model_answers', and P3 content into listeningAnswers when
-- kind='p3_listening_answers'.
--
-- Valid values:
--   'sbc_model_answers'      — clean SBC content, ready for extraction
--   'p3_listening_answers'   — miscategorised Paper 3 listening answers
--   'partial_sbc'            — SBC header present, mixed content
--   'empty'                  — blob is NULL or 0 chars
--   'unclassified'           — none of the above; needs manual look

ALTER TABLE "english_supplementary_papers"
  ADD COLUMN "paper4AnswerContentKind" TEXT;

-- Backfill kind for existing rows using the same regex checks as the
-- _scan-sbc-coverage.ts script. Order matters: check for the
-- 'Based on the recording' listening-answer tell first, since some
-- rows have BOTH the SBC header + listening-answer body (miscategorised
-- listening blob happens to sit under a "PAPER 4" page header).

UPDATE "english_supplementary_papers"
SET "paper4AnswerContentKind" =
  CASE
    WHEN "paper4AnswerText" IS NULL OR LENGTH("paper4AnswerText") = 0
      THEN 'empty'
    WHEN "paper4AnswerText" ~* 'Based on the recording'
      THEN 'p3_listening_answers'
    WHEN "paper4AnswerText" ~* '(PAPER\s*4|STIMULUS[-\s]BASED\s*CONVERSATION)'
      AND "paper4AnswerText" ~ '\*\*\(?[abc]\)?\*\*'
      THEN 'sbc_model_answers'
    WHEN "paper4AnswerText" ~* '(PAPER\s*4|STIMULUS[-\s]BASED\s*CONVERSATION)'
      THEN 'partial_sbc'
    ELSE 'unclassified'
  END
WHERE "paper4AnswerContentKind" IS NULL;

CREATE INDEX "english_supplementary_papers_paper4AnswerContentKind_idx"
  ON "english_supplementary_papers" ("paper4AnswerContentKind");
