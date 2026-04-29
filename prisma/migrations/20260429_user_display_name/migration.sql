-- Mutable display name for users, separate from the immutable login
-- username (`name`). NULL means "fall back to `name`" so existing
-- users keep their current display untouched until they rename.
ALTER TABLE "users"
  ADD COLUMN "displayName" TEXT;
