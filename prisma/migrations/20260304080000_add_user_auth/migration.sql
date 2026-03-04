-- AlterTable
ALTER TABLE "users" ADD COLUMN "email" TEXT,
ADD COLUMN "password" TEXT NOT NULL DEFAULT '1234';

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
