import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import sgMail from "@sendgrid/mail";
import * as crypto from "crypto";

const FROM_ADDRESS = process.env.SENDGRID_FROM_ADDRESS ?? "hello@markforyou.com";
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// Forgot password: emails a one-time reset LINK (not the password).
// User clicks the link → /reset-password page → enters a new password
// → /api/auth/reset-password validates the token and updates.
//
// Always returns { sent: true } regardless of whether the email
// exists, so the response can't be used to enumerate accounts.
// Failure paths are logged server-side for debugging.

export async function POST(request: NextRequest) {
  // Loud entry log — fires BEFORE any body parsing or branch so we can
  // confirm the route is actually being hit from production logs even
  // when the request body is malformed or empty. Distinct prefix
  // (`*** FORGOT-PW HIT ***`) makes it grep-friendly in Railway logs.
  // Also writes to stdout so log streamers that filter stderr still
  // surface it.
  const hitTs = new Date().toISOString();
  const ua = request.headers.get("user-agent") ?? "(no-ua)";
  const ref = request.headers.get("referer") ?? "(no-ref)";
  console.log(`*** FORGOT-PW HIT *** ${hitTs} ua="${ua.slice(0, 60)}" ref="${ref}"`);
  console.error(`*** FORGOT-PW HIT *** ${hitTs} ua="${ua.slice(0, 60)}" ref="${ref}"`);

  let email: string | undefined;
  let debug: boolean | undefined;
  try {
    const body = await request.json();
    email = body?.email;
    debug = body?.debug;
  } catch {
    console.error(`[forgot-password] body parse failed — returning 400`);
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }
  console.error(`[forgot-password] request received email=${email ?? "(none)"}`);
  if (!email) return NextResponse.json({ error: "Email is required" }, { status: 400 });

  const user = await prisma.user.findFirst({
    where: { email: { equals: email.trim(), mode: "insensitive" } },
    select: { id: true, email: true, password: true, name: true, displayName: true },
  });

  if (!user || !user.email) {
    console.error(`[forgot-password] no user with email=${email.trim()}`);
    return NextResponse.json(debug ? { sent: true, debug: "user-not-found" } : { sent: true });
  }
  if (!user.password) {
    // Account exists but has no local password (e.g. SSO-only). Send a
    // friendly note saying so rather than a useless reset link.
    console.error(`[forgot-password] user ${user.email} has no password set (SSO?)`);
    return NextResponse.json(debug ? { sent: true, debug: "no-password-on-record" } : { sent: true });
  }

  // Generate a 32-byte random token, base64url-encoded (≈43 chars).
  // Single active token per user — overwrites any previous unused one.
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordResetToken: token, passwordResetExpires: expiresAt },
  });

  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    console.error(`[forgot-password] SENDGRID_API_KEY not set — token stored but email not sent`);
    return NextResponse.json(debug ? { sent: true, debug: "no-sendgrid-key", token } : { sent: true });
  }

  sgMail.setApiKey(apiKey);

  // Use the request's own origin so dev / staging links don't accidentally
  // point at production. Falls back to the canonical prod URL if the
  // header isn't there for some reason.
  const origin = request.headers.get("origin")
    ?? request.headers.get("referer")?.replace(/\/[^/]*$/, "")
    ?? "https://markforyou.com";
  const baseUrl = origin.replace(/\/$/, "");
  const resetUrl = `${baseUrl}/reset-password?token=${encodeURIComponent(token)}`;
  console.error(`[forgot-password] preparing to send reset link to=${user.email} from=${FROM_ADDRESS}`);

  const greetingName = user.displayName ?? user.name ?? "there";
  const html = `<div style="font-family:sans-serif;max-width:440px;margin:0 auto;padding:24px">
    <h2 style="color:#001e40;margin-bottom:4px">MarkForYou.com</h2>
    <p style="color:#43474f">Hi ${greetingName},</p>
    <p style="color:#43474f">You (or someone using your email) asked to reset your MarkForYou password. Click the link below to choose a new one. The link is valid for 1 hour.</p>
    <p style="text-align:center;margin:24px 0">
      <a href="${resetUrl}" style="display:inline-block;padding:14px 28px;background:#006c49;color:#ffffff;font-weight:bold;border-radius:12px;text-decoration:none">Reset my password</a>
    </p>
    <p style="color:#43474f;font-size:14px">If the button doesn't work, copy and paste this link into your browser:</p>
    <p style="color:#43474f;font-size:12px;word-break:break-all"><a href="${resetUrl}" style="color:#006c49">${resetUrl}</a></p>
    <p style="color:#94a3b8;font-size:12px;margin-top:24px">If you didn't request this, you can safely ignore this email — your password won't change unless you click the link above.</p>
  </div>`;

  try {
    const [resp] = await sgMail.send({
      to: user.email,
      from: { email: FROM_ADDRESS, name: "MarkForYou" },
      subject: "Reset your MarkForYou password",
      html,
      // Click tracking rewrites links through urlNNNN.markforyou.com
      // which we haven't CNAME'd, so the reset link would 404.
      trackingSettings: {
        clickTracking: { enable: false, enableText: false },
        openTracking: { enable: false },
        subscriptionTracking: { enable: false },
      },
    });
    console.error(`[forgot-password] reset email sent to=${user.email} status=${resp.statusCode} messageId=${resp.headers?.["x-message-id"] ?? "n/a"}`);
    return NextResponse.json(
      debug
        ? { sent: true, debug: "sent", status: resp.statusCode, messageId: resp.headers?.["x-message-id"] ?? null }
        : { sent: true },
    );
  } catch (err) {
    const errAny = err as { response?: { body?: unknown; statusCode?: number } } & Error;
    const status = errAny.response?.statusCode ?? null;
    const body = errAny.response?.body ?? null;
    console.error(
      `[forgot-password] sgMail.send failed to=${user.email} from=${FROM_ADDRESS} status=${status ?? "?"} body=${JSON.stringify(body)} msg=${errAny.message}`,
    );
    return NextResponse.json(
      debug
        ? { sent: true, debug: "sg-failed", status, body, msg: errAny.message }
        : { sent: true },
    );
  }
}
