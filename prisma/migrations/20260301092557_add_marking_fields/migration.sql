-- AlterTable
ALTER TABLE "exam_papers" ADD COLUMN     "markingStatus" TEXT;

-- AlterTable
ALTER TABLE "exam_questions" ADD COLUMN     "markingNotes" TEXT,
ADD COLUMN     "marksAvailable" DOUBLE PRECISION,
ADD COLUMN     "marksAwarded" DOUBLE PRECISION;
