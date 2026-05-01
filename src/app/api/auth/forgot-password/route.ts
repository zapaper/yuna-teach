import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import sgMail from "@sendgrid/mail";

const FROM_ADDRESS = process.env.SENDGRID_FROM_ADDRESS ?? "hello@markforyou.com";

export async function POST(request: NextRequest) {
  const { email } = await request.json();
  console.log(`[forgot-password] request received for email=${email ?? "(none)"}`);
  if (!email) return NextResponse.json({ error: "Email is required" }, { status: 400 });

  const user = await prisma.user.findFirst({
    where: { email: { equals: email.trim(), mode: "insensitive" } },
    select: { email: true, password: true, name: true, displayName: true },
  });

  if (!user) {
    console.warn(`[forgot-password] no user with email=${email.trim()}`);
    return NextResponse.json({ sent: true });
  }
  if (!user.password) {
    console.warn(`[forgot-password] user ${user.email} has no password set`);
    return NextResponse.json({ sent: true });
  }

  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    console.warn(`[forgot-password] SENDGRID_API_KEY not set — password for ${user.email}: ${user.password}`);
    return NextResponse.json({ sent: true });
  }
  console.log(`[forgot-password] preparing to send to=${user.email} from=${FROM_ADDRESS}`);

  sgMail.setApiKey(apiKey);

  const greetingName = user.displayName ?? user.name ?? "there";
  const html = `<div style="font-family:sans-serif;max-width:440px;margin:0 auto;padding:24px">
    <h2 style="color:#001e40;margin-bottom:4px">MarkForYou.com</h2>
    <p style="color:#43474f">Hi ${greetingName},</p>
    <p style="color:#43474f">Here is your password as requested:</p>
    <div style="font-size:20px;font-weight:bold;text-align:center;padding:16px 24px;background:#eff4ff;border-radius:12px;color:#001e40;letter-spacing:2px;margin:16px 0">${user.password}</div>
    <p style="color:#43474f">You can log in at <a href="https://markforyou.com/login" style="color:#006c49">markforyou.com/login</a>.</p>
    <p style="color:#94a3b8;font-size:12px;margin-top:24px">If you did not request this, please ignore this email.</p>
  </div>`;

  try {
    const [resp] = await sgMail.send({
      to: user.email,
      from: { email: FROM_ADDRESS, name: "MarkForYou" },
      subject: "Your MarkForYou password",
      html,
      // Same reasoning as diagnostic.ts: click tracking rewrites links
      // through urlNNNN.markforyou.com which we haven't CNAME'd, so the
      // login link would 404.
      trackingSettings: {
        clickTracking: { enable: false, enableText: false },
        openTracking: { enable: false },
        subscriptionTracking: { enable: false },
      },
    });
    console.log(`[forgot-password] email sent to=${user.email} status=${resp.statusCode} messageId=${resp.headers?.["x-message-id"] ?? "n/a"}`);
  } catch (err) {
    const errAny = err as { response?: { body?: unknown; statusCode?: number } } & Error;
    console.error(
      `[forgot-password] sgMail.send failed to=${user.email} from=${FROM_ADDRESS} status=${errAny.response?.statusCode ?? "?"} body=${JSON.stringify(errAny.response?.body)} msg=${errAny.message}`,
    );
  }

  return NextResponse.json({ sent: true });
}
