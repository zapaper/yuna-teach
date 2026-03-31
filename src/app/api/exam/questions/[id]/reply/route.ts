import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// POST /api/exam/questions/[id]/reply
// Body: { adminUserId, message }
// Admin sends a reply to the user who flagged this question
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { adminUserId, message } = await request.json();

  if (!message?.trim()) {
    return NextResponse.json({ error: "Message required" }, { status: 400 });
  }

  const admin = await prisma.user.findUnique({ where: { id: adminUserId }, select: { name: true } });
  if (admin?.name?.toLowerCase() !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await prisma.examQuestion.update({
    where: { id },
    data: {
      adminReply: message.trim(),
      adminRepliedAt: new Date(),
      adminReplyRead: false,
    },
  });

  return NextResponse.json({ ok: true });
}
