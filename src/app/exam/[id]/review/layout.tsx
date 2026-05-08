import { prisma } from "@/lib/db";
import { isAuthorizedForUsers, redirectToLogin } from "@/lib/access";

export const dynamic = "force-dynamic";

// Gate /exam/[id]/review — only the parent who owns the paper
// (userId), the assigned student (assignedToId), or an admin can
// view marks + AI feedback. Anyone else is bounced to /login.

export default async function ExamReviewLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: { userId: true, assignedToId: true },
  });
  if (!paper) {
    redirectToLogin(`/exam/${id}/review`);
  }
  const auth = await isAuthorizedForUsers([paper.userId, paper.assignedToId]);
  if (!auth.ok) {
    redirectToLogin(`/exam/${id}/review`);
  }
  return <>{children}</>;
}
