import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// POST /api/exam/questions/[id]/reply
// Body: { message }
// Admin sends a reply to the user who flagged this question. Auth via session cookie.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { message } = await request.json();

  if (!message?.trim()) {
    return NextResponse.json({ error: "Message required" }, { status: 400 });
  }

  if (!(await isSessionAdmin())) {
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
