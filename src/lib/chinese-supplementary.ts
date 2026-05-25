// Extraction pipeline for PSLE Chinese Paper 1 (作文 composition) and
// Paper 3 (口试 oral / 听力 listening) sections.
//
// Flow:
//   1. Render uploaded PDF to per-page JPEGs.
//   2. Send all pages to Gemini 3.1-pro: identify Paper 1, Paper 3, and
//      the corresponding answer-key page ranges.
//   3. For each identified section, send just those page images back to
//      Gemini 3.1-pro and OCR to clean Chinese text.
//   4. Persist page ranges + raw text into ChineseSupplementaryPaper.
//
// All non-trivial Gemini calls go through gemini-3.1-pro-preview at the
// user's request — section detection is high-stakes (a wrong split
// silently mis-OCRs the wrong pages) and OCR quality on handwritten /
// scanned Chinese is materially better on 3.1-pro vs 2.5-flash.

import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import { renderPdfToJpegs } from "./pdf-server";

// Render a SINGLE PDF page and return the JPEG buffer. Used when
// the admin UI wants the Option 2 page image on demand instead of
// having to keep all page renders on disk. Internally renders the
// whole PDF (pdfjs has no per-page entry point we expose) but only
// returns the requested page.
export async function renderSinglePage(
  pdfBuffer: Buffer,
  pageNumber: number,
  maxDim = 1600,
  quality = 85,
): Promise<Buffer> {
  const pages = await renderPdfToJpegs(pdfBuffer, maxDim, quality);
  if (pageNumber < 1 || pageNumber > pages.length) {
    throw new Error(`pageNumber ${pageNumber} out of range (1..${pages.length})`);
  }
  return pages[pageNumber - 1];
}

// Crop a JPEG to the given bounds. left/top/width/height are
// expressed as fractions of the image dimensions (0-1) so the
// crop survives the resize that renderPdfToJpegs may apply. The
// browser sends crop bounds it computed on a possibly-resized
// display image; using fractions lets us crop the source-resolution
// page accurately without round-tripping image dimensions.
export async function cropPageImage(
  pageJpeg: Buffer,
  fractions: { left: number; top: number; width: number; height: number },
  outQuality = 90,
): Promise<Buffer> {
  const meta = await sharp(pageJpeg).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (!W || !H) throw new Error("could not read source image dimensions");
  const left = Math.max(0, Math.round(fractions.left * W));
  const top = Math.max(0, Math.round(fractions.top * H));
  const width = Math.min(W - left, Math.round(fractions.width * W));
  const height = Math.min(H - top, Math.round(fractions.height * H));
  if (width <= 0 || height <= 0) throw new Error("crop dimensions are zero");
  return sharp(pageJpeg)
    .extract({ left, top, width, height })
    .jpeg({ quality: outQuality, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

const SECTION_MODEL = "gemini-3.1-pro-preview";
const OCR_MODEL = "gemini-3.1-pro-preview";

let _ai: GoogleGenAI | null = null;
function ai() {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { timeout: 240000 } });
  return _ai;
}

export type SectionPages = {
  paper1Pages: number[];        // 1-indexed inclusive list
  paper3Pages: number[];
  paper1AnswerPages: number[];
  paper3AnswerPages: number[];
};

export type CompoOption2 = {
  instructions: string;
  helpingWords: string[];
  picturePageNum: number | null;   // PDF page number where the picture lives
};

export type ListeningMcqOption = {
  label: string;        // "(1)" / "(2)" / "(3)" or "A"/"B"/"C"
  text: string;         // option text, or "[图]" + description for image options
};

export type ListeningMcq = {
  num: number;          // 1..10
  text: string;         // question stem
  options: ListeningMcqOption[];
  isImageOptions: boolean;
};

export type ListeningPassage = {
  num: number;                  // 1..7 (passage number)
  text: string;                 // the passage / dialogue text
  questionNumbers: number[];    // which MCQ numbers this passage answers
};

export type ListeningAnswer = { num: number; answer: string };

export type StructuredExtraction = {
  compoOption1Topic: string | null;
  compoOption2: CompoOption2 | null;
  listeningMcqs: ListeningMcq[];
  listeningPassages: ListeningPassage[];
  compoOption1Model: string | null;
  compoOption2Model: string | null;
  listeningAnswers: ListeningAnswer[];
};

export type SupplementaryExtraction = SectionPages & {
  pageCount: number;
  paper1Text: string;
  paper3Text: string;
  paper1AnswerText: string;
  paper3AnswerText: string;
  structured: StructuredExtraction;
};

function pagesToInline(pages: Buffer[], indices: number[]) {
  // Convert 1-indexed page numbers into the inline-data parts Gemini
  // wants. Silently drops out-of-range indices so a hallucinated
  // page number doesn't crash the run.
  return indices
    .filter(p => p >= 1 && p <= pages.length)
    .map(p => ({
      inlineData: { mimeType: "image/jpeg", data: pages[p - 1].toString("base64") },
    }));
}

async function detectSections(pages: Buffer[]): Promise<SectionPages> {
  // Send a thumbnail-quality version of every page. The model just
  // needs to read headers / footers / "试卷一" / "答案" labels — we
  // don't need full resolution.
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
    {
      text: `以下是一份新加坡 PSLE（小六会考）华文试卷 PDF 的所有页面图像，按页码顺序排列（第 1 页是第一张图，依此类推，总共 ${pages.length} 页）。

请仔细查看每一页，判断它属于以下哪一类：
- "paper1"        — 第一部分：作文（学生需要写作文）
- "paper2"        — 第二部分：语文应用（MCQ、短文填空、阅读理解等）
- "paper3"        — 第三部分：口试或听力理解（图片说话 / 朗读 / 听力题）
- "paper1Answer"  — 第一部分（作文）相关的评分标准、范文或答案
- "paper3Answer"  — 第三部分（口试 / 听力）相关的标准答案、参考答案、录音稿
- "cover"         — 封面、考试说明、空白页、目录、考试规则等
- "other"         — 其他（如试卷二的答案、不相关的页面）

返回 JSON，列出所有 paper1 / paper3 / paper1Answer / paper3Answer 类别的页码（1-indexed inclusive）。其余页面无需列出。

返回格式（严格 JSON，无其他文字）：
{
  "paper1Pages": [int, ...],
  "paper3Pages": [int, ...],
  "paper1AnswerPages": [int, ...],
  "paper3AnswerPages": [int, ...]
}

如果某类别在 PDF 中不存在，返回空数组 []。`,
    },
    ...pages.map(buf => ({
      inlineData: { mimeType: "image/jpeg", data: buf.toString("base64") },
    })),
  ];

  const res = await ai().models.generateContent({
    model: SECTION_MODEL,
    contents: [{ role: "user", parts }],
    config: { temperature: 0, responseMimeType: "application/json" },
  });
  const text = res.text ?? "";
  const parsed = JSON.parse(text) as Partial<SectionPages>;
  return {
    paper1Pages: Array.isArray(parsed.paper1Pages) ? parsed.paper1Pages.filter((n): n is number => typeof n === "number") : [],
    paper3Pages: Array.isArray(parsed.paper3Pages) ? parsed.paper3Pages.filter((n): n is number => typeof n === "number") : [],
    paper1AnswerPages: Array.isArray(parsed.paper1AnswerPages) ? parsed.paper1AnswerPages.filter((n): n is number => typeof n === "number") : [],
    paper3AnswerPages: Array.isArray(parsed.paper3AnswerPages) ? parsed.paper3AnswerPages.filter((n): n is number => typeof n === "number") : [],
  };
}

async function ocrSection(
  pages: Buffer[],
  indices: number[],
  label: string,
): Promise<string> {
  if (indices.length === 0) return "";
  const imageParts = pagesToInline(pages, indices);
  if (imageParts.length === 0) return "";

  const res = await ai().models.generateContent({
    model: OCR_MODEL,
    contents: [{
      role: "user",
      parts: [
        {
          text: `以下是新加坡 PSLE 华文试卷中 "${label}" 部分的页面图像（共 ${imageParts.length} 页，按顺序排列，对应 PDF 的第 ${indices.join(", ")} 页）。

请逐页 OCR 并保留原文格式：
- 每一页开始前用 \`--- Page N ---\`（N 为该页在 PDF 中的真实页码）作为分隔。
- 保留题号（如 一、二、（1）、（2））和分段。
- 表格用 Markdown 表格语法呈现。
- 图片说话题中的图片内容请用文字简要描述（例如 "图：一个男孩在花园里浇花"）。
- 听力录音稿（若已印在答案部分）请完整抄写。
- 不要翻译，不要解释，不要总结 — 只输出原文 OCR。
- 不要使用 Markdown 代码围栏。

直接输出 OCR 文本：`,
        },
        ...imageParts,
      ],
    }],
    config: { temperature: 0 },
  });
  return (res.text ?? "").trim();
}

// Structured-extraction pass. Each section is mined for the
// specific shape we care about for trend analysis:
//   - Paper 1: Option 1 topic, Option 2 picture+helpingWords
//   - Paper 3: 10 MCQs + 7-ish passages mapped to question numbers
//   - Paper 1 answers: model essays for both options
//   - Paper 3 answers: 10 listening answers
// Each is one Gemini call that reads BOTH the raw OCR text and the
// page images — text gives reliable strings, images preserve picture
// position + image-option detection.

async function extractCompoStructure(
  pages: Buffer[],
  paper1Pages: number[],
  paper1Text: string,
): Promise<{ compoOption1Topic: string | null; compoOption2: CompoOption2 | null }> {
  if (paper1Pages.length === 0 || !paper1Text) {
    return { compoOption1Topic: null, compoOption2: null };
  }
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
    {
      text: `以下是 PSLE 华文试卷一（作文）的 OCR 文本以及对应的页面图像（PDF 真实页码：${paper1Pages.join(", ")}）。

请从中提取两个作文题目的结构化信息：

**第一题（Option 1）**：通常是一个命题作文。我们只关心题目本身（例如「我最难忘的一天」、「一次有意义的活动」等），不要范文。

**第二题（Option 2）**：看图作文。包含：
- 题目指示语（instructions）— 例如「根据图意，自拟题目，写一篇不少于100字的作文」
- 图片所在的 PDF 页码（picturePageNum）— 看哪一页有插图
- 帮助词汇（helpingWords）— 图片下方列出的所有词语（一个数组）

返回严格 JSON：
{
  "compoOption1Topic": "题目原文（仅一行）" | null,
  "compoOption2": {
    "instructions": "完整的指示语",
    "helpingWords": ["词1", "词2", ...],
    "picturePageNum": <int>
  } | null
}

若某项找不到，对应字段返回 null。helpingWords 找不到则返回空数组 []。

OCR 文本：
${paper1Text}

页面图像（按 PDF 页码顺序）：`,
    },
    ...pagesToInline(pages, paper1Pages),
  ];
  try {
    const res = await ai().models.generateContent({
      model: SECTION_MODEL,
      contents: [{ role: "user", parts }],
      config: { temperature: 0, responseMimeType: "application/json" },
    });
    const parsed = JSON.parse(res.text ?? "") as { compoOption1Topic?: string; compoOption2?: CompoOption2 };
    return {
      compoOption1Topic: typeof parsed.compoOption1Topic === "string" ? parsed.compoOption1Topic.trim() : null,
      compoOption2: parsed.compoOption2 && typeof parsed.compoOption2 === "object" ? {
        instructions: parsed.compoOption2.instructions ?? "",
        helpingWords: Array.isArray(parsed.compoOption2.helpingWords) ? parsed.compoOption2.helpingWords : [],
        picturePageNum: typeof parsed.compoOption2.picturePageNum === "number" ? parsed.compoOption2.picturePageNum : null,
      } : null,
    };
  } catch (err) {
    console.warn(`[chinese-supplementary] compo structuring failed:`, err);
    return { compoOption1Topic: null, compoOption2: null };
  }
}

async function extractListeningStructure(
  pages: Buffer[],
  paper3Pages: number[],
  paper3Text: string,
): Promise<{ listeningMcqs: ListeningMcq[]; listeningPassages: ListeningPassage[] }> {
  if (paper3Pages.length === 0 || !paper3Text) {
    return { listeningMcqs: [], listeningPassages: [] };
  }
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
    {
      text: `以下是 PSLE 华文试卷三（听力理解）的 OCR 文本以及对应页面图像（PDF 页码：${paper3Pages.join(", ")}）。

试卷三的结构（请严格按此提取）：
1. 首先是 10 道 MCQ 选择题，每题 3 个选项。选项有时是文字（A/B/C 或 (1)/(2)/(3)），有时是图片。若是图片选项，请在 text 字段写 "[图] <用一句话描述图片内容>" 并将 isImageOptions 设为 true。
2. 之后是约 7 段听力材料 (passages)，每段会注明对应哪几道题，例如「第 1 题」、「第 2、3 题」等。

返回严格 JSON：
{
  "listeningMcqs": [
    { "num": 1, "text": "题干文字（若仅是「请听」类提示则可留空）", "options": [{ "label": "(1)", "text": "..." }, ...], "isImageOptions": false }, ...
  ],
  "listeningPassages": [
    { "num": 1, "text": "听力材料完整内容（含对话、独白等）", "questionNumbers": [1] },
    { "num": 2, "text": "...", "questionNumbers": [2, 3] }, ...
  ]
}

OCR 文本：
${paper3Text}

页面图像：`,
    },
    ...pagesToInline(pages, paper3Pages),
  ];
  try {
    const res = await ai().models.generateContent({
      model: SECTION_MODEL,
      contents: [{ role: "user", parts }],
      config: { temperature: 0, responseMimeType: "application/json" },
    });
    const parsed = JSON.parse(res.text ?? "") as { listeningMcqs?: ListeningMcq[]; listeningPassages?: ListeningPassage[] };
    return {
      listeningMcqs: Array.isArray(parsed.listeningMcqs) ? parsed.listeningMcqs : [],
      listeningPassages: Array.isArray(parsed.listeningPassages) ? parsed.listeningPassages : [],
    };
  } catch (err) {
    console.warn(`[chinese-supplementary] listening structuring failed:`, err);
    return { listeningMcqs: [], listeningPassages: [] };
  }
}

async function extractCompoAnswers(
  paper1AnswerText: string,
): Promise<{ compoOption1Model: string | null; compoOption2Model: string | null }> {
  if (!paper1AnswerText) return { compoOption1Model: null, compoOption2Model: null };
  try {
    const res = await ai().models.generateContent({
      model: SECTION_MODEL,
      contents: [{ role: "user", parts: [{ text: `以下是 PSLE 华文试卷一作文部分的「答案 / 范文」OCR 文本。请从中分离出两篇范文：

第一题（Option 1）的范文 — 通常对应命题作文题目。
第二题（Option 2）的范文 — 通常对应看图作文题目。

返回严格 JSON：
{ "compoOption1Model": "...全文..." | null, "compoOption2Model": "...全文..." | null }

若 OCR 文本只包含其中一篇，另一篇返回 null。
保留原文段落和标点，不要总结或改写。

OCR 文本：
${paper1AnswerText}` }] }],
      config: { temperature: 0, responseMimeType: "application/json" },
    });
    const parsed = JSON.parse(res.text ?? "") as { compoOption1Model?: string; compoOption2Model?: string };
    return {
      compoOption1Model: typeof parsed.compoOption1Model === "string" ? parsed.compoOption1Model.trim() : null,
      compoOption2Model: typeof parsed.compoOption2Model === "string" ? parsed.compoOption2Model.trim() : null,
    };
  } catch (err) {
    console.warn(`[chinese-supplementary] compo answers structuring failed:`, err);
    return { compoOption1Model: null, compoOption2Model: null };
  }
}

async function extractListeningAnswers(paper3AnswerText: string): Promise<ListeningAnswer[]> {
  if (!paper3AnswerText) return [];
  try {
    const res = await ai().models.generateContent({
      model: SECTION_MODEL,
      contents: [{ role: "user", parts: [{ text: `以下是 PSLE 华文试卷三（听力）的答案 OCR 文本。请提取 10 道 MCQ 的标准答案。

返回严格 JSON：
{ "listeningAnswers": [{ "num": 1, "answer": "(1)" | "A" | ... }, ...] }

answer 字段保留原文格式（带括号 "(2)" 或字母 "B" 都可以）。共 10 题，按 num=1..10 排序。
若某题 OCR 不清，对应 answer 字段返回 "?"。

OCR 文本：
${paper3AnswerText}` }] }],
      config: { temperature: 0, responseMimeType: "application/json" },
    });
    const parsed = JSON.parse(res.text ?? "") as { listeningAnswers?: ListeningAnswer[] };
    return Array.isArray(parsed.listeningAnswers) ? parsed.listeningAnswers : [];
  } catch (err) {
    console.warn(`[chinese-supplementary] listening answers structuring failed:`, err);
    return [];
  }
}

export async function extractSupplementaryFromPdf(
  pdfBuffer: Buffer,
  onProgress?: (status: string) => void | Promise<void>,
): Promise<SupplementaryExtraction> {
  onProgress?.("rendering");
  const pages = await renderPdfToJpegs(pdfBuffer, 1600, 80);

  onProgress?.("sectioning");
  const sections = await detectSections(pages);

  onProgress?.("ocr-paper1");
  const paper1Text = await ocrSection(pages, sections.paper1Pages, "Paper 1 作文");
  onProgress?.("ocr-paper3");
  const paper3Text = await ocrSection(pages, sections.paper3Pages, "Paper 3 口试 / 听力");
  onProgress?.("ocr-paper1-answer");
  const paper1AnswerText = await ocrSection(pages, sections.paper1AnswerPages, "Paper 1 答案 / 评分标准");
  onProgress?.("ocr-paper3-answer");
  const paper3AnswerText = await ocrSection(pages, sections.paper3AnswerPages, "Paper 3 答案 / 录音稿");

  // Phase 2 — structured extraction. Each call is independent and
  // best-effort; failures degrade to null/empty rather than aborting
  // the whole upload (raw OCR text remains as a fallback).
  onProgress?.("structuring");
  const [compoStruct, listenStruct, compoAnswers, listeningAnswers] = await Promise.all([
    extractCompoStructure(pages, sections.paper1Pages, paper1Text),
    extractListeningStructure(pages, sections.paper3Pages, paper3Text),
    extractCompoAnswers(paper1AnswerText),
    extractListeningAnswers(paper3AnswerText),
  ]);

  return {
    ...sections,
    pageCount: pages.length,
    paper1Text,
    paper3Text,
    paper1AnswerText,
    paper3AnswerText,
    structured: {
      compoOption1Topic: compoStruct.compoOption1Topic,
      compoOption2: compoStruct.compoOption2,
      listeningMcqs: listenStruct.listeningMcqs,
      listeningPassages: listenStruct.listeningPassages,
      compoOption1Model: compoAnswers.compoOption1Model,
      compoOption2Model: compoAnswers.compoOption2Model,
      listeningAnswers,
    },
  };
}
