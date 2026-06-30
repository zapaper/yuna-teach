import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { requireAccessToPaper } from "@/lib/auth-guard";

// GET /api/exam/[id]/question-crop?questionId=<id>
//
// Returns a JPEG that matches the exact region the marker cropped
// when sending the question's writing area to Gemini. Built so the
// review UI can render per-blank thumbnails alongside the AI's
// detected/expected answers — lets the parent see what the AI
// actually saw when they suspect a wrong detection (especially in
// passage-style sections like Editing / Comp Cloze / Grammar Cloze
// where many questions share or overlap y-bands).
//
// Crop math mirrors the marker's writtenCrop path in marking.ts:
//   - read submissions/<paperId>/page_<submissionIdx>.jpg
//   - submissionIdx = position of question.pageIndex in non-hidden
//     pages (cover/skip/answer pages dropped via metadata)
//   - crop by question.yStartPct/yEndPct (same percentages stored
//     on the question row by extraction)
//   - if xStartPct/xEndPct set, crop horizontally too — falls back
//     to full width when missing (correct for almost all sections;
//     only Editing/Comp Cloze with same-line blanks need x)

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const SUBMISSIONS_DIR = path.join(VOLUME_PATH, "submissions");

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: paperId } = await params;
  const questionId = request.nextUrl.searchParams.get("questionId");
  if (!questionId) {
    return NextResponse.json({ error: "questionId required" }, { status: 400 });
  }

  // Auth + ownership check in one helper — mirrors the gate used by
  // the existing /api/exam/[id]/* read routes.
  const guard = await requireAccessToPaper(paperId);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const paper = await prisma.examPaper.findUnique({
    where: { id: paperId },
    select: { id: true, pageCount: true, sourceExamId: true, metadata: true },
  });
  if (!paper) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const question = await prisma.examQuestion.findUnique({
    where: { id: questionId },
    select: {
      examPaperId: true,
      pageIndex: true,
      yStartPct: true,
      yEndPct: true,
      xStartPct: true,
      xEndPct: true,
      printableBounds: true,
    },
  });
  if (!question) return NextResponse.json({ error: "Question not found" }, { status: 404 });
  if (question.examPaperId !== paperId) {
    return NextResponse.json({ error: "Question does not belong to paper" }, { status: 400 });
  }
  // In-app quizzes (paperType=quiz with handwriting OEQs) have no y-bounds
  // because there's no scanned PDF — the kid drew directly on a per-OEQ
  // canvas. The paper's metadata.oeqPageMap maps each OEQ questionId to
  // the submission page that holds that canvas; serve the full page.
  if (question.yStartPct == null || question.yEndPct == null) {
    const meta = paper.metadata as { oeqPageMap?: Record<string, number> } | null;
    const oeqIdx = meta?.oeqPageMap?.[questionId];
    if (typeof oeqIdx === "number") {
      const pagePath = path.join(SUBMISSIONS_DIR, paperId, `page_${oeqIdx}.jpg`);
      try {
        const buf = await fs.readFile(pagePath);
        return new NextResponse(new Uint8Array(buf), {
          status: 200,
          headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
        });
      } catch {
        return NextResponse.json({ error: "Scanned page file not found on disk (canvas may have been blank — nothing was saved)" }, { status: 404 });
      }
    }
    return NextResponse.json({ error: "Question has no y-bounds" }, { status: 400 });
  }

  // Resolve metadata for hidden-page calc (inherit from master if clone).
  let meta = paper.metadata as { answerPages?: number[]; skipPages?: number[] } | null;
  if ((!meta?.answerPages && !meta?.skipPages) && paper.sourceExamId) {
    const src = await prisma.examPaper.findUnique({
      where: { id: paper.sourceExamId },
      select: { metadata: true },
    });
    meta = src?.metadata as { answerPages?: number[]; skipPages?: number[] } | null;
  }
  const hiddenSet = new Set<number>([
    ...((meta?.answerPages ?? []) as number[]).map(p => p - 1),
    ...((meta?.skipPages ?? []) as number[]).map(p => p - 1),
  ]);

  // submissionIdx = position of question.pageIndex among non-hidden
  // pages. Prefer printableBounds.pageIndex when present — that's
  // the exact value the marker uses.
  let submissionIdx = -1;
  const bounds = question.printableBounds as { pageIndex?: number } | null;
  if (bounds && typeof bounds.pageIndex === "number") {
    submissionIdx = bounds.pageIndex;
  } else {
    let counter = 0;
    for (let i = 0; i < (paper.pageCount ?? 0); i++) {
      if (hiddenSet.has(i)) continue;
      if (i === question.pageIndex) { submissionIdx = counter; break; }
      counter++;
    }
  }
  if (submissionIdx < 0) {
    return NextResponse.json({ error: "Could not resolve submission page" }, { status: 404 });
  }

  // Read the scanned page from disk.
  const pagePath = path.join(SUBMISSIONS_DIR, paperId, `page_${submissionIdx}.jpg`);
  let pageBuffer: Buffer;
  try {
    pageBuffer = await fs.readFile(pagePath);
  } catch {
    return NextResponse.json({ error: "Scanned page file not found on disk" }, { status: 404 });
  }

  // Crop using sharp. Pad bounds slightly so the crop doesn't shave
  // off ink that brushes the boundary — same generosity the marker
  // uses (1% top, 6% bottom in marking.ts:cropPageRegion). For the
  // debug view we go a bit wider so the parent has context around
  // the blank.
  const sharp = (await import("sharp")).default;
  const meta2 = await sharp(pageBuffer).metadata();
  const width = meta2.width ?? 1;
  const height = meta2.height ?? 1;
  const padY = height * 0.02;
  const top = Math.max(0, Math.floor((question.yStartPct / 100) * height - padY));
  const bottom = Math.min(height, Math.ceil((question.yEndPct / 100) * height + padY));
  const cropH = Math.max(1, bottom - top);

  let left = 0;
  let cropW = width;
  if (question.xStartPct != null && question.xEndPct != null && question.xEndPct > question.xStartPct) {
    const padX = width * 0.01;
    left = Math.max(0, Math.floor((question.xStartPct / 100) * width - padX));
    const right = Math.min(width, Math.ceil((question.xEndPct / 100) * width + padX));
    cropW = Math.max(1, right - left);
  }

  const cropped = await sharp(pageBuffer)
    .extract({ left, top, width: cropW, height: cropH })
    .jpeg({ quality: 85 })
    .toBuffer();

  return new NextResponse(new Uint8Array(cropped), {
    status: 200,
    headers: {
      "Content-Type": "image/jpeg",
      // No browser cache — bounds get backfilled/re-extracted during
      // marking-quality investigation and the same URL has to render the
      // new slice immediately, not the stale one from 60s ago.
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
