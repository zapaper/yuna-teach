// OCR the P5 高级华文 词语单 pages with gemini-3.1-pro-preview.
// Same structure as P6 (识读 / 识写 / 搭配 / 句式 / 好句子 / 默写).
// Output: p5-spelling-list.json (same shape as P6).

import * as fs from "fs";
import * as path from "path";
import { generateContentWithRetry } from "../src/lib/gemini";

const PAGES_DIR = path.join(__dirname, "p5-spelling-list-pages");
const OUT_PATH = path.join(__dirname, "p5-spelling-list.json");

type LessonRow = {
  page: number;
  lessonNumber: string | null;
  lessonTitle: string | null;
  recogniseWords: string[];
  writeWords: string[];
  collocations: string[];
  sentencePatterns: string[];
};

const PROMPT = `You are reading a single page from a Singapore Primary 5 高级华文 词语单 (Higher Chinese word list).

Each page covers ONE lesson. The page typically contains these labelled sections (in a table or list form):
- 第N课《课题》  (lesson number + title at the top)
- 识读词语   — list of words separated by 、 commas
- 识写字词  — list of words separated by 、 commas
- 词语搭配  — verb-noun or adjective-noun collocations, separated by 、
- 句式      — sentence pattern examples (may have arrows ➔ or bullet •)
- 好句子    — example sentences (you can IGNORE this section, do NOT extract)
- 默写      — dictation passage (you can IGNORE this section, do NOT extract)

Some pages may be missing some sections (especially the last few pages).
Some pages may NOT have a lesson header at all (continuation page or cover) — return nulls.
The PDF was scanned; small handwritten circles/marks may appear on words — ignore them, return the printed text.

Extract and return ONLY valid JSON (no markdown fences) of this exact shape:
{
  "lessonNumber": "第一课" | null,
  "lessonTitle": "到户外去" | null,
  "recogniseWords": ["word1", "word2", ...],
  "writeWords": [...],
  "collocations": [...],
  "sentencePatterns": ["sentence pattern with bold parts kept as plain text", ...]
}

Rules:
- Each list entry is ONE word/phrase as printed — do NOT split a 4-char idiom into 2-char pieces.
- Preserve characters as-is (don't convert simplified ↔ traditional).
- Use [] for sections that don't appear on this page.
- If the page is purely a cover/blank/non-lesson page, return all nulls and empty arrays.
- BE EXACT — gemini-3.1-pro-preview should not hallucinate. If a character is hard to read, return your best guess but do NOT invent characters.
`;

async function ocrPage(jpgBuf: Buffer, pageNum: number): Promise<LessonRow> {
  const res = await generateContentWithRetry({
    model: "gemini-3.1-pro-preview",
    contents: [{
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/jpeg", data: jpgBuf.toString("base64") } },
        { text: PROMPT },
      ],
    }],
    config: { responseMimeType: "application/json", temperature: 0.1 },
  }, 2, 3000, `p5-spelling-list-p${pageNum}`);
  const text = res.text ?? "";
  let parsed: Partial<LessonRow> = {};
  try {
    const m = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse((m ? m[0] : text).trim());
  } catch {
    parsed = {};
  }
  return {
    page: pageNum,
    lessonNumber: parsed.lessonNumber ?? null,
    lessonTitle: parsed.lessonTitle ?? null,
    recogniseWords: Array.isArray(parsed.recogniseWords) ? parsed.recogniseWords : [],
    writeWords: Array.isArray(parsed.writeWords) ? parsed.writeWords : [],
    collocations: Array.isArray(parsed.collocations) ? parsed.collocations : [],
    sentencePatterns: Array.isArray(parsed.sentencePatterns) ? parsed.sentencePatterns : [],
  };
}

(async () => {
  const files = fs.readdirSync(PAGES_DIR).filter(f => f.endsWith(".jpg")).sort();
  console.log(`OCRing ${files.length} P5 pages...`);
  const rows: LessonRow[] = [];

  const BATCH = 2;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (f) => {
      const pageNum = parseInt(f.match(/page-(\d+)/)?.[1] ?? "0", 10);
      const buf = fs.readFileSync(path.join(PAGES_DIR, f));
      try {
        const r = await ocrPage(buf, pageNum);
        console.log(`  page ${pageNum}: ${r.lessonNumber ?? "(no header)"} ${r.lessonTitle ?? ""} — ${r.recogniseWords.length} 识读, ${r.writeWords.length} 识写, ${r.collocations.length} 搭配`);
        return r;
      } catch (err) {
        console.error(`  page ${pageNum} FAILED:`, (err as Error).message);
        return { page: pageNum, lessonNumber: null, lessonTitle: null, recogniseWords: [], writeWords: [], collocations: [], sentencePatterns: [] } as LessonRow;
      }
    }));
    rows.push(...results);
  }

  rows.sort((a, b) => a.page - b.page);
  const out = {
    source: "P5 Chinese spelling list.pdf — 海星中学附小 五年级 高级华文 词语单",
    pageCount: rows.length,
    lessons: rows,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), "utf8");
  console.log(`\nWrote ${OUT_PATH}`);

  const totalRecognise = rows.reduce((s, r) => s + r.recogniseWords.length, 0);
  const totalWrite = rows.reduce((s, r) => s + r.writeWords.length, 0);
  const totalCollocations = rows.reduce((s, r) => s + r.collocations.length, 0);
  console.log(`Totals: ${totalRecognise} 识读, ${totalWrite} 识写, ${totalCollocations} 搭配`);
})();
