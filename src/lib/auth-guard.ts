// Server-side authorisation helpers used by /api/* route handlers.
//
// Layered on top of the yuna_session middleware (src/middleware.ts)
// which already blocks every request without a valid session
// cookie. These helpers add per-resource access checks:
//
//   - requireSession(): just get the signed-in user
//   - requireAdmin(): caller must be an admin
//   - requireSelfOrAdmin(targetUserId): caller is `targetUserId` or admin
//   - requireAccessToStudent(studentId): caller is the student, a
//     parent linked to that student, or an admin
//   - requireAccessToPaper(paperId): caller owns the paper, is the
//     assigned student, a linked parent of the assignee, or an admin
//
// Each helper returns either:
//   { ok: true, userId, user, isAdmin }   — proceed
//   { ok: false, status, error }          — return as NextResponse.json
//
// Why a result type instead of throwing: keeps the control flow
// linear in routes and avoids accidental try/catch swallowing.

import { prisma } from "@/lib/db";
import { isAdmin as isAdminUser } from "@/lib/admin";
import { getSessionUserId } from "@/lib/session";

export type SessionUser = {
  id: string;
  name: string;
  role: string | null;
  settings: unknown;
};

type Ok<T = unknown> = { ok: true; userId: string; user: SessionUser; isAdmin: boolean } & T;
type Err = { ok: false; status: number; error: string };

export type GuardResult<T = unknown> = Ok<T> | Err;

async function loadSessionUser(): Promise<{ userId: string; user: SessionUser } | null> {
  const userId = await getSessionUserId();
  if (!userId) return null;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, role: true, settings: true },
  });
  if (!user) return null;
  return { userId, user: user as SessionUser };
}

/** Caller must be signed in. Middleware should have caught this already; the
 *  extra check defends against a missed whitelist entry or a deleted user. */
export async function requireSession(): Promise<GuardResult> {
  const s = await loadSessionUser();
  if (!s) return { ok: false, status: 401, error: "Not signed in" };
  return { ok: true, userId: s.userId, user: s.user, isAdmin: isAdminUser(s.user) };
}

/**
 * Resolve the "effective actor" — usually the signed-in user, but
 * admins may pass `?userId=<target>` to act on another user's
 * behalf (the legacy "admin view-as-user" pattern that the
 * homepage and several /api routes rely on).
 *
 *   targetUserId omitted  → actor = session user
 *   targetUserId == self  → actor = session user (no-op)
 *   targetUserId != self  AND  session is admin → actor = target
 *   targetUserId != self  AND  session is NOT admin → 403
 *
 * Returned `userId` is the EFFECTIVE actor — routes should use
 * that for downstream queries.
 */
export async function resolveActor(targetUserId: string | null | undefined): Promise<GuardResult & { actingAs?: string }> {
  const r = await requireSession();
  if (!r.ok) return r;
  if (!targetUserId || targetUserId === r.userId) return r;
  if (r.isAdmin) {
    // Load the impersonation target so downstream code that needs
    // role/settings/etc. gets the right values.
    const target = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, name: true, role: true, settings: true },
    });
    if (!target) return { ok: false, status: 404, error: "Target user not found" };
    return {
      ok: true,
      userId: targetUserId,
      user: target as SessionUser,
      // Admins acting AS the target user retain their admin
      // capabilities — preserving the existing behaviour where
      // admin-viewing-as-parent can still see / do things only
      // an admin can do (e.g. release perfect-score papers).
      isAdmin: true,
      actingAs: r.userId,
    };
  }
  return { ok: false, status: 403, error: "Forbidden" };
}

/** Caller must be an admin. */
export async function requireAdmin(): Promise<GuardResult> {
  const r = await requireSession();
  if (!r.ok) return r;
  if (!r.isAdmin) return { ok: false, status: 403, error: "Admin only" };
  return r;
}

/** Caller is the given `targetUserId` (acting on their own profile) or admin. */
export async function requireSelfOrAdmin(targetUserId: string): Promise<GuardResult> {
  const r = await requireSession();
  if (!r.ok) return r;
  if (r.isAdmin) return r;
  if (r.userId === targetUserId) return r;
  return { ok: false, status: 403, error: "Forbidden" };
}

/** Caller is the student themselves, a parent linked to the student, or an admin. */
export async function requireAccessToStudent(studentId: string): Promise<GuardResult> {
  const r = await requireSession();
  if (!r.ok) return r;
  if (r.isAdmin) return r;
  if (r.userId === studentId) return r;
  const link = await prisma.parentStudent.findUnique({
    where: { parentId_studentId: { parentId: r.userId, studentId } },
    select: { id: true },
  });
  if (link) return r;
  return { ok: false, status: 403, error: "Forbidden" };
}

/** Caller owns the paper, is the assigned student, a linked parent of the
 *  assignee, or an admin. Returns the paper alongside the guard result so
 *  the route doesn't have to refetch. */
export async function requireAccessToPaper(paperId: string): Promise<GuardResult<{ paper: { userId: string; assignedToId: string | null } }>> {
  const r = await requireSession();
  if (!r.ok) return r;
  const paper = await prisma.examPaper.findUnique({
    where: { id: paperId },
    select: { userId: true, assignedToId: true },
  });
  if (!paper) return { ok: false, status: 404, error: "Paper not found" };
  if (r.isAdmin) return { ...r, paper };
  if (paper.userId === r.userId) return { ...r, paper };
  if (paper.assignedToId === r.userId) return { ...r, paper };
  if (paper.assignedToId) {
    const link = await prisma.parentStudent.findUnique({
      where: { parentId_studentId: { parentId: r.userId, studentId: paper.assignedToId } },
      select: { id: true },
    });
    if (link) return { ...r, paper };
  }
  return { ok: false, status: 403, error: "Forbidden" };
}
