import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";
import {
  extractSupplementaryFromPdf,
  autoCropPictures,
  autoCropListeningQuestions,
} from "@/lib/english-supplementary";

// POST /api/admin/english-oral-compo/[id]/redetect
//
// Full re-extraction of an already-uploaded paper. Reuses the stored
// PDF — no re-upload needed. Same pipeline as the initial background
// extraction: section-detect → OCR → structured extract → auto-crop.
//
// Use when the section-detect prompt has changed and existing papers
// have wrong page tags (e.g. text passages being filed under
// paper3Answer instead of paper3).

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const STORAGE_DIR = path.join(VOLUME_PATH, "english-supplementary");

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const row = await prisma.englishSupplementaryPaper.findUnique({
    where: { id },
    select: { id: true, year: true, pdfPath: true },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!row.pdfPath) return NextResponse.json({ error: "Source PDF missing — re-upload the year" }, { status: 404 });

  // Mark sectioning + clear stale page lists so the UI shows progress.
  await prisma.englishSupplementaryPaper.update({
    where: { id },
    data: {
      status: "sectioning", errorMessage: null,
      paper1Pages: undefined, paper3Pages: undefined, paper4Pages: undefined,
      paper1AnswerPages: undefined, paper3AnswerPages: undefined, paper4AnswerPages: undefined,
      paper1Text: null, paper3Text: null, paper4Text: null,
      paper1AnswerText: null, paper3AnswerText: null, paper4AnswerText: null,
      situationalWriting: undefined,
      continuousTheme: null, continuousPrompts: undefined,
      listeningMcqs: undefined, listeningTexts: undefined,
      oralDays: undefined,
      situationalModel: null, continuousModel: null,
      listeningAnswers: undefined, oralModelAnswers: undefined,
    },
  });

  const pdfBuffer = await fs.readFile(row.pdfPath);
  runRedetectInBackground(id, row.year, pdfBuffer);

  return NextResponse.json({
    ok: true,
    note: "Full re-extraction running in background — refresh the modal to see status updates.",
  });
}

async function runRedetectInBackground(rowId: string, year: string, pdfBuffer: Buffer) {
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

    try {
      const cropResult = await autoCropPictures(pdfBuffer, extraction.structured, STORAGE_DIR, year);
      console.log(`[english-oral-compo] redetect ${year} auto-cropped ${cropResult.savedCount} picture(s)${cropResult.errors.length ? `, errors: ${cropResult.errors.join("; ")}` : ""}`);
    } catch (cropErr) {
      console.warn(`[english-oral-compo] redetect ${year} auto-crop step failed (non-fatal):`, cropErr);
    }
    try {
      const listenResult = await autoCropListeningQuestions(pdfBuffer, extraction.paper3Pages, STORAGE_DIR, year);
      console.log(`[english-oral-compo] redetect ${year} auto-cropped ${listenResult.savedCount} listening question(s)${listenResult.errors.length ? `, errors: ${listenResult.errors.join("; ")}` : ""}`);
    } catch (cropErr) {
      console.warn(`[english-oral-compo] redetect ${year} listening auto-crop step failed (non-fatal):`, cropErr);
    }

    await prisma.englishSupplementaryPaper.update({
      where: { id: rowId }, data: { status: "ready" },
    });
    console.log(`[english-oral-compo] redetect ${year} complete`);
  } catch (err) {
    console.error(`[english-oral-compo] redetect failed for ${year}:`, err);
    try {
      await prisma.englishSupplementaryPaper.update({
        where: { id: rowId },
        data: { status: "failed", errorMessage: err instanceof Error ? err.message : String(err) },
      });
    } catch { /* swallow */ }
  }
}
