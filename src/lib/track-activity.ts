import { prisma } from "./db";

// Bump a parent's "last active" stamp. Used wherever a parent
// performs a meaningful action so the admin page reflects active
// usage, not just login. Fire-and-forget — never blocks the request.
//
// Throttled in-memory to one write per user per 5 minutes so a chatty
// dashboard refresh doesn't hammer the DB.

const THROTTLE_MS = 5 * 60 * 1000;
const lastBumpAt = new Map<string, number>();

export function bumpUserActivity(userId: string | null | undefined): void {
  if (!userId) return;
  const now = Date.now();
  const prev = lastBumpAt.get(userId) ?? 0;
  if (now - prev < THROTTLE_MS) return;
  lastBumpAt.set(userId, now);
  // Reuse the existing lastLoginAt column rather than adding a new one
  // — semantics are now "last activity (login or any meaningful
  // request)". Admin label is updated to match.
  prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } }).catch((err) => {
    console.warn(`[track-activity] couldn't bump ${userId}:`, err);
  });
}
