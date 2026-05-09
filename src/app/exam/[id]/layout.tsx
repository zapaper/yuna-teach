import { prisma } from "@/lib/db";
import { isAuthorizedForUsers, redirectToLogin } from "@/lib/access";

export const dynamic = "force-dynamic";

// Gate ALL /exam/[id]/* routes — main page, overview, review,
// edit, annotate, focused, transcribe-edit.
//
// Allowed: paper owner (paper.userId), assigned student
// (paper.assignedToId), or admin. Anyone else is bounced to login.
//
// For master papers (paperType=null, no assignedToId, userId =
// whoever uploaded — usually an admin), only admins pass. That's
// the correct behaviour: non-admin users have no business reading
// arbitrary master papers.

export default async function ExamLayout({
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
    redirectToLogin(`/exam/${id}`);
  }
  const auth = await isAuthorizedForUsers([paper.userId, paper.assignedToId]);
  if (!auth.ok) {
    redirectToLogin(`/exam/${id}`);
  }
  return <>{children}</>;
}
