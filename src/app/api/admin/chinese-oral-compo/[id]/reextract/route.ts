import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";
import { reextractSection, type SectionKey } from "@/lib/chinese-supplementary";

// POST /api/admin/chinese-oral-compo/[id]/reextract
//   Body: { section: "paper1" | "paper3" | "paper1Answer" | "paper3Answer", pages: number[] }
//
// Re-runs OCR + structured extraction for just ONE section, with
// the admin-specified page numbers (overrides whatever Gemini's
// auto-detect originally picked). Updates the matching fields in
// the DB row and returns them. Other sections are untouched.

const VALID_SECTIONS: SectionKey[] = ["paper1", "paper3", "paper1Answer", "paper3Answer"];

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;

  const body = await request.json() as { section?: string; pages?: number[] };
  const section = body.section as SectionKey;
  if (!VALID_SECTIONS.includes(section)) {
    return NextResponse.json({ error: `section must be one of ${VALID_SECTIONS.join(", ")}` }, { status: 400 });
  }
  const pages = Array.isArray(body.pages) ? body.pages.filter(n => typeof n === "number" && n > 0) : [];
  if (pages.length === 0) {
    return NextResponse.json({ error: "pages array required (1-indexed page numbers)" }, { status: 400 });
  }

  const row = await prisma.chineseSupplementaryPaper.findUnique({
    where: { id },
    select: { id: true, year: true, pdfPath: true },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!row.pdfPath) return NextResponse.json({ error: "Source PDF missing on disk — re-upload the year" }, { status: 404 });

  try {
    const pdfBuffer = await fs.readFile(row.pdfPath);
    const result = await reextractSection(pdfBuffer, section, pages);

    // Build the per-section update payload. Each section maps to:
    //   - the *Pages JSON column (which pages were used)
    //   - the *Text column (raw OCR)
    //   - the matching structured columns (compoOption1Topic, etc.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const update: any = {};
    if (section === "paper1") {
      update.paper1Pages = pages;
      update.paper1Text = result.text || null;
      update.compoOption1Topic = result.compoOption1Topic ?? null;
      update.compoOption2 = result.compoOption2 ?? undefined;
    } else if (section === "paper3") {
      update.paper3Pages = pages;
      update.paper3Text = result.text || null;
      update.listeningMcqs = result.listeningMcqs?.length ? result.listeningMcqs : undefined;
      update.listeningPassages = result.listeningPassages?.length ? result.listeningPassages : undefined;
    } else if (section === "paper1Answer") {
      update.paper1AnswerPages = pages;
      update.paper1AnswerText = result.text || null;
      update.compoOption1Model = result.compoOption1Model ?? null;
      update.compoOption2Model = result.compoOption2Model ?? null;
    } else if (section === "paper3Answer") {
      update.paper3AnswerPages = pages;
      update.paper3AnswerText = result.text || null;
      update.listeningAnswers = result.listeningAnswers?.length ? result.listeningAnswers : undefined;
    }
    await prisma.chineseSupplementaryPaper.update({ where: { id }, data: update });
    return NextResponse.json({
      ok: true,
      section,
      pages,
      textLength: result.text.length,
      structured: {
        compoOption1Topic: result.compoOption1Topic,
        compoOption2: result.compoOption2,
        listeningMcqsCount: result.listeningMcqs?.length,
        listeningPassagesCount: result.listeningPassages?.length,
        compoOption1Model: result.compoOption1Model ? `${result.compoOption1Model.length}ch` : null,
        compoOption2Model: result.compoOption2Model ? `${result.compoOption2Model.length}ch` : null,
        listeningAnswersCount: result.listeningAnswers?.length,
      },
    });
  } catch (err) {
    console.error(`[chinese-oral-compo] reextract ${section} for ${row.year} failed:`, err);
    return NextResponse.json({ error: "Re-extract failed", details: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
