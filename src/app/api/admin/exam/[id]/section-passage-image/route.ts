// Set or clear metadata.chineseSections[i].passageImageData for a
// specific 阅读理解 section. The cropped image (with charts / posters
// / infographics) replaces the OCR'd passage text in the edit view
// and in the quiz / review renderers.
//
// Body: { sectionLabel: string, imageBase64: string | null }
//   - imageBase64 = data URL (e.g. "data:image/jpeg;base64,...") → set
//   - imageBase64 = null or "" → clear
//
// Surgical update: rebuild ONLY the matching section's entry; every
// other chineseSections entry is left exactly as-is. Same pattern as
// the reextract-passage route to avoid the "borrow previous comp
// passage" chain corruption observed earlier.
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/auth-guard";

type ChineseSec = { label: string; startIndex: number; endIndex: number; passage?: string; passageImageData?: string };

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { id } = await params;
  const { sectionLabel, imageBase64 } = (await request.json()) as {
    sectionLabel?: string;
    imageBase64?: string | null;
  };
  if (!sectionLabel) {
    return NextResponse.json({ error: "sectionLabel required" }, { status: 400 });
  }

  const paper = await prisma.examPaper.findUnique({ where: { id }, select: { metadata: true } });
  if (!paper) return NextResponse.json({ error: "Paper not found" }, { status: 404 });

  const meta = (paper.metadata ?? {}) as Record<string, unknown>;
  const sections = (meta.chineseSections ?? []) as ChineseSec[];
  if (!Array.isArray(sections) || sections.length === 0) {
    return NextResponse.json({ error: "Paper has no chineseSections metadata" }, { status: 400 });
  }

  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  const targetNorm = norm(sectionLabel);
  let matched = false;
  const updated = sections.map(sec => {
    if (norm(sec.label) !== targetNorm) return sec;
    matched = true;
    if (imageBase64) {
      // Basic sanity: must be a data URL prefix to avoid bare base64
      // confusing the renderer.
      if (!imageBase64.startsWith("data:image/")) {
        throw new Error("imageBase64 must be a data URL");
      }
      return { ...sec, passageImageData: imageBase64 };
    }
    // Clear: drop the field entirely so the OCR text panel returns.
    const { passageImageData: _ignored, ...rest } = sec as ChineseSec & Record<string, unknown>;
    void _ignored;
    return rest as ChineseSec;
  });

  if (!matched) {
    return NextResponse.json({ error: `No chineseSections entry matches label "${sectionLabel}"` }, { status: 404 });
  }

  await prisma.examPaper.update({
    where: { id },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { metadata: { ...meta, chineseSections: updated } as any },
  });

  return NextResponse.json({ ok: true, hasImage: !!imageBase64 });
}
