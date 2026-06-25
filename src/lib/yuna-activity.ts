// Thin client for GET /api/admin/activity-summary.
//
// Lives here so both Next.js routes and CLI scripts (run via tsx) can
// pull a parent's or student's 7-day activity rollup without
// re-implementing the auth / URL plumbing. The endpoint enforces
// (one of studentId, parentId) — same shape is reflected in the
// argument union below so TypeScript catches a missing id at the
// callsite.
//
// Auth: reuses NURTURE_API_TOKEN (same env var as
// /api/admin/parent-progress and /api/admin/email-events).

type SubjectRow = {
  subject: string;
  papers: number;
  marks: { awarded: number; available: number; percent: number };
};

export type ActivityStudent = {
  id: string;
  name: string;
  totalPapers: number;
  papers: { quiz: number; focused: number; assigned: number };
  marks: { awarded: number; available: number; percent: number };
  bySubject: SubjectRow[];
};

export type ActivityTotals = {
  totalPapers: number;
  papers: { quiz: number; focused: number; assigned: number };
  marks: { awarded: number; available: number; percent: number };
  bySubject: SubjectRow[];
};

export type ActivitySummary = {
  mode: "student" | "parent";
  id: string;
  windowDays: number;
  since: string;
  until: string;
  students: ActivityStudent[];
  totals: ActivityTotals;
};

export type ActivitySummaryArgs =
  | { studentId: string; parentId?: never; days?: number; bySubject?: boolean }
  | { parentId: string; studentId?: never; days?: number; bySubject?: boolean };

const DEFAULT_BASE_URL = "https://www.markforyou.com";

export async function fetchActivitySummary(
  args: ActivitySummaryArgs,
): Promise<ActivitySummary> {
  const token = process.env.NURTURE_API_TOKEN;
  if (!token) {
    throw new Error(
      "fetchActivitySummary: NURTURE_API_TOKEN env var is not set",
    );
  }
  const baseUrl = (process.env.MAIN_APP_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const params = new URLSearchParams();
  if ("studentId" in args && args.studentId) params.set("studentId", args.studentId);
  if ("parentId" in args && args.parentId) params.set("parentId", args.parentId);
  if (args.days !== undefined) params.set("days", String(args.days));
  if (args.bySubject !== undefined) params.set("bySubject", String(args.bySubject));

  const res = await fetch(`${baseUrl}/api/admin/activity-summary?${params.toString()}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `fetchActivitySummary: HTTP ${res.status} ${res.statusText} — ${body.slice(0, 300)}`,
    );
  }
  return (await res.json()) as ActivitySummary;
}

// Convenience: render a one-line "Last 7 days: 23 papers · 76% avg ·
// English 12, Math 6, Science 5" summary. Designed for the
// weekly-progress email block. Returns an empty string when there's no
// activity in the window so callers can omit the section.
export function formatActivitySummaryLine(s: ActivityStudent | ActivityTotals,
                                          opts: { days?: number } = {}): string {
  if (!s.totalPapers) return "";
  const days = opts.days ?? 7;
  const pct = s.marks.percent;
  const pctStr = Number.isFinite(pct) ? `${pct.toFixed(0)}% avg` : "";
  const subjBits = (s.bySubject || [])
    .filter((r) => r.papers > 0)
    .slice(0, 5)
    .map((r) => `${r.subject} ${r.papers}`)
    .join(", ");
  const parts = [`Last ${days} days: ${s.totalPapers} papers`];
  if (pctStr) parts.push(pctStr);
  if (subjBits) parts.push(subjBits);
  return parts.join(" · ");
}
