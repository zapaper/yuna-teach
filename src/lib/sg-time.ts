// Singapore-time helpers. Singapore is fixed at UTC+8, no DST, so
// the offset is a constant. Centralised here so server-side "today"
// calculations (streaks, weekly leaderboards, daily quizzes etc.)
// don't accidentally bucket by the container's UTC midnight, which
// would make a Singapore user's 1am-7am SGT activity land in the
// previous day.
//
// Client code that needs "today" can mostly keep using new Date()
// because the browser is already in the user's local timezone, but
// when consistency with the server matters, use toSGDateStr to
// align both sides on the same key.

const SG_OFFSET_MS = 8 * 60 * 60 * 1000;

// Returns YYYY-MM-DD for the given moment in Singapore time.
// Uses UTC getters on a shifted Date so we don't depend on the
// host's local timezone.
export function toSGDateStr(d: Date = new Date()): string {
  const wall = new Date(d.getTime() + SG_OFFSET_MS);
  return `${wall.getUTCFullYear()}-${String(wall.getUTCMonth() + 1).padStart(2, "0")}-${String(wall.getUTCDate()).padStart(2, "0")}`;
}

// Returns the Date representing midnight Singapore for the calendar
// day that contains the given moment. The returned Date's UTC
// representation is 16:00 of the previous UTC day.
export function startOfDaySG(d: Date = new Date()): Date {
  const wall = new Date(d.getTime() + SG_OFFSET_MS);
  wall.setUTCHours(0, 0, 0, 0);
  return new Date(wall.getTime() - SG_OFFSET_MS);
}

// Returns the Date representing midnight Singapore of the most recent
// Monday on or before the given moment. Used to bucket weekly
// leaderboards by Singapore week, not UTC week.
export function startOfWeekSG(d: Date = new Date()): Date {
  const monday = startOfDaySG(d);
  const wall = new Date(monday.getTime() + SG_OFFSET_MS);
  const dow = wall.getUTCDay(); // 0=Sun, 1=Mon … 6=Sat
  const diff = dow === 0 ? 6 : dow - 1;
  return new Date(monday.getTime() - diff * 86400000);
}
