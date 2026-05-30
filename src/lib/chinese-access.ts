// Allow-list for accounts that can assign Chinese quizzes /
// Chinese-paper test quizzes. Chinese is otherwise admin-only because
// the bank is curated separately and the marker integration is
// still under verification.
//
// To grant access: add the user's `name` (case-insensitive) to the
// array below. Admin accounts also bypass this gate elsewhere
// (`isAdmin()` in src/lib/admin.ts) so they don't need to be listed.
const ALLOWED_NAMES_LC: ReadonlySet<string> = new Set([
  "student666",
  "mark lim",
  "david lim",
]);

export function canAssignChinese(name: string | null | undefined): boolean {
  if (!name) return false;
  return ALLOWED_NAMES_LC.has(name.toLowerCase());
}
