// GET /api/email-prefs/check?email=<...>&category=<marketing|progress|features>
//
// External mailer hook. Returns { allowed: boolean } so the
// markforyou-mailer can drop nurture sends to users who have
// unsubscribed from that category. Admin-token gated — same
// Bearer NURTURE_API_TOKEN we already use on /api/admin/email-events
// and /api/admin/parent-progress.
//
// Lookup is by email (not userId) because that's what the mailer
// holds in its own contact list. We resolve email → user → prefs.
// If the email doesn't match any user, default to allowed=true so
// a stale mailer contact doesn't silently fail.
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { canSendEmail, type EmailCategory } from "@/lib/email-prefs";

const VALID_CATEGORIES = new Set<EmailCategory>(["marketing", "progress", "features"]);

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization") ?? "";
  const bearerToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  const expectedToken = process.env.NURTURE_API_TOKEN ?? "";
  if (expectedToken === "" || bearerToken !== expectedToken) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const email = (request.nextUrl.searchParams.get("email") ?? "").trim().toLowerCase();
  const category = (request.nextUrl.searchParams.get("category") ?? "") as EmailCategory;
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });
  if (!VALID_CATEGORIES.has(category)) {
    return NextResponse.json({ error: "category must be one of: marketing, progress, features" }, { status: 400 });
  }

  // Case-insensitive email lookup via Postgres LOWER() — Prisma's
  // mode:"insensitive" doesn't index well; for one lookup the raw
  // path is fine.
  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true },
  });
  if (!user) {
    // Unknown email — default allow. The mailer's own dedupe / list
    // hygiene catches the stale contact case.
    return NextResponse.json({ allowed: true, reason: "unknown-email" });
  }
  const allowed = await canSendEmail(user.id, category);
  return NextResponse.json({ allowed });
}
