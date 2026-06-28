-- Essay Coach: extend CompoAttempt to support English compositions
-- alongside the original Chinese pipeline.
--
-- language          → "chinese" | "english". NULL = legacy row (predates
--                     the multi-language support); the orchestrator
--                     treats NULL as "chinese" so old uploads keep
--                     working unchanged.
-- englishComponent  → "continuous" | "situational". Only meaningful when
--                     language = 'english'. Continuous = the 36-mark
--                     theme-based picture writing; Situational = the
--                     14-mark task-based scenario writing.

ALTER TABLE "compo_attempts"
  ADD COLUMN "language" TEXT,
  ADD COLUMN "englishComponent" TEXT;

CREATE INDEX "compo_attempts_language_idx" ON "compo_attempts"("language");
