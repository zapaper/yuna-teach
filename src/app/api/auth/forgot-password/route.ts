import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function POST(request: NextRequest) {
  const { email } = await request.json();
  if (!email) return NextResponse.json({ error: "Email is required" }, { status: 400 });

  const user = await prisma.user.findFirst({
    where: { email: { equals: email.trim(), mode: "insensitive" } },
    select: { email: true, password: true, name: true },
  });

  // Always return the same response to avoid email enumeration
  if (!user?.email || !user.password) {
    return NextResponse.json({ sent: true });
  }

  const apiKey = process.env.BREVO_API_KEY;
  if (apiKey) {
    try {
      await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sender: {
            name: "MarkForYou",
            email: process.env.BREVO_SENDER_EMAIL || "noreply@markforyou.com",
          },
          to: [{ email: user.email }],
          subject: "Your MarkForYou password",
          htmlContent: `<div style="font-family:sans-serif;max-width:440px;margin:0 auto;padding:24px">
            <h2 style="color:#001e40;margin-bottom:4px">MarkForYou.com</h2>
            <p style="color:#43474f">Hi ${user.name ?? "there"},</p>
            <p style="color:#43474f">Here is your password as requested:</p>
            <div style="font-size:20px;font-weight:bold;text-align:center;padding:16px 24px;background:#eff4ff;border-radius:12px;color:#001e40;letter-spacing:2px;margin:16px 0">${user.password}</div>
            <p style="color:#43474f">You can log in at <a href="https://markforyou.com/login" style="color:#006c49">markforyou.com/login</a>.</p>
            <p style="color:#94a3b8;font-size:12px;margin-top:24px">If you did not request this, please ignore this email.</p>
          </div>`,
        }),
      });
    } catch (err) {
      console.error("[forgot-password] Failed to send email:", err);
    }
  } else {
    console.log(`[forgot-password] Password for ${user.email}: ${user.password}`);
  }

  return NextResponse.json({ sent: true });
}
