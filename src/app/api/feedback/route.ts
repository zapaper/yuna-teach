import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin, requireSession } from "@/lib/auth-guard";

export async function GET(_request: NextRequest) {
  const auth = await requireAdmin();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const items = await prisma.feedback.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      userId: true,
      userName: true,
      userEmail: true,
      message: true,
      createdAt: true,
      adminReply: true,
      adminRepliedAt: true,
      adminReplyRead: true,
    },
  });
  return NextResponse.json(items);
}

export async function POST(request: NextRequest) {
  const auth = await requireSession();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const userId = auth.userId;
  const { message } = await request.json();
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
