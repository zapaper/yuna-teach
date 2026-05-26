import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";
import {
  autoCropListeningQuestions,
  ocrPaperSection,
  extractListeningStructureFromText,
} from "@/lib/english-supplementary";

// POST /api/admin/english-oral-compo/[id]/recrop-listening
//
// One-click re-extract of Paper 3 (Listening):
//   1. Re-crops every MCQ on every paper3 page as a single image
//      (stem + 3 picture options together). Files: <year>_listening_q<N>.jpg.
//   2. Re-OCRs the paper3 pages.
//   3. Re-runs the structured extractor to get the 7 text passages
//      (the read-aloud dialogues / monologues).
//   4. Replaces listeningMcqs with stub entries (one per cropped Q,
//      no option text — display is image-only by request).
//   5. Replaces listeningTexts with the freshly extracted passages.
//
// "Don't extract text for the MCQs, but DO extract text for the
// passages" — per admin direction. Use this when the listening
// section needs to be redone wholesale.

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const STORAGE_DIR = path.join(VOLUME_PATH, "english-supplementary");

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const row = await prisma.englishSupplementaryPaper.findUnique({
    where: { id },
    select: { id: true, year: true, pdfPath: true, paper3Pages: true, listeningMcqs: true },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!row.pdfPath) return NextResponse.json({ error: "Source PDF missing" }, { status: 404 });
  const paper3Pages = (row.paper3Pages as number[] | null) ?? [];
  if (paper3Pages.length === 0) {
    return NextResponse.json({ error: "No paper3 pages stored. Re-extract Paper 3 section first to set the pages." }, { status: 400 });
  }

  try {
    const pdfBuffer = await fs.readFile(row.pdfPath);

    // (1) Re-crop every MCQ on every paper3 page.
    const cropResult = await autoCropListeningQuestions(pdfBuffer, paper3Pages, STORAGE_DIR, row.year);

    // (2) + (3) OCR + extract texts.
    const paper3Text = await ocrPaperSection(pdfBuffer, paper3Pages, "Paper 3 Listening");
    const struct = await extractListeningStructureFromText(pdfBuffer, paper3Pages, paper3Text);

    // (4) Build stub listeningMcqs from the cropped question numbers.
    // Inherit textNum mapping from the structured texts when possible:
    // if listeningTexts entry T has questionNumbers including N, then
    // stub Q N gets textNum = T.
    const textNumByQ = new Map<number, number>();
    for (const t of struct.listeningTexts) {
      for (const qn of t.questionNumbers ?? []) textNumByQ.set(qn, t.textNum);
    }
    const stubMcqs = cropResult.questionNumbers.map(n => ({
      num: n,
      text: "",
      options: [],
      isImageOptions: true,
      textNum: textNumByQ.get(n) ?? null,
    }));

    // (5) Update DB. Keep paper3Text fresh too so a future re-run
    // doesn't OCR again unnecessarily.
    await prisma.englishSupplementaryPaper.update({
      where: { id },
      data: {
        paper3Text: paper3Text || null,
        listeningMcqs: stubMcqs.length ? stubMcqs : undefined,
        listeningTexts: struct.listeningTexts.length ? struct.listeningTexts : undefined,
      },
    });

    return NextResponse.json({
      ok: true,
      cropped: cropResult.savedCount,
      questionNumbers: cropResult.questionNumbers,
      textCount: struct.listeningTexts.length,
      errors: cropResult.errors,
    });
  } catch (err) {
    console.error(`[english-oral-compo] recrop-listening for ${row.year} failed:`, err);
    return NextResponse.json({
      error: "Re-extract failed",
      details: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}
