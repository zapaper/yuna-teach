import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";
import { reextractSection, type SectionKey } from "@/lib/english-supplementary";

const VALID: SectionKey[] = ["paper1", "paper3", "paper4", "paper1Answer", "paper3Answer", "paper4Answer"];

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const body = await request.json() as { section?: string; pages?: number[] };
  const section = body.section as SectionKey;
  if (!VALID.includes(section)) return NextResponse.json({ error: `section must be one of ${VALID.join(", ")}` }, { status: 400 });
  const pages = Array.isArray(body.pages) ? body.pages.filter(n => typeof n === "number" && n > 0) : [];
  if (pages.length === 0) return NextResponse.json({ error: "pages array required" }, { status: 400 });

  const row = await prisma.englishSupplementaryPaper.findUnique({
    where: { id }, select: { id: true, year: true, pdfPath: true },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!row.pdfPath) return NextResponse.json({ error: "Source PDF missing — re-upload the year" }, { status: 404 });

  try {
    const pdfBuffer = await fs.readFile(row.pdfPath);
    const result = await reextractSection(pdfBuffer, section, pages);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const update: any = {};
    if (section === "paper1") {
      update.paper1Pages = pages; update.paper1Text = result.text || null;
      update.situationalWriting = result.situationalWriting ?? undefined;
      update.continuousTheme = result.continuousTheme ?? null;
      update.continuousPrompts = result.continuousPrompts?.length ? result.continuousPrompts : undefined;
    } else if (section === "paper3") {
      update.paper3Pages = pages; update.paper3Text = result.text || null;
      update.listeningMcqs = result.listeningMcqs?.length ? result.listeningMcqs : undefined;
      update.listeningTexts = result.listeningTexts?.length ? result.listeningTexts : undefined;
    } else if (section === "paper4") {
      update.paper4Pages = pages; update.paper4Text = result.text || null;
      update.oralDays = result.oralDays?.length ? result.oralDays : undefined;
    } else if (section === "paper1Answer") {
      update.paper1AnswerPages = pages; update.paper1AnswerText = result.text || null;
      update.situationalModel = result.situationalModel ?? null;
      update.continuousModel = result.continuousModel ?? null;
    } else if (section === "paper3Answer") {
      update.paper3AnswerPages = pages; update.paper3AnswerText = result.text || null;
      update.listeningAnswers = result.listeningAnswers?.length ? result.listeningAnswers : undefined;
    } else if (section === "paper4Answer") {
      update.paper4AnswerPages = pages; update.paper4AnswerText = result.text || null;
      update.oralModelAnswers = result.oralModelAnswers?.length ? result.oralModelAnswers : undefined;
    }
    await prisma.englishSupplementaryPaper.update({ where: { id }, data: update });
    return NextResponse.json({ ok: true, section, pages, textLength: result.text.length });
  } catch (err) {
    console.error(`[english-oral-compo] reextract ${section} for ${row.year} failed:`, err);
    return NextResponse.json({ error: "Re-extract failed", details: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
