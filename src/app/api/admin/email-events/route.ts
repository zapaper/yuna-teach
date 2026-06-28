import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
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
//                              student.settings.progressReportsSent
//   lumi_intro_15_mistakes   — per student, per subject, from
//                              student.settings.lumiIntroSent
//   activation_nudge         — Day-3 nurture (Grammar+Vocab quiz), from
//                              student.settings.activationNudgeSent
//                              (single ISO timestamp, fires once per kid)
//   activation_followup      — Day-6 follow-up Science quiz, from
//                              student.settings.activationFollowupSent
//
// Friday Lumi refresh is not yet implemented in main app — when it is,
// add a new branch here that surfaces those records too.
//
// Auth: NURTURE_API_TOKEN bearer (same as /api/admin/parent-progress)
// OR an admin browser session.

export const maxDuration = 120;

type EventType =
  | "welcome"
  | "subject_3_quizzes_done"
  | "lumi_intro_15_mistakes"
  | "lumi_friday_refresh"
  | "activation_nudge"
  | "activation_followup";

type EmailEvent = {
  to: string;
  to_name?: string;
  event_type: EventType;
  sent_at: string;
  subject_key?: string;
  child_name?: string;
};

function firstName(full: string | null | undefined): string {
  return (full ?? "").trim().split(/\s+/)[0] ?? "";
}

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

  // --- Query 1: welcome events ----------------------------------------
  // Parents created since <since>. The settings JSON is NOT loaded here —
  // welcome doesn't need it. Cheap query, hits the createdAt index.
  const welcomeParents = await prisma.user.findMany({
    where: {
      role: "PARENT",
      email: { not: null },
      ...(sinceDate ? { createdAt: { gte: sinceDate } } : {}),
    },
    select: { name: true, displayName: true, email: true, createdAt: true },
  });

  const events: EmailEvent[] = [];
  for (const p of welcomeParents) {
    if (!p.email) continue;
    events.push({
      to: p.email,
      to_name: firstName(p.displayName ?? p.name),
      event_type: "welcome",
      sent_at: p.createdAt.toISOString(),
    });
  }

  // --- Query 2: per-subject events (progress + lumi) ------------------
  // Raw SQL that pulls ONLY the JSON paths we need from settings (not
  // the entire blob — settings can be tens of KB per student between
  // the various other features parked in it). Joins parent emails via
  // ParentStudent so we can attribute each event to the right inbox.
  //
  // Returns one row per (parent, student) pair that has at least one
  // progressReportsSent entry OR one lumiIntroSent entry. Filtering by
  // since happens in JS after JSON.parse — JSONB date filters would
  // require iterating the JSONB anyway.
  type SubjectEventRow = {
    parentEmail: string;
    parentName: string | null;
    parentDisplayName: string | null;
    studentName: string;
    studentDisplayName: string | null;
    progressReportsSent: Record<string, string> | null;
    lumiIntroSent: Record<string, string> | null;
    // Single-string timestamps (NOT per-subject objects). Cast via
    // ->>'key' so Postgres hands us the raw string, not a JSON value.
    activationNudgeSent: string | null;
    activationFollowupSent: string | null;
  };
  const subjectRows = await prisma.$queryRaw<SubjectEventRow[]>(Prisma.sql`
    SELECT
      p.email                                       AS "parentEmail",
      p.name                                        AS "parentName",
      p."displayName"                               AS "parentDisplayName",
      s.name                                        AS "studentName",
      s."displayName"                               AS "studentDisplayName",
      s.settings->'progressReportsSent'             AS "progressReportsSent",
      s.settings->'lumiIntroSent'                   AS "lumiIntroSent",
      s.settings->>'activationNudgeSent'            AS "activationNudgeSent",
      s.settings->>'activationFollowupSent'         AS "activationFollowupSent"
    FROM users p
    INNER JOIN parent_students ps ON ps."parentId" = p.id
    INNER JOIN users s ON s.id = ps."studentId"
    WHERE p.role = 'PARENT'
      AND p.email IS NOT NULL
      AND (
        s.settings->'progressReportsSent' IS NOT NULL
        OR s.settings->'lumiIntroSent' IS NOT NULL
        OR s.settings->>'activationNudgeSent' IS NOT NULL
        OR s.settings->>'activationFollowupSent' IS NOT NULL
      )
  `);

  for (const r of subjectRows) {
    if (!r.parentEmail) continue;
    const toName = firstName(r.parentDisplayName ?? r.parentName);
    const childName = firstName(r.studentDisplayName ?? r.studentName);

    if (r.progressReportsSent && typeof r.progressReportsSent === "object") {
      for (const [subjectKey, ts] of Object.entries(r.progressReportsSent)) {
        const dt = new Date(ts);
        if (isNaN(dt.getTime())) continue;
        if (sinceDate && dt < sinceDate) continue;
        events.push({
          to: r.parentEmail,
          to_name: toName,
          event_type: "subject_3_quizzes_done",
          sent_at: dt.toISOString(),
          subject_key: subjectKey,
          child_name: childName,
        });
      }
    }

    if (r.lumiIntroSent && typeof r.lumiIntroSent === "object") {
      for (const [subjectKey, ts] of Object.entries(r.lumiIntroSent)) {
        const dt = new Date(ts);
        if (isNaN(dt.getTime())) continue;
        if (sinceDate && dt < sinceDate) continue;
        events.push({
          to: r.parentEmail,
          to_name: toName,
          event_type: "lumi_intro_15_mistakes",
          sent_at: dt.toISOString(),
          subject_key: subjectKey,
          child_name: childName,
        });
      }
    }

    // Day-3 activation nudge — single timestamp per kid (not per-subject).
    if (r.activationNudgeSent) {
      const dt = new Date(r.activationNudgeSent);
      if (!isNaN(dt.getTime()) && (!sinceDate || dt >= sinceDate)) {
        events.push({
          to: r.parentEmail,
          to_name: toName,
          event_type: "activation_nudge",
          sent_at: dt.toISOString(),
          child_name: childName,
        });
      }
    }

    // Day-6 follow-up Science nudge — single timestamp per kid.
    if (r.activationFollowupSent) {
      const dt = new Date(r.activationFollowupSent);
      if (!isNaN(dt.getTime()) && (!sinceDate || dt >= sinceDate)) {
        events.push({
          to: r.parentEmail,
          to_name: toName,
          event_type: "activation_followup",
          sent_at: dt.toISOString(),
          child_name: childName,
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
