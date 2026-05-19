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
  //
  // 完成对话 (complete dialogue / word-bank dialogue cloze) gets its
  // OWN prompt — the section is structurally different: a numbered
  // 8-option word bank ABOVE a multi-speaker dialogue with `______`
  // blanks. The generic reading-passage prompt mangles it (literal
  // "Q26" markers, missing speaker labels — see PSLE 2019 and
  // PSLE 2020 reports). Detected by Chinese OR English aliases on
  // the section name; result stored under the canonical 完成对话 key.
  const isChinese = (paper.subject ?? "").toLowerCase().includes("chinese");
  const sectionNameNorm = sectionName.toLowerCase().replace(/\s+/g, "");
  const isDialogueCompletion = isChinese && (
    sectionName.includes("完成对话") ||
    sectionName.includes("对话填空") ||
    sectionNameNorm.includes("dialoguecompletion") ||
    sectionNameNorm.includes("completedialogue") ||
    sectionNameNorm.includes("dialoguecloze")
  );
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
  for (const img of imagesBase64) {
    parts.push({ inlineData: { mimeType: "image/jpeg" as const, data: img } });
  }
  parts.push({ text: isDialogueCompletion ? `这是一份新加坡小学华文 (PSLE) 试卷的【完成对话】部分。

这一部分包含两个核心元素：
1. **词语表** — 一个有编号的表格，列出 8 个短语或短句 (编号 1 到 8)，作为学生的选择库。
2. **对话** — 由 2–3 个角色之间的对话，含有 4 个编号的空格 (通常是 Q26–Q29)。学生从词语表中挑出合适的选项填入每个空格。

请提取这部分并按以下精确格式输出 Markdown：

\`\`\`
四 完成对话 (4 题 8 分)
根据上下文的意思，从表中选出适当的短语或短句，然后把代表它们的数字填写在作答簿上。

| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|
| <选项 1 文字> | <选项 2 文字> | ... | <选项 8 文字> |

爸爸: <对话第一句>
小明: <含有空格的对话句子, 空格写成 ______> 我们就参加这项比赛好吗？
爸爸: 我都这把年纪了，______ 。
...
\`\`\`

【极重要的规则】
- 每个空格必须写成精确的 6 个连续下划线: **______** (不要写成 "Q26"、"(26)"、"[空]"、其他符号或表情)。
- 每段对话保留发言人标识 (例: 爸爸:、妈妈:、老师:、小华:、爷爷:)。每一行只能有一个发言人。
- 一句对话最多一个空格。如果一题包含多句, 把多句合并成同一发言人的同一段, 然后只在空格位置写 ______ 。
- 词语表使用 markdown 表格, 8 列, 列头为数字 1–8。文字按原文输入 (全角中文)。
- 不要加任何编号 (例如 Q26) 在对话里 — 编号只对应空格位置, 自动从对话顺序得出。
- 不要加多余说明、页眉、页脚、页码。
- 输出只包括上述 markdown 文本, 不要被 \`\`\` 围住。` : isChinese ? `从这些页中提取阅读理解的短文。

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

  // Update sectionOcrTexts metadata with new passageOcrText and passagePageIndices.
  // For 完成对话 we canonicalize the key to the Chinese label even
  // when the UI passed "dialogue completion" / similar English alias,
  // so it matches the question's syllabusTopic and the quiz
  // word-bank renderer can find it.
  const meta = (paper.metadata ?? {}) as Record<string, unknown>;
  const allOcr = (meta.sectionOcrTexts ?? {}) as Record<string, Record<string, unknown>>;
  const canonicalSectionName = isDialogueCompletion ? "完成对话" : sectionName;
  const secKey = Object.keys(allOcr).find(k =>
    k.toLowerCase().replace(/\s+/g, "") === canonicalSectionName.toLowerCase().replace(/\s+/g, "")
  ) ?? canonicalSectionName;
  allOcr[secKey] = {
    ...(allOcr[secKey] ?? {}),
    passageOcrText,
    passagePageIndices: pageIndices,
  };
  // If the OLD key was an English alias, remove it so we don't carry
  // two stale entries side by side.
  if (isDialogueCompletion && sectionName !== canonicalSectionName) {
    for (const k of Object.keys(allOcr)) {
      if (k !== secKey && k.toLowerCase().replace(/\s+/g, "") === sectionName.toLowerCase().replace(/\s+/g, "")) {
        delete allOcr[k];
        console.log(`[Re-extract Passage] removed stale section key "${k}" (canonicalised to "${secKey}")`);
      }
    }
  }

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
