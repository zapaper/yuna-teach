-- AlterTable
ALTER TABLE "exam_papers" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "score" DOUBLE PRECISION,
ADD COLUMN     "totalMarks" TEXT;
