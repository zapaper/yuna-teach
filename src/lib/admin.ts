// Centralised admin check. A user is treated as admin when EITHER:
// 1. Their login username is `admin` (case-insensitive) — the original
//    founder account.
// 2. Their `settings.admin` flag is set to `true` — flipped via the
//    `scripts/set-admin.ts` DB script per added admin.
//
// All admin gates (UI affordances, /api/admin/* routes, /admin page,
// etc.) MUST go through this helper so adding a new admin only
// requires the DB flip — no code change.
export function isAdmin(u: { name?: string | null; settings?: unknown } | null | undefined): boolean {
  if (!u) return false;
  if (u.name?.toLowerCase() === "admin") return true;
  const settings = u.settings as { admin?: unknown } | null | undefined;
  return settings?.admin === true;
}
