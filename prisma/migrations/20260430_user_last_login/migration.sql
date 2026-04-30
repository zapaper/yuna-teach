-- Tracks the most recent successful login for the manage-users
-- panel. NULL for any user who hasn't logged in since the column
-- was added.
ALTER TABLE "users"
  ADD COLUMN "lastLoginAt" TIMESTAMP(3);
