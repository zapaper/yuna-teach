// GET /api/essay-coach/[id]/export-docx?view=marked|clean|elevated
//
// Parent-side mirror of the admin Word export. Same doc shape; auth
// is owner-of-attempt instead of admin-role.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";
import {
  Document, Packer, Paragraph, TextRun, AlignmentType,
} from "docx";

const CJK_FONT = "Microsoft YaHei";

type WrongWord = { original: string; suggestion: string };

function applyClean(ocr: string, ws: WrongWord[]): string {
  let out = ocr;
  const sorted = [...ws].sort((a, b) => b.original.length - a.original.length);
  for (const w of sorted) {
    if (!w.original) continue;
    out = out.split(w.original).join(w.suggestion);
  }
  return out;
}

function stripElevateMarkers(draft: string): string {
  return draft.replace(/\[\+([\s\S]*?)\+\]/g, (_, inner) => {
    const m = inner.match(/^([\s\S]*)\|[a-z]+$/);
    return m ? m[1] : inner;
  });
}

function buildEssayDoc(title: string, body: string): Promise<Buffer> {
  const paragraphs = body
    .split(/\n\s*\n|\n/)
    .map(p => p.trim())
    .filter(p => p.length > 0);
  const doc = new Document({
    creator: "MarkForYou",
    title,
    styles: {
      default: {
        document: { run: { font: { name: CJK_FONT, eastAsia: CJK_FONT }, size: 24 } },
      },
    },
    sections: [{
      properties: { page: { margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } },
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 200, after: 280 },
          children: [new TextRun({ text: title, bold: true, size: 32, font: { name: CJK_FONT, eastAsia: CJK_FONT } })],
        }),
        ...paragraphs.map(text => new Paragraph({
          spacing: { before: 80, after: 120, line: 400 },
          children: [new TextRun({ text, size: 24, font: { name: CJK_FONT, eastAsia: CJK_FONT } })],
        })),
      ],
    }],
  });
  return Packer.toBuffer(doc);
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireSession();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { id } = await params;
  const view = (req.nextUrl.searchParams.get("view") ?? "elevated").toLowerCase();
  if (view !== "marked" && view !== "clean" && view !== "elevated") {
    return NextResponse.json({ error: "view must be marked | clean | elevated" }, { status: 400 });
  }

  const row = await prisma.compoAttempt.findUnique({
    where: { id },
    select: { id: true, label: true, ocrText: true, wrongWords: true, recommendations: true, uploaderId: true },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!auth.isAdmin && row.uploaderId !== auth.userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const ocr = (row.ocrText ?? "").trim();
  const wrongWords = (row.wrongWords as WrongWord[] | null) ?? [];
  const elevated = (row.recommendations as { elevatedDraft?: string } | null)?.elevatedDraft ?? "";

  let body = "";
  let suffix = "";
  if (view === "marked") {
    body = ocr;
    suffix = "v1: original";
  } else if (view === "clean") {
    body = applyClean(ocr, wrongWords);
    suffix = "v2: clean rewrite";
  } else {
    body = stripElevateMarkers(elevated || ocr);
    suffix = "v3: enhanced";
  }
  body = body.trim();
  if (body.length === 0) {
    return NextResponse.json({ error: `No text available for the '${view}' view` }, { status: 400 });
  }

  const labelText = (row.label ?? "").trim() || "Composition";
  const title = `${labelText} ${suffix}`;
  const buf = await buildEssayDoc(title, body);
  const filename = `${title}.docx`;
  const fnStar = `UTF-8''${encodeURIComponent(filename)}`;

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, "_")}"; filename*=${fnStar}`,
      "Cache-Control": "no-store",
    },
  });
}
