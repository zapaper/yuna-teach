import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateContentWithRetry } from "@/lib/gemini";
import fs from "fs";
import path from "path";

const VOLUME_PATH = process.env.VOLUME_PATH || "/data";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { pageIndices, sectionName } = await request.json() as {
    pageIndices: number[];
    sectionName: string;
  };

  if (!pageIndices?.length || !sectionName) {
    return NextResponse.json({ error: "pageIndices and sectionName required" }, { status: 400 });
  }

  const paper = await prisma.examPaper.findUnique({ where: { id } });
  if (!paper) return NextResponse.json({ error: "Paper not found" }, { status: 404 });

  // Load page images from disk
  const pagesDir = path.join(VOLUME_PATH, "pages", id);
  const imagesBase64: string[] = [];
  for (const pageIdx of pageIndices) {
    const filePath = path.join(pagesDir, `page_${pageIdx}.jpg`);
    if (!fs.existsSync(filePath)) {
      return NextResponse.json({ error: `Page ${pageIdx} not found on disk` }, { status: 404 });
    }
    imagesBase64.push(fs.readFileSync(filePath).toString("base64"));
  }

  // OCR passage as line-numbered table
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
  for (const img of imagesBase64) {
    parts.push({ inlineData: { mimeType: "image/jpeg" as const, data: img } });
  }
  parts.push({ text: `Extract the reading passage from these pages as a LINE-BY-LINE table.

CRITICAL RULES:
- Each line of the passage must be its OWN row in the table
- The text in each row must match the EXACT line break in the original — if a line ends at the word "at", your row must also end at "at"
- If a line is indented (new paragraph), start the text with a tab character
- If there is a blank line in the original, include an empty row
- The passage has LINE NUMBERS printed in the margin (usually every 5 lines: 5, 10, 15, 20...)
- Include these line numbers in the second column where they appear

Output as a markdown table:
| Line | Text | No. |
|------|------|-----|
| 1 | The boy walked slowly down the | |
| 2 | narrow path, looking at the trees | |
| 3 | that lined both sides. He had | |
| 4 | never been to this part of the | |
| 5 | forest before, and everything seemed | 5 |
| | | |
| 6 |     A sudden noise startled him. | |

IMPORTANT: Blank lines (paragraph breaks) do NOT increment the line count. In the example above, the blank line has NO number in column 1. Line 6 comes after the blank. New paragraphs must have a tab indent (4 spaces) at the start of the text.

Exclude page headers, footers, page numbers, and titles. Only the passage text.
Output ONLY the table.` });

  console.log(`[Re-extract Passage] ${sectionName}: OCR ${imagesBase64.length} page(s)`);

  const response = await generateContentWithRetry({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts }],
    config: { temperature: 0.1 },
  }, 2, 5000, `reextract-passage:${sectionName}`);

  const passageOcrText = response.text?.trim() ?? "";
  console.log(`[Re-extract Passage] ${sectionName}: result (${passageOcrText.length} chars)`);

  // Update sectionOcrTexts metadata with new passageOcrText and passagePageIndices
  const meta = (paper.metadata ?? {}) as Record<string, unknown>;
  const allOcr = (meta.sectionOcrTexts ?? {}) as Record<string, Record<string, unknown>>;
  const secKey = Object.keys(allOcr).find(k =>
    k.toLowerCase().replace(/\s+/g, "") === sectionName.toLowerCase().replace(/\s+/g, "")
  ) ?? sectionName;
  allOcr[secKey] = {
    ...(allOcr[secKey] ?? {}),
    passageOcrText,
    passagePageIndices: pageIndices,
  };
  await prisma.examPaper.update({
    where: { id },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { metadata: { ...meta, sectionOcrTexts: allOcr } as any },
  });

  return NextResponse.json({ passageOcrText, charCount: passageOcrText.length });
}
