import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import crypto from "crypto";

function generateCode(): string {
  return crypto.randomBytes(3).toString("hex").toUpperCase(); // 6-char hex
}

// POST — generate a new invite code for a user
export async function POST(request: NextRequest) {
  const { userId } = await request.json();
  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  // Delete any existing codes for this user
  await prisma.inviteCode.deleteMany({ where: { userId } });

  const code = generateCode();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

  await prisma.inviteCode.create({
    data: { code, userId, expiresAt },
  });

  return NextResponse.json({ code, expiresAt: expiresAt.toISOString() });
}

// GET — get active invite code for a user
export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("userId");
  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  const invite = await prisma.inviteCode.findFirst({
    where: { userId, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });

  if (!invite) {
    return NextResponse.json({ code: null });
  }

  return NextResponse.json({ code: invite.code, expiresAt: invite.expiresAt.toISOString() });
}
