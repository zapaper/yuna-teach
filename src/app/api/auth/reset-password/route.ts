import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// Reset password using the single-use token emailed by
// /api/auth/forgot-password. Token must be (a) not null, (b) match the
// user row's passwordResetToken, (c) not expired. On success, updates
// `password` and clears both reset fields atomically.
//
// Note: this DOES touch the password column on User, but doesn't
// change the storage format (still plaintext, matching how login
// currently compares it). Migrating to hashed passwords is a separate
// piece of work that needs the login/signup paths updated together.

export async function POST(request: NextRequest) {
  let token: string | undefined;
  let newPassword: string | undefined;
  try {
    const body = await request.json();
    token = body?.token;
    newPassword = body?.newPassword;
  } catch {
    return NextResponse.json({ error: "Token and new password are required" }, { status: 400 });
  }
  if (!token || typeof token !== "string") {
    return NextResponse.json({ error: "Reset token is required" }, { status: 400 });
  }
  if (!newPassword || typeof newPassword !== "string") {
    return NextResponse.json({ error: "New password is required" }, { status: 400 });
  }
  if (newPassword.length < 4) {
    // Mirror the existing signup min-length. Bump together if you
    // tighten signup.
    return NextResponse.json({ error: "Password must be at least 4 characters" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { passwordResetToken: token },
    select: { id: true, email: true, name: true, passwordResetExpires: true },
  });
  if (!user) {
    console.error(`[reset-password] no user for token=${token.slice(0, 8)}…`);
    return NextResponse.json({ error: "This reset link is invalid or has already been used" }, { status: 400 });
  }
  if (!user.passwordResetExpires || user.passwordResetExpires.getTime() < Date.now()) {
    console.error(`[reset-password] token expired for user=${user.email}`);
    // Clear the expired token so future requests get a cleaner 'invalid'.
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordResetToken: null, passwordResetExpires: null },
    });
    return NextResponse.json({ error: "This reset link has expired. Please request a new one." }, { status: 400 });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      password: newPassword,
      passwordResetToken: null,
      passwordResetExpires: null,
    },
  });
  console.error(`[reset-password] password updated for user=${user.email}`);
  // Return the identity (email preferred, fallback to username) so the
  // /reset-password client can pass it to /login and pre-fill the
  // identity field for the correct account. Prevents leftover state
  // from /login?next=/home/<other-user> pre-fills showing the wrong
  // username after the reset round-trip.
  return NextResponse.json({ ok: true, identity: user.email ?? user.name });
}
