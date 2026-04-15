import { NextRequest, NextResponse } from "next/server";
import { auditPaper } from "@/lib/audit-qa";
import { prisma } from "@/lib/db";

// POST /api/exam/[id]/audit-qa — run AI audit on the paper's Q&A, store flags in metadata
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const flags = await auditPaper(id);
    return NextResponse.json({ success: true, flaggedCount: Object.keys(flags).length, flags });
  } catch (err) {
    console.error(`[audit-qa API] ${id} failed:`, err);
    return NextResponse.json({ error: "Audit failed" }, { status: 500 });
  }
}

// DELETE /api/exam/[id]/audit-qa — clear audit flags (called after save clean extract)
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const paper = await prisma.examPaper.findUnique({ where: { id }, select: { metadata: true } });
  if (!paper) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = (paper.metadata ?? {}) as any;
  if (meta.auditFlags) delete meta.auditFlags;
  await prisma.examPaper.update({ where: { id }, data: { metadata: meta } });
  return NextResponse.json({ success: true });
}
