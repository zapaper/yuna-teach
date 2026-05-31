// POST /api/exam/[id]/set-chinese-passage-image
//
// Admin tool for Chinese 阅读理解 sections whose passage is actually
// a printed image (a photo + caption layout, a comic, an
// infographic, etc.) — anything where the OCR text doesn't capture
// what the student needs to see.
//
// The admin picks one or more page indices on the source paper. We
// stamp metadata.chineseSections[idx].passage as the same
// `[VISUAL_PAGES:paperId:p1,p2]` sentinel the English Visual Text
// MCQ flow uses; ChineseQuizSection's render path already detects
// that prefix and renders the page images via VisualTextImages.
//
// Body:
//   { sectionLabel: string;
//     pageIndices: number[] | null;  // null reverts to OCR text
//   }
//
// Returns:
//   { passage: string | undefined }
//     — the new passage value stamped on the section (or undefined
//       when reverting and no OCR text is available).
//
// Auth: admin-only via isSessionAdmin().

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";
import { buildChineseSections, type OcrEntry } from "@/lib/extraction";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  let body: { sectionLabel?: unknown; pageIndices?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad JSON" }, { status: 400 });
  }
  const sectionLabel = typeof body.sectionLabel === "string" ? body.sectionLabel : "";
  const pageIndicesRaw = body.pageIndices;
  if (!sectionLabel) {
    return NextResponse.json({ error: "sectionLabel required" }, { status: 400 });
  }

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: { id: true, metadata: true, subject: true },
  });
  if (!paper) return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  if (!(paper.subject ?? "").toLowerCase().includes("chinese")) {
    return NextResponse.json({ error: "Endpoint only applies to Chinese papers" }, { status: 400 });
  }

  const meta = (paper.metadata ?? {}) as Record<string, unknown>;
  const sections = (meta.chineseSections as Array<{ label: string; startIndex: number; endIndex: number; passage?: string }> | undefined) ?? [];
  const idx = sections.findIndex(s => s.label === sectionLabel);
  if (idx < 0) {
    return NextResponse.json({ error: `Section "${sectionLabel}" not found on this paper` }, { status: 404 });
  }

  // null pageIndices = revert to OCR text. Rebuild chineseSections
  // from scratch via the same extraction-time builder so we pick up
  // any existing sectionOcrTexts entry for this section without
  // hand-rolling the merge.
  if (pageIndicesRaw === null || pageIndicesRaw === undefined) {
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: id },
      orderBy: { orderIndex: "asc" },
      select: { pageIndex: true, syllabusTopic: true },
    });
    const ocrTexts = (meta.sectionOcrTexts ?? {}) as Record<string, OcrEntry>;
    const rebuilt = buildChineseSections(qs, ocrTexts);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await prisma.examPaper.update({
      where: { id },
      data: { metadata: { ...meta, chineseSections: rebuilt } as any },
    });
    const after = rebuilt.find(s => s.label === sectionLabel);
    return NextResponse.json({ passage: after?.passage });
  }

  if (!Array.isArray(pageIndicesRaw) || pageIndicesRaw.length === 0 || pageIndicesRaw.some(p => typeof p !== "number" || !Number.isInteger(p) || p < 0)) {
    return NextResponse.json({ error: "pageIndices must be a non-empty array of non-negative integers, or null to revert" }, { status: 400 });
  }
  const pageIndices = pageIndicesRaw as number[];

  // Stamp the VISUAL_PAGES sentinel — ChineseQuizSection /
  // VisualTextImages will resolve it client-side. Format matches the
  // English Visual Text MCQ extractor output for consistency.
  const sentinel = `[VISUAL_PAGES:${paper.id}:${pageIndices.join(",")}]`;
  const updated = [...sections];
  updated[idx] = { ...updated[idx], passage: sentinel };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await prisma.examPaper.update({
    where: { id },
    data: { metadata: { ...meta, chineseSections: updated } as any },
  });
  return NextResponse.json({ passage: sentinel });
}
