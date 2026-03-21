import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/** POST: Send a 4-digit verification code to the user's email */
export async function POST(request: NextRequest) {
  const { userId } = await request.json();
  if (!userId) return NextResponse.json({ error: "Missing userId" }, { status: 400 });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  if (!user?.email) return NextResponse.json({ error: "No email on file" }, { status: 400 });
  if (user.emailVerified) return NextResponse.json({ error: "Already verified" }, { status: 400 });

  // Generate 4-digit code
  const code = String(Math.floor(1000 + Math.random() * 9000));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  // Delete old codes for this user
  await prisma.emailVerification.deleteMany({ where: { userId } });

  // Save new code
  await prisma.emailVerification.create({
    data: { userId, code, expiresAt },
  });

  // Send email via a simple fetch to a transactional email service
  // Using Brevo (Sendinblue) free tier — 300 emails/day
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
          sender: { name: "Mark for You", email: process.env.BREVO_SENDER_EMAIL || "noreply@markforyou.com" },
          to: [{ email: user.email }],
          subject: "Your verification code",
          htmlContent: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:20px">
            <h2 style="color:#334155">Verify your email</h2>
            <p style="color:#64748b">Your verification code is:</p>
            <div style="font-size:32px;font-weight:bold;letter-spacing:8px;text-align:center;padding:20px;background:#f1f5f9;border-radius:12px;color:#1e293b">${code}</div>
            <p style="color:#94a3b8;font-size:12px;margin-top:16px">This code expires in 10 minutes.</p>
          </div>`,
        }),
      });
    } catch (err) {
      console.error("[email-verify] Failed to send email:", err);
    }
  } else {
    // Dev fallback: log code to console
    console.log(`[email-verify] Code for ${user.email}: ${code}`);
  }

  return NextResponse.json({ sent: true, email: user.email.replace(/(.{2})(.*)(@.*)/, "$1***$3") });
}

/** PUT: Verify the code */
export async function PUT(request: NextRequest) {
  const { userId, code } = await request.json();
  if (!userId || !code) return NextResponse.json({ error: "Missing fields" }, { status: 400 });

  const verification = await prisma.emailVerification.findFirst({
    where: { userId, code: String(code) },
  });

  if (!verification) return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  if (verification.expiresAt < new Date()) {
    await prisma.emailVerification.delete({ where: { id: verification.id } });
    return NextResponse.json({ error: "Code expired" }, { status: 400 });
  }

  // Mark email as verified
  await prisma.user.update({
    where: { id: userId },
    data: { emailVerified: true },
  });

  // Clean up
  await prisma.emailVerification.deleteMany({ where: { userId } });

  return NextResponse.json({ verified: true });
}
