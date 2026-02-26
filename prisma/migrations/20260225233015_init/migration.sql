-- CreateEnum
CREATE TYPE "Language" AS ENUM ('CHINESE', 'ENGLISH');

-- CreateTable
CREATE TABLE "spelling_tests" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "language" "Language" NOT NULL DEFAULT 'CHINESE',
    "imageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spelling_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "words" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "orderIndex" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "spellingTestId" TEXT NOT NULL,

    CONSTRAINT "words_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "words" ADD CONSTRAINT "words_spellingTestId_fkey" FOREIGN KEY ("spellingTestId") REFERENCES "spelling_tests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
