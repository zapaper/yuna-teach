import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

async function requireAdmin(userId: string | null) {
  if (!userId) return false;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  return u?.name?.toLowerCase() === "admin";
}

// POST { userId, questionId } → flags source ExamQuestion as syntheticGenerated=true so it drops out of the batch pool.
export async function POST(request: NextRequest) {
  const { userId, questionId } = await request.json();
  if (!(await requireAdmin(userId))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!questionId) return NextResponse.json({ error: "Missing questionId" }, { status: 400 });

  await prisma.examQuestion.update({
    where: { id: questionId },
    data: { syntheticGenerated: true },
  });

  return NextResponse.json({ ok: true });
}
