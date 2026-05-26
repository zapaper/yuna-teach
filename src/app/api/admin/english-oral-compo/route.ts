import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { isSessionAdmin, getSessionUserId } from "@/lib/session";
import { extractSupplementaryFromPdf, autoCropPictures, autoCropListeningQuestions } from "@/lib/english-supplementary";

// GET  /api/admin/english-oral-compo
//   List all extracted English supplementary papers.
// POST /api/admin/english-oral-compo
//   multipart form: { year, pdf }
//   Saves the PDF, fires the extraction in the background (Node
//   runtime keeps the promise alive). UI polls the list endpoint
//   for status updates: sectioning → ocr-paper1 → ocr-paper3 →
//   ocr-paper4 → ocr-*-answer → structuring → ready.

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const STORAGE_DIR = path.join(VOLUME_PATH, "english-supplementary");

export async function GET() {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const rows = await prisma.englishSupplementaryPaper.findMany({
    orderBy: { year: "desc" },
    select: {
      id: true, year: true, status: true, errorMessage: true, pageCount: true,
      paper1Pages: true, paper3Pages: true, paper4Pages: true,
      paper1AnswerPages: true, paper3AnswerPages: true, paper4AnswerPages: true,
      createdAt: true, updatedAt: true,
    },
  });
  return NextResponse.json({ rows });
}

export async function POST(request: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const userId = await getSessionUserId();

  const form = await request.formData();
  const year = (form.get("year") as string | null)?.trim();
  const pdf = form.get("pdf");
  if (!year || !/^\d{4}$/.test(year)) {
    return NextResponse.json({ error: "year must be a 4-digit string" }, { status: 400 });
  }
  if (!(pdf instanceof File)) {
    return NextResponse.json({ error: "pdf file required" }, { status: 400 });
  }

  await fs.mkdir(STORAGE_DIR, { recursive: true });
  const pdfPath = path.join(STORAGE_DIR, `${year}.pdf`);
  const pdfBuffer = Buffer.from(await pdf.arrayBuffer());
  await fs.writeFile(pdfPath, pdfBuffer);

  const row = await prisma.englishSupplementaryPaper.upsert({
    where: { year },
    update: {
      pdfPath, status: "sectioning", errorMessage: null,
      paper1Pages: undefined, paper3Pages: undefined, paper4Pages: undefined,
      paper1AnswerPages: undefined, paper3AnswerPages: undefined, paper4AnswerPages: undefined,
      paper1Text: null, paper3Text: null, paper4Text: null,
      paper1AnswerText: null, paper3AnswerText: null, paper4AnswerText: null,
      situationalWriting: undefined,
      continuousTheme: null, continuousPrompts: undefined,
      listeningMcqs: undefined, listeningTexts: undefined,
      oralDays: undefined,
      oralReadingPassage: null, oralStimulusPicture: undefined,  // legacy clears
      situationalModel: null, continuousModel: null,
      listeningAnswers: undefined, oralModelAnswers: undefined,
      uploadedBy: userId ?? undefined,
    },
    create: { year, pdfPath, status: "sectioning", uploadedBy: userId ?? undefined },
    select: { id: true },
  });

  // Fire-and-forget — Railway proxy times out long requests; background
  // promise keeps writing status to the DB and the UI polls.
  runExtractionInBackground(row.id, year, pdfBuffer);

  return NextResponse.json({
    row: { id: row.id, year, status: "sectioning" },
    note: "Extraction running in background — refresh the list to see status updates.",
  });
}

async function runExtractionInBackground(rowId: string, year: string, pdfBuffer: Buffer) {
  try {
    const extraction = await extractSupplementaryFromPdf(pdfBuffer, async (status) => {
      try { await prisma.englishSupplementaryPaper.update({ where: { id: rowId }, data: { status } }); }
      catch { /* non-fatal */ }
    });
    await prisma.englishSupplementaryPaper.update({
      where: { id: rowId },
      data: {
        pageCount: extraction.pageCount,
        paper1Pages: extraction.paper1Pages,
        paper3Pages: extraction.paper3Pages,
        paper4Pages: extraction.paper4Pages,
        paper1AnswerPages: extraction.paper1AnswerPages,
        paper3AnswerPages: extraction.paper3AnswerPages,
        paper4AnswerPages: extraction.paper4AnswerPages,
        paper1Text: extraction.paper1Text || null,
        paper3Text: extraction.paper3Text || null,
        paper4Text: extraction.paper4Text || null,
        paper1AnswerText: extraction.paper1AnswerText || null,
        paper3AnswerText: extraction.paper3AnswerText || null,
        paper4AnswerText: extraction.paper4AnswerText || null,
        situationalWriting: extraction.structured.situationalWriting ?? undefined,
        continuousTheme: extraction.structured.continuousTheme,
        continuousPrompts: extraction.structured.continuousPrompts.length ? extraction.structured.continuousPrompts : undefined,
        listeningMcqs: extraction.structured.listeningMcqs.length ? extraction.structured.listeningMcqs : undefined,
        listeningTexts: extraction.structured.listeningTexts.length ? extraction.structured.listeningTexts : undefined,
        oralDays: extraction.structured.oralDays.length ? extraction.structured.oralDays : undefined,
        situationalModel: extraction.structured.situationalModel,
        continuousModel: extraction.structured.continuousModel,
        listeningAnswers: extraction.structured.listeningAnswers.length ? extraction.structured.listeningAnswers : undefined,
        oralModelAnswers: extraction.structured.oralModelAnswers.length ? extraction.structured.oralModelAnswers : undefined,
        status: "cropping",
        errorMessage: null,
      },
    });

    // Auto-crop pictures (situational + 3 continuous + oral day1/day2 stimulus
    // rotated 90 CW + per-question listening MCQ blocks). Best-effort —
    // single picture failure won't abort the whole pipeline.
    try {
      const path = await import("path");
      const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
      const STORAGE_DIR = path.join(VOLUME_PATH, "english-supplementary");
      const cropResult = await autoCropPictures(pdfBuffer, extraction.structured, STORAGE_DIR, year);
      console.log(`[english-oral-compo] ${year} auto-cropped ${cropResult.savedCount} picture(s)${cropResult.errors.length ? `, errors: ${cropResult.errors.join("; ")}` : ""}`);
    } catch (cropErr) {
      console.warn(`[english-oral-compo] ${year} auto-crop step failed (non-fatal):`, cropErr);
    }
    try {
      const path = await import("path");
      const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
      const STORAGE_DIR = path.join(VOLUME_PATH, "english-supplementary");
      const listenResult = await autoCropListeningQuestions(pdfBuffer, extraction.paper3Pages, STORAGE_DIR, year);
      console.log(`[english-oral-compo] ${year} auto-cropped ${listenResult.savedCount} listening question(s)${listenResult.errors.length ? `, errors: ${listenResult.errors.join("; ")}` : ""}`);
    } catch (cropErr) {
      console.warn(`[english-oral-compo] ${year} listening auto-crop step failed (non-fatal):`, cropErr);
    }

    await prisma.englishSupplementaryPaper.update({
      where: { id: rowId }, data: { status: "ready" },
    });
    console.log(`[english-oral-compo] ${year} extraction complete`);
  } catch (err) {
    console.error(`[english-oral-compo] extraction failed for ${year}:`, err);
    try {
      await prisma.englishSupplementaryPaper.update({
        where: { id: rowId },
        data: { status: "failed", errorMessage: err instanceof Error ? err.message : String(err) },
      });
    } catch { /* swallow */ }
  }
}
