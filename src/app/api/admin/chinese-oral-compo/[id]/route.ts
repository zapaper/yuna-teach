import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// GET /api/admin/chinese-oral-compo/[id]
//   Return one row including OCR text.
//
// DELETE /api/admin/chinese-oral-compo/[id]
//   Drop the row + unlink the PDF on disk.

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const row = await prisma.chineseSupplementaryPaper.findUnique({ where: { id } });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ row });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const row = await prisma.chineseSupplementaryPaper.findUnique({
    where: { id },
    select: { pdfPath: true },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.chineseSupplementaryPaper.delete({ where: { id } });
  if (row.pdfPath) {
    try { await fs.unlink(row.pdfPath); } catch { /* missing file = fine */ }
  }
  return NextResponse.json({ ok: true });
}
