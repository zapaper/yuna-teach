import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { generateContentWithRetry } from "@/lib/gemini";
import { buildChineseSections, type OcrEntry } from "@/lib/extraction";
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

  // OCR the passage. Chinese papers get a plain-paragraph prompt
  // (no margin line numbers — 华文 papers don't print them and the
  // student never has to cite them). English keeps the line-numbered
  // markdown table because Comp OEQ answers DO reference line numbers.
  const isChinese = (paper.subject ?? "").toLowerCase().includes("chinese");
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
  for (const img of imagesBase64) {
    parts.push({ inlineData: { mimeType: "image/jpeg" as const, data: img } });
  }
  parts.push({ text: isChinese ? `从这些页中提取阅读理解的短文。

要求：
- 一段一段输出，每段一行；段与段之间用一个空行隔开。
- 每段的开头必须空两格 (即在该行的开头加 4 个空格)，包括第一段。
- 保留印在原文上的格式标记：原文加粗的部分用 **双星号** 包围 (例：**重要**)；原文有下划线的词用 __双下划线__ 包围 (例：__稍微__)；既加粗又有下划线的用 **__双星号加双下划线__**。不要把这些标记去掉，前端的渲染器会用到。
- 不要加任何编号、行号、表格、标题、页眉、页脚。只输出短文本身的段落文字。
- 标点符号和中文字符保持原样 (全角)。

只输出短文文本，不要任何其他说明。` : `Extract the reading passage from these pages as a LINE-BY-LINE table.

CRITICAL RULES:
- Each line of the passage must be its OWN row in the table
- The text in each row must match the EXACT line break in the original — if a line ends at the word "at", your row must also end at "at"
- Every paragraph's FIRST line — INCLUDING the very first paragraph of the passage — MUST start with a tab character (or 4 spaces). Do NOT skip the tab on line 1; it is just as much a paragraph start as any other.
- If a line is indented (new paragraph), start the text with a tab character
- If there is a blank line in the original, include an empty row
- PRESERVE formatting from the printed page: BOLD text → wrap with **double asterisks** (e.g. **important**); UNDERLINED text → wrap with __double underscores__ (e.g. __slightly__). Both together is **__word__**.
- The passage has LINE NUMBERS printed in the margin (usually every 5 lines: 5, 10, 15, 20...)
- Include these line numbers in the second column where they appear

Output as a markdown table:
| Line | Text | No. |
|------|------|-----|
| 1 |     The boy walked slowly down the | |
| 2 | narrow path, looking at the trees | |
| 3 | that lined both sides. He had | |
| 4 | never been to this part of the | |
| 5 | forest before, and everything seemed | 5 |
| | | |
| 6 |     A sudden noise startled him. | |

IMPORTANT: Blank lines (paragraph breaks) do NOT increment the line count. In the example above, the blank line has NO number in column 1. Line 6 comes after the blank. Every paragraph's first line is indented — including line 1.

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

  // For Chinese papers, rebuild chineseSections so the freshly OCR'd
  // passage immediately shows up in the quiz / edit / review UI
  // without a separate backfill step. (isChinese already declared
  // above to switch the OCR prompt.)
  let chineseSectionsUpdate: Record<string, unknown> = {};
  if (isChinese) {
    const qs = await prisma.examQuestion.findMany({
      where: { examPaperId: id },
      orderBy: { orderIndex: "asc" },
      select: { pageIndex: true, syllabusTopic: true },
    });
    const built = buildChineseSections(qs, allOcr as Record<string, OcrEntry>);
    chineseSectionsUpdate = { chineseSections: built };
  }

  await prisma.examPaper.update({
    where: { id },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { metadata: { ...meta, sectionOcrTexts: allOcr, ...chineseSectionsUpdate } as any },
  });

  return NextResponse.json({ passageOcrText, charCount: passageOcrText.length });
}
