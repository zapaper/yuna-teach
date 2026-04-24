import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

type QuestionUpdate = {
  id: string;
  imageData?: string;              // full-width yStart/yEnd crop
  diagramImageData?: string | null; // diagramBounds crop (or null to clear)
};

// POST /api/exam/:id/recrop-questions — batch-update question image crops
// after an admin re-renders from the current (possibly baked) PDF on the
// client. Admin-only.
// Body: { questions: [{ id, imageData?, diagramImageData? }] }
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const raw = body.questions;
  if (!Array.isArray(raw)) {
    return NextResponse.json({ error: "questions array required" }, { status: 400 });
  }

  // Limit payload to questions that actually belong to this paper.
  const paperQIds = new Set(
    (await prisma.examQuestion.findMany({
      where: { examPaperId: id },
      select: { id: true },
    })).map(q => q.id)
  );

  const updates: QuestionUpdate[] = raw
    .filter((q): q is QuestionUpdate => !!q && typeof q === "object" && typeof (q as QuestionUpdate).id === "string")
    .filter(q => paperQIds.has(q.id));

  let updated = 0;
  for (const q of updates) {
    const data: { imageData?: string; diagramImageData?: string | null } = {};
    if (typeof q.imageData === "string" && q.imageData.startsWith("data:image")) {
      data.imageData = q.imageData;
    }
    if (q.diagramImageData === null) data.diagramImageData = null;
    else if (typeof q.diagramImageData === "string" && q.diagramImageData.startsWith("data:image")) {
      data.diagramImageData = q.diagramImageData;
    }
    if (Object.keys(data).length === 0) continue;
    await prisma.examQuestion.update({ where: { id: q.id }, data });
    updated += 1;
  }

  return NextResponse.json({ ok: true, updated });
}
