import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAccessToStudent } from "@/lib/auth-guard";

// POST /api/tutor/[studentId]/diagrams
// Body: { questionIds: string[] }
// Returns: { diagrams: { [id]: { diagramImageData, imageData, optionImages } } }
//
// Lazy-loaded image hydration for Lumi mistake / concept example cards.
// loadTutorData no longer hydrates these base64 blobs at base-load time
// (that round trip added 100-300ms and 400KB-1MB of wire to every Lumi
// visit), so the client requests them here when a parent expands a
// card. Access is gated through the same requireAccessToStudent guard
// as the main /api/tutor/[studentId] route.
//
// IDs are bounded at 50 to cap the worst case at the typical ~12-id
// payload plus generous headroom.

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ studentId: string }> },
) {
  const { studentId } = await params;
  const auth = await requireAccessToStudent(studentId);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let body: { questionIds?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const rawIds = Array.isArray(body.questionIds) ? body.questionIds : [];
  const ids = rawIds.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 50);
  if (ids.length === 0) return NextResponse.json({ diagrams: {} });

  const rows = await prisma.examQuestion.findMany({
    where: { id: { in: ids } },
    select: { id: true, diagramImageData: true, imageData: true, transcribedOptionImages: true },
  });

  const diagrams: Record<string, { diagramImageData: string | null; imageData: string | null; optionImages: string[] | null }> = {};
  for (const r of rows) {
    const optImgs = r.transcribedOptionImages;
    const validOptImgs = Array.isArray(optImgs) && optImgs.length > 0 && optImgs.some(o => typeof o === "string" && o.length > 0)
      ? (optImgs as string[])
      : null;
    diagrams[r.id] = {
      diagramImageData: r.diagramImageData,
      imageData: r.imageData,
      optionImages: validOptImgs,
    };
  }
  return NextResponse.json({ diagrams });
}
