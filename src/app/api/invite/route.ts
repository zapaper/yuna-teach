import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import crypto from "crypto";
import { resolveActor } from "@/lib/auth-guard";

function generateCode(): string {
  return crypto.randomBytes(3).toString("hex").toUpperCase(); // 6-char hex
}

// POST — generate a new invite code for the signed-in user (or
// admin acting on another user's behalf via { userId } in the body).
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const target = typeof body.userId === "string" ? body.userId : null;
  const auth = await resolveActor(target);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const userId = auth.userId;

  // Delete any existing codes for this user
  await prisma.inviteCode.deleteMany({ where: { userId } });

  const code = generateCode();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

  await prisma.inviteCode.create({
    data: { code, userId, expiresAt },
  });

  return NextResponse.json({ code, expiresAt: expiresAt.toISOString() });
}

// GET — get active invite code for the signed-in user (or admin
// view-as via ?userId=).
export async function GET(request: NextRequest) {
  const target = request.nextUrl.searchParams.get("userId");
  const auth = await resolveActor(target);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const userId = auth.userId;

  const invite = await prisma.inviteCode.findFirst({
    where: { userId, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });

  if (!invite) {
    return NextResponse.json({ code: null });
  }

  return NextResponse.json({ code: invite.code, expiresAt: invite.expiresAt.toISOString() });
}
