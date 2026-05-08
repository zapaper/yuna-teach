import { prisma } from "@/lib/db";
import { isAuthorizedForUsers, redirectToLogin } from "@/lib/access";

// Gate /quiz/[id] — only the assigned student, the parent who set
// the quiz (paper.userId), or an admin can open it. Anyone else
// (including a parent for a different family) is bounced to /login.
//
// Without this gate anyone with the quiz id could:
//   - Read the answer key + transcribed options.
//   - Submit/overwrite the student's answers (vandalism or cheating).
//   - Trigger AI re-marks, which costs Gemini API tokens.
//   - Spam the flag-question endpoint.

export default async function QuizLayout({
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
    // Don't leak whether the id exists — same redirect as unauthorized.
    redirectToLogin(`/quiz/${id}`);
  }
  const auth = await isAuthorizedForUsers([paper.userId, paper.assignedToId]);
  if (!auth.ok) {
    redirectToLogin(`/quiz/${id}`);
  }
  return <>{children}</>;
}
