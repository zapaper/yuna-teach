-- AlterTable: add password-reset link fields to users
-- Used by /api/auth/forgot-password and /api/auth/reset-password
-- for the reset-link flow (replaces the old plaintext-password email).
-- Both fields nullable; non-null only while a reset is in flight.
ALTER TABLE "users"
  ADD COLUMN "passwordResetToken" TEXT,
  ADD COLUMN "passwordResetExpires" TIMESTAMP(3);

CREATE UNIQUE INDEX "users_passwordResetToken_key" ON "users"("passwordResetToken");
