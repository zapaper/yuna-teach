import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// GET /api/admin/email-events?since=<iso>
//
// Returns server-event email sends the main app has recorded, for the
// markforyou-mailer's "Refresh from main app" sync. Idempotent on the
// mailer side (it dedupes by (to, event_type, sent_at)), so it's safe
// to re-pull the same window.
//
// Event types returned:
//   welcome                  — every parent has one (uses user.createdAt
//                              as the send timestamp, since the welcome
//                              fires on signup; there is no dedicated
//                              welcomeSentAt field)
//   subject_3_quizzes_done   — per student, per subject, from
//                              user.settings.progressReportsSent
//   lumi_intro_15_mistakes   — per student, per subject, from
//                              user.settings.lumiIntroSent
//
// Friday Lumi refresh is not yet implemented in main app — when it is,
// add a new branch here that surfaces those sends too.
//
// Auth: NURTURE_API_TOKEN bearer (same as /api/admin/parent-progress)
// OR an admin browser session.

export const maxDuration = 60;

type EventType =
  | "welcome"
  | "subject_3_quizzes_done"
  | "lumi_intro_15_mistakes"
  | "lumi_friday_refresh";

type EmailEvent = {
  to: string;
  to_name?: string;
  event_type: EventType;
  sent_at: string;
  subject_key?: string;
  child_name?: string;
};

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization") ?? "";
  const bearerToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  const expectedToken = process.env.NURTURE_API_TOKEN ?? "";
  const tokenOk = expectedToken !== "" && bearerToken === expectedToken;
  if (!tokenOk && !(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sinceParam = request.nextUrl.searchParams.get("since");
  const sinceDate = sinceParam ? new Date(sinceParam) : null;
  if (sinceDate && isNaN(sinceDate.getTime())) {
    return NextResponse.json({ error: "Invalid 'since' (must be ISO-8601)" }, { status: 400 });
  }

  const parents = await prisma.user.findMany({
    where: { role: "PARENT", email: { not: null } },
    select: {
      id: true,
      name: true,
      displayName: true,
      email: true,
      createdAt: true,
      parentLinks: {
        select: {
          student: {
            select: {
              id: true,
              name: true,
              displayName: true,
              settings: true,
            },
          },
        },
      },
    },
  });

  const firstName = (full: string | null | undefined): string => {
    return (full ?? "").trim().split(/\s+/)[0] ?? "";
  };

  const events: EmailEvent[] = [];
  for (const p of parents) {
    if (!p.email) continue;
    const parentEmail = p.email;
    const parentName = firstName(p.displayName ?? p.name);

    if (!sinceDate || p.createdAt >= sinceDate) {
      events.push({
        to: parentEmail,
        to_name: parentName,
        event_type: "welcome",
        sent_at: p.createdAt.toISOString(),
      });
    }

    for (const link of p.parentLinks) {
      const student = link.student;
      const studentName = firstName(student.displayName ?? student.name);
      const settings = student.settings as {
        progressReportsSent?: Record<string, string>;
        lumiIntroSent?: Record<string, string>;
      } | null;

      const progress = settings?.progressReportsSent ?? {};
      for (const [subjectKey, ts] of Object.entries(progress)) {
        const date = new Date(ts);
        if (isNaN(date.getTime())) continue;
        if (sinceDate && date < sinceDate) continue;
        events.push({
          to: parentEmail,
          to_name: parentName,
          event_type: "subject_3_quizzes_done",
          sent_at: date.toISOString(),
          subject_key: subjectKey,
          child_name: studentName,
        });
      }

      const lumi = settings?.lumiIntroSent ?? {};
      for (const [subjectKey, ts] of Object.entries(lumi)) {
        const date = new Date(ts);
        if (isNaN(date.getTime())) continue;
        if (sinceDate && date < sinceDate) continue;
        events.push({
          to: parentEmail,
          to_name: parentName,
          event_type: "lumi_intro_15_mistakes",
          sent_at: date.toISOString(),
          subject_key: subjectKey,
          child_name: studentName,
        });
      }
    }
  }

  events.sort((a, b) => b.sent_at.localeCompare(a.sent_at));

  return NextResponse.json({
    events,
    count: events.length,
    since: sinceDate?.toISOString() ?? null,
    generated_at: new Date().toISOString(),
  });
}
