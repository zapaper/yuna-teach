import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function POST(request: NextRequest) {
  const { userId, message } = await request.json();
  if (!message?.trim()) {
    return NextResponse.json({ error: "Message is required" }, { status: 400 });
  }

  await prisma.feedback.create({
    data: {
      userId: userId || null,
      message: message.trim(),
    },
  });

  return NextResponse.json({ ok: true });
}
