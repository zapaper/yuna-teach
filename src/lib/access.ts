import { redirect } from "next/navigation";
import { prisma } from "./db";
import { getSessionUserId } from "./session";
import { isAdmin } from "./admin";

// Returns true when the signed-in user is allowed to view content
// owned by `ownerIds`. Admins always pass. Anyone whose session userId
// equals one of the ownerIds passes. Everyone else fails.
//
// "Owner" is intentionally a list — for an exam clone it's both the
// parent who assigned the paper (paper.userId) and the student
// taking it (paper.assignedToId). Pass any combination.
export async function isAuthorizedForUsers(ownerIds: Array<string | null | undefined>): Promise<{
  ok: true;
  sessionId: string;
} | { ok: false; sessionId: string | null }> {
  const sessionId = await getSessionUserId();
  if (!sessionId) return { ok: false, sessionId: null };

  // Admin bypass.
  const sessionUser = await prisma.user.findUnique({
    where: { id: sessionId },
    select: { name: true, settings: true },
  });
  if (isAdmin(sessionUser)) return { ok: true, sessionId };

  // Owner check.
  const owners = ownerIds.filter((id): id is string => !!id);
  if (owners.includes(sessionId)) return { ok: true, sessionId };

  return { ok: false, sessionId };
}

// Convenience: returns true if the session user is the same as the
// `studentId` OR is a parent linked to that student. Used for routes
// keyed by a student id (e.g. /progress/[studentId]) where the parent
// dashboard's "view child's progress" deeplink is a legitimate path.
export async function isAuthorizedForStudent(studentId: string): Promise<{
  ok: true;
  sessionId: string;
} | { ok: false; sessionId: string | null }> {
  const sessionId = await getSessionUserId();
  if (!sessionId) return { ok: false, sessionId: null };

  const sessionUser = await prisma.user.findUnique({
    where: { id: sessionId },
    select: { name: true, settings: true },
  });
  if (isAdmin(sessionUser)) return { ok: true, sessionId };
  if (sessionId === studentId) return { ok: true, sessionId };

  // Parent link check.
  const link = await prisma.parentStudent.findUnique({
    where: { parentId_studentId: { parentId: sessionId, studentId } },
  });
  if (link) return { ok: true, sessionId };

  return { ok: false, sessionId };
}

// Helper: redirect to login with a `next` param when access is denied.
// Pass the request URL so the user lands back where they intended.
export function redirectToLogin(currentPath: string): never {
  redirect(`/login?next=${encodeURIComponent(currentPath)}`);
}
