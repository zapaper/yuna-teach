// GET /api/admin/compo/[id]/export-docx?view=marked|clean|elevated
//
// Generates a clean Word doc containing ONLY the essay text for the
// chosen view. No rubric, no annotations, no swap markers — what the
// kid copies into their notebook to memorise.
//
//   - view=marked    → the raw OCR'd composition (kid's original text)
//   - view=clean     → the OCR with wrong-words applied (corrections in line)
//   - view=elevated  → the AI-enhanced draft, with [+...+] / [+...|bucket+]
//                       markers stripped so it reads as final prose

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";
import {
  Document, Packer, Paragraph, TextRun, AlignmentType,
} from "docx";

const CJK_FONT = "Microsoft YaHei";

type WrongWord = { original: string; suggestion: string };

// Substitute each wrong-word in the OCR text with its suggestion. Longer
// originals first so a 2-char "苹谷" doesn't get partially overwritten by
// a 1-char rule earlier in the list.
function applyClean(ocr: string, ws: WrongWord[]): string {
  let out = ocr;
  const sorted = [...ws].sort((a, b) => b.original.length - a.original.length);
  for (const w of sorted) {
    if (!w.original) continue;
    out = out.split(w.original).join(w.suggestion);
  }
  return out;
}

// Strip [+...+] and [+...|bucket+] markers from the elevated draft so
// the prose reads naturally.
function stripElevateMarkers(draft: string): string {
  return draft.replace(/\[\+([\s\S]*?)\+\]/g, (_, inner) => {
    // [+text|bucket+] — drop the |bucket suffix
    const m = inner.match(/^([\s\S]*)\|[a-z]+$/);
    return m ? m[1] : inner;
  });
}

function buildEssayDoc(title: string, body: string): Promise<Buffer> {
  // Split into paragraphs on blank lines OR single \n (Gemini sometimes
  // emits each para on its own line).
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
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const view = (req.nextUrl.searchParams.get("view") ?? "elevated").toLowerCase();
  if (view !== "marked" && view !== "clean" && view !== "elevated") {
    return NextResponse.json({ error: "view must be marked | clean | elevated" }, { status: 400 });
  }

  const row = await prisma.compoAttempt.findUnique({
    where: { id },
    select: { id: true, label: true, ocrText: true, wrongWords: true, recommendations: true },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const ocr = (row.ocrText ?? "").trim();
  const wrongWords = (row.wrongWords as WrongWord[] | null) ?? [];
  const elevated = (row.recommendations as { elevatedDraft?: string } | null)?.elevatedDraft ?? "";

  let body = "";
  let viewLabel = "";
  if (view === "marked") {
    body = ocr;
    viewLabel = "Original";
  } else if (view === "clean") {
    body = applyClean(ocr, wrongWords);
    viewLabel = "Clean";
  } else {
    body = stripElevateMarkers(elevated || ocr);
    viewLabel = "Enhanced";
  }
  body = body.trim();
  if (body.length === 0) {
    return NextResponse.json({ error: `No text available for the '${view}' view` }, { status: 400 });
  }

  const title = `${row.label ?? "Composition"} — ${viewLabel}`;
  const buf = await buildEssayDoc(title, body);
  // Filename: safe ascii + view suffix; the kid sees this in their downloads.
  const safeLabel = (row.label ?? "composition").replace(/[^\w一-鿿\s.-]/g, "").trim().slice(0, 60) || "composition";
  const filename = `${safeLabel}-${view}.docx`;
  // RFC 5987 to handle CJK in the filename header.
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
