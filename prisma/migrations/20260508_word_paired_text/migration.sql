-- Pair text for two-column vocab spelling sheets (e.g. English ↔
-- Malay). Lets the AI meaning generator disambiguate polysemous
-- words by including the partner from the source list as context.
ALTER TABLE "words"
  ADD COLUMN "pairedText" TEXT;
