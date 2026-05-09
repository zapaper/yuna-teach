import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/session";

// Change-password endpoint. Auth comes from the signed session
// cookie (yuna_session) — never trust a userId in the body. Caller
// must supply the current password to prove they're not riding a
// stolen session, plus the new password.
//
// Plain-text password storage is the existing convention in this
// codebase (see /api/auth route.ts) — we don't introduce hashing
// in this change because the rest of the system would need a paired
// migration. When passwords get hashed, the comparison and write
// here are the only places to touch.
export async function POST(request: NextRequest) {
  const sessionUserId = await getSessionUserId();
  if (!sessionUserId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const { currentPassword, newPassword } = body as {
    currentPassword?: string;
    newPassword?: string;
  };

  if (!currentPassword || !newPassword) {
    return NextResponse.json(
      { error: "Both current and new password are required" },
      { status: 400 },
    );
  }
  if (newPassword.length < 4) {
    return NextResponse.json(
      { error: "New password must be at least 4 characters" },
      { status: 400 },
    );
  }
  if (newPassword === currentPassword) {
    return NextResponse.json(
      { error: "New password must be different" },
      { status: 400 },
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: sessionUserId },
    select: { password: true },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  if (user.password !== currentPassword) {
    return NextResponse.json({ error: "Current password is wrong" }, { status: 401 });
  }

  await prisma.user.update({
    where: { id: sessionUserId },
    data: { password: newPassword },
  });

  return NextResponse.json({ ok: true });
}
