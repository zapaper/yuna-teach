import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function POST(request: NextRequest) {
  const { userId, message } = await request.json();
  if (!message?.trim()) {
    return NextResponse.json({ error: "Message is required" }, { status: 400 });
  }

  // Look up user name and email
  let userName: string | null = null;
  let userEmail: string | null = null;
  if (userId) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    userName = user?.name ?? null;
    userEmail = user?.email ?? null;
  }

  await prisma.feedback.create({
    data: {
      userId: userId || null,
      userName,
      userEmail,
      message: message.trim(),
    },
  });

  return NextResponse.json({ ok: true });
}
