-- AlterTable
ALTER TABLE "exam_papers" ADD COLUMN     "sourceExamId" TEXT;

-- AddForeignKey
ALTER TABLE "exam_papers" ADD CONSTRAINT "exam_papers_sourceExamId_fkey" FOREIGN KEY ("sourceExamId") REFERENCES "exam_papers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
