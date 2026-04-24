import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// GET /api/exam/:id/annotations → { annotationsByPage } map.
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: { annotationsByPage: true },
  });
  if (!paper) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ annotationsByPage: paper.annotationsByPage ?? {} });
}

// PUT /api/exam/:id/annotations — overwrites the per-page annotation map.
// Admin-only. Body: { annotationsByPage: { "0": dataUrl, "1": dataUrl, ... } }
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const body = await request.json().catch(() => ({} as Record<string, unknown>));
  const raw = body.annotationsByPage;
  if (!raw || typeof raw !== "object") {
    return NextResponse.json({ error: "annotationsByPage object required" }, { status: 400 });
  }
  // Strip any non-string values just in case. Empty entries are pruned so
  // pages with no strokes don't bloat the JSON.
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && v.length > 0) cleaned[k] = v;
  }
  await prisma.examPaper.update({
    where: { id },
    data: { annotationsByPage: cleaned },
  });
  return NextResponse.json({ ok: true, pages: Object.keys(cleaned).length });
}
