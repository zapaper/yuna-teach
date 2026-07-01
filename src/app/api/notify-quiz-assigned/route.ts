// POST /api/notify-quiz-assigned
//
// Fires the "Your [Subject] Diagnostic for [Child] is ready" email
// after the onboarding "Assign and Email Link" button. Fire-and-forget
// from the client — this route never blocks the parent's UI, and it
// swallows failures so an SMTP hiccup doesn't erase the assigned
// quiz.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/session";
import { sendQuizAssignedEmail } from "@/lib/send-quiz-assigned-email";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://www.markforyou.com";

const SUBJECT_LABEL: Record<string, string> = {
  math:    "Math",
  english: "English",
  science: "Science",
};

export async function POST(req: NextRequest) {
  const sessionUserId = await getSessionUserId();
  if (!sessionUserId) return NextResponse.json({ error: "unauthorised" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const parentId = String(body?.parentId ?? "");
  const studentId = String(body?.studentId ?? "");
  const rawSubject = String(body?.subject ?? "").toLowerCase();

  if (!parentId || !studentId || !rawSubject) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }
  // Only allow the parent themselves to trigger this. Belt-and-braces
  // — the endpoint doesn't leak anything sensitive, but there's no
  // reason to let random sessions ping strangers' inboxes.
  if (sessionUserId !== parentId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const subjectLabel = SUBJECT_LABEL[rawSubject];
  if (!subjectLabel) {
    return NextResponse.json({ error: "unknown subject" }, { status: 400 });
  }

  const parent = await prisma.user.findUnique({
    where: { id: parentId },
    select: { email: true, displayName: true, name: true },
  });
  const child = await prisma.user.findUnique({
    where: { id: studentId },
    select: {
      displayName: true,
      name: true,
      // studentLinks are ParentStudent rows keyed on this user as the
      // student. Filter to just the caller's parentId — an empty
      // list means the student isn't linked to this parent, so we
      // refuse to send an email about them.
      studentLinks: { where: { parentId }, select: { parentId: true } },
    },
  });
  if (!parent || !child) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!parent.email) return NextResponse.json({ error: "parent has no email" }, { status: 400 });
  if (child.studentLinks.length === 0) {
    return NextResponse.json({ error: "not your student" }, { status: 403 });
  }

  const parentDisplayName = (parent.displayName ?? parent.name ?? "there").split(/\s+/)[0];
  const childDisplayName = (child.displayName ?? child.name ?? "your child");
  const childUsername = child.name;

  // Fire without awaiting so the client sees a fast 202. The sender
  // logs failures and (via tryOrQueue) will retry a transient SendGrid
  // hiccup on its own.
  void sendQuizAssignedEmail({
    parentEmail: parent.email,
    parentDisplayName,
    childDisplayName,
    childUsername,
    subject: subjectLabel,
    childHomepageUrl: `${APP_URL}/home/${studentId}`,
    parentHomepageUrl: `${APP_URL}/home/${parentId}`,
  });

  return NextResponse.json({ queued: true }, { status: 202 });
}
