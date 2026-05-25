import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { isSessionAdmin, getSessionUserId } from "@/lib/session";
import { extractSupplementaryFromPdf } from "@/lib/chinese-supplementary";

// GET  /api/admin/chinese-oral-compo
//   List all rows, ordered by year desc.
//
// POST /api/admin/chinese-oral-compo
//   multipart form: { year: string, pdf: File }
//   Saves the PDF to volume, creates a row, fires-and-waits for the
//   Gemini extraction pipeline (PDF → section pages → OCR per section),
//   then returns the populated row. The whole thing is synchronous —
//   uploads typically take 1-3 min on a 30-page paper.

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const STORAGE_DIR = path.join(VOLUME_PATH, "chinese-supplementary");

async function ensureDir() {
  await fs.mkdir(STORAGE_DIR, { recursive: true });
}

export async function GET() {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const rows = await prisma.chineseSupplementaryPaper.findMany({
    orderBy: { year: "desc" },
    select: {
      id: true, year: true, status: true, errorMessage: true, pageCount: true,
      paper1Pages: true, paper3Pages: true, paper1AnswerPages: true, paper3AnswerPages: true,
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

  // Upsert the row up front so the admin sees status=ocr while we work.
  await ensureDir();
  const pdfPath = path.join(STORAGE_DIR, `${year}.pdf`);
  const pdfBuffer = Buffer.from(await pdf.arrayBuffer());
  await fs.writeFile(pdfPath, pdfBuffer);

  const row = await prisma.chineseSupplementaryPaper.upsert({
    where: { year },
    update: {
      pdfPath, status: "sectioning", errorMessage: null,
      paper1Pages: undefined, paper3Pages: undefined,
      paper1AnswerPages: undefined, paper3AnswerPages: undefined,
      paper1Text: null, paper3Text: null, paper1AnswerText: null, paper3AnswerText: null,
      uploadedBy: userId ?? undefined,
    },
    create: {
      year, pdfPath, status: "sectioning",
      uploadedBy: userId ?? undefined,
    },
    select: { id: true },
  });

  try {
    const extraction = await extractSupplementaryFromPdf(pdfBuffer, async (status) => {
      try {
        await prisma.chineseSupplementaryPaper.update({
          where: { id: row.id },
          data: { status },
        });
      } catch { /* non-fatal */ }
    });
    const updated = await prisma.chineseSupplementaryPaper.update({
      where: { id: row.id },
      data: {
        pageCount: extraction.pageCount,
        paper1Pages: extraction.paper1Pages,
        paper3Pages: extraction.paper3Pages,
        paper1AnswerPages: extraction.paper1AnswerPages,
        paper3AnswerPages: extraction.paper3AnswerPages,
        paper1Text: extraction.paper1Text || null,
        paper3Text: extraction.paper3Text || null,
        paper1AnswerText: extraction.paper1AnswerText || null,
        paper3AnswerText: extraction.paper3AnswerText || null,
        // Structured (Phase 2). Stored as JSON; null when extraction
        // failed for that section so the UI can render a fallback.
        compoOption1Topic: extraction.structured.compoOption1Topic,
        compoOption2: extraction.structured.compoOption2 ?? undefined,
        listeningMcqs: extraction.structured.listeningMcqs.length ? extraction.structured.listeningMcqs : undefined,
        listeningPassages: extraction.structured.listeningPassages.length ? extraction.structured.listeningPassages : undefined,
        compoOption1Model: extraction.structured.compoOption1Model,
        compoOption2Model: extraction.structured.compoOption2Model,
        listeningAnswers: extraction.structured.listeningAnswers.length ? extraction.structured.listeningAnswers : undefined,
        status: "ready",
        errorMessage: null,
      },
    });
    return NextResponse.json({ row: updated });
  } catch (err) {
    console.error(`[chinese-oral-compo] extraction failed for ${year}:`, err);
    await prisma.chineseSupplementaryPaper.update({
      where: { id: row.id },
      data: { status: "failed", errorMessage: err instanceof Error ? err.message : String(err) },
    });
    return NextResponse.json({ error: "Extraction failed", details: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
