// GET /api/email-prefs/footer?email=<...>&category=<marketing|progress|features>
//
// Hands the markforyou-mailer a ready-to-paste unsubscribe footer
// snippet for a given recipient. Resolves the email to a userId,
// signs the unsubscribe token, and returns both the bare URL and a
// styled HTML block (small grey footer, same shape as our own
// senders use).
//
// Bearer NURTURE_API_TOKEN auth — same as /api/admin/email-events
// and /api/email-prefs/check.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  makeUnsubscribeToken,
  renderUnsubscribeFooter,
  type EmailCategory,
} from "@/lib/email-prefs";

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
  const category = (request.nextUrl.searchParams.get("category") ?? "marketing") as EmailCategory;
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });
  if (!VALID_CATEGORIES.has(category)) {
    return NextResponse.json({ error: "category must be one of: marketing, progress, features" }, { status: 400 });
  }

  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true },
  });
  if (!user) {
    // Unknown email — return nothing so the mailer simply omits the
    // footer for that send (CAN-SPAM still requires an opt-out for
    // marketing; the mailer should fall back to its own static
    // footer in that case).
    return NextResponse.json({ token: null, url: null, html: null, reason: "unknown-email" });
  }
  const token = makeUnsubscribeToken(user.id);
  const baseUrl = process.env.PUBLIC_APP_URL ?? "https://www.markforyou.com";
  const url = `${baseUrl.replace(/\/$/, "")}/unsubscribe?token=${token}`;
  const html = renderUnsubscribeFooter(user.id, category, baseUrl);
  return NextResponse.json({ token, url, html });
}
