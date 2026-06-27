import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// POST /api/feedback/[id]/reply
// Body: { message }
// Admin replies to a Feedback submission. Mirrors the
// /api/exam/questions/[id]/reply pattern: writes adminReply +
// adminRepliedAt and resets adminReplyRead=false so the user sees
// the reply as unread in their notifications surface.
//
// No crystal-award branch here (feedback isn't tied to a flag-driven
// reward loop the way ExamQuestion is).
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

  const feedback = await prisma.feedback.findUnique({
    where: { id },
    select: { id: true, userId: true },
  });
  if (!feedback) {
    return NextResponse.json({ error: "Feedback not found" }, { status: 404 });
  }

  await prisma.feedback.update({
    where: { id },
    data: {
      adminReply: message.trim(),
      adminRepliedAt: new Date(),
      adminReplyRead: false,
    },
  });

  return NextResponse.json({ ok: true });
}
