-- CreateEnum
CREATE TYPE "Role" AS ENUM ('STUDENT', 'PARENT');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'STUDENT',
    "level" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- Create default student (Primary 4)
INSERT INTO "users" ("id", "name", "role", "level") VALUES ('default-student', 'Student', 'STUDENT', 4);

-- Add userId column as nullable first
ALTER TABLE "spelling_tests" ADD COLUMN "userId" TEXT;

-- Assign all existing tests to the default student
UPDATE "spelling_tests" SET "userId" = 'default-student';

-- Now make it required
ALTER TABLE "spelling_tests" ALTER COLUMN "userId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "spelling_tests" ADD CONSTRAINT "spelling_tests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
