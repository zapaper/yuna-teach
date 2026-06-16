import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// POST /api/exam/questions/[id]/reply
// Body: { message, awardCrystal?: boolean }
// Admin sends a reply to the user who flagged this question. When
// awardCrystal is true, also bumps the flagger's settings.bonusCrystals
// by 1 (the same currency the habitats page reads). The crystalAwarded
// flag on the question makes the credit idempotent: if admin re-sends
// the reply (or edits it), no second crystal is granted.
// Auth via session cookie.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { message, awardCrystal } = await request.json();

  if (!message?.trim()) {
    return NextResponse.json({ error: "Message required" }, { status: 400 });
  }

  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const question = await prisma.examQuestion.findUnique({
    where: { id },
    select: { flaggedByUserId: true, crystalAwarded: true },
  });
  if (!question) {
    return NextResponse.json({ error: "Question not found" }, { status: 404 });
  }

  const shouldCredit = !!awardCrystal && !question.crystalAwarded && !!question.flaggedByUserId;

  await prisma.$transaction(async (tx) => {
    await tx.examQuestion.update({
      where: { id },
      data: {
        adminReply: message.trim(),
        adminRepliedAt: new Date(),
        adminReplyRead: false,
        ...(shouldCredit ? { crystalAwarded: true } : {}),
      },
    });
    if (shouldCredit && question.flaggedByUserId) {
      const user = await tx.user.findUnique({
        where: { id: question.flaggedByUserId },
        select: { settings: true },
      });
      const settings = ((user?.settings ?? {}) as Record<string, unknown>);
      const bonus = (settings.bonusCrystals as number | undefined) ?? 0;
      const nextSettings = { ...settings, bonusCrystals: bonus + 1 };
      await tx.user.update({
        where: { id: question.flaggedByUserId },
        data: { settings: nextSettings as unknown as import("@prisma/client").Prisma.InputJsonValue },
      });
    }
  });

  return NextResponse.json({ ok: true, crystalAwarded: shouldCredit });
}
