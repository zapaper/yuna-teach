import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// POST { questionId } → mark syntheticSkipped=true so the question drops to the back of the batch queue.
export async function POST(request: NextRequest) {
  const { questionId } = await request.json();
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!questionId) return NextResponse.json({ error: "Missing questionId" }, { status: 400 });

  await prisma.examQuestion.update({
    where: { id: questionId },
    data: { syntheticSkipped: true },
  });
  return NextResponse.json({ ok: true });
}
