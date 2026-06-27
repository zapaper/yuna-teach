-- Add admin-reply columns to feedback so admins can respond to a
-- submission and the user sees the reply in their notifications surface
-- (same pattern as ExamQuestion.adminReply). adminReplyRead defaults
-- to false so freshly-written replies show up as unread on the next
-- /api/notifications fetch.
ALTER TABLE "feedback" ADD COLUMN "adminReply" TEXT;
ALTER TABLE "feedback" ADD COLUMN "adminRepliedAt" TIMESTAMP(3);
ALTER TABLE "feedback" ADD COLUMN "adminReplyRead" BOOLEAN NOT NULL DEFAULT false;
