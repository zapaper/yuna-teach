// Allow-list of accounts that can see the student-facing Master Class
// links. Master Class content itself is unauthed (any /master-class URL
// loads), but the home-dashboard nav links and bottom-nav tab are
// hidden from accounts not on this list until we ship to all students.
//
// To grant access: add the user's `name` (case-insensitive) to the
// array below. Admin accounts also bypass this gate elsewhere.
const ALLOWED_NAMES_LC: ReadonlySet<string> = new Set([
  "admin",
  "student666",
  "mark lim",
  "david lim",
  "melissa",
  "kidmummy",
]);

export function canSeeMasterClass(name: string | null | undefined): boolean {
  if (!name) return false;
  return ALLOWED_NAMES_LC.has(name.toLowerCase());
}
