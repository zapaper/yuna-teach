// OCR the P4 高级华文 词语单 pages with gemini-3.1-pro-preview.
// Same structure as P5/P6.

import * as fs from "fs";
import * as path from "path";
import { generateContentWithRetry } from "../src/lib/gemini";

const PAGES_DIR = path.join(__dirname, "p4-spelling-pages");
const OUT_PATH = path.join(__dirname, "p4-spelling-list.json");

type LessonRow = {
  page: number;
  lessonNumber: string | null;
  lessonTitle: string | null;
  recogniseWords: string[];
  writeWords: string[];
  collocations: string[];
  sentencePatterns: string[];
};

const PROMPT = `You are reading a single page from a Singapore Primary 4 高级华文 词语单 (Higher Chinese word list, Maris Stella school).

Each page covers ONE lesson. Sections (table form):
- 第N课《课题》  (lesson number + title at top)
- 识读词语   — words separated by 、
- 识写字词  — words separated by 、
- 词语搭配  — collocations separated by 、
- 句式 / 好句子 — example sentences (IGNORE)
- 默写       — dictation passage (IGNORE)

Rules:
- Each list entry is ONE word/phrase as printed — do NOT split a 4-char idiom into 2-char pieces.
- IGNORE handwritten pinyin overlays above characters (these are student annotations, NOT the actual word).
- IGNORE handwritten signatures or names at top.
- Return characters AS PRINTED (don't convert simplified ↔ traditional).
- Use [] for sections missing on this page.
- If page is purely cover/blank/non-lesson, return all nulls and empty arrays.

Return ONLY valid JSON:
{
  "lessonNumber": "第一课" | null,
  "lessonTitle": "..." | null,
  "recogniseWords": [...],
  "writeWords": [...],
  "collocations": [...],
  "sentencePatterns": [...]
}`;

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
  }, 2, 3000, `p4-page-${pageNum}`);
  const text = res.text ?? "";
  let parsed: Partial<LessonRow> = {};
  try {
    const m = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse((m ? m[0] : text).trim());
  } catch { parsed = {}; }
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
  console.log(`OCRing ${files.length} P4 pages with gemini-3.1-pro-preview...`);
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
        return { page: pageNum, lessonNumber: null, lessonTitle: null, recogniseWords: [], writeWords: [], collocations: [], sentencePatterns: [] };
      }
    }));
    rows.push(...results);
  }
  rows.sort((a, b) => a.page - b.page);
  const out = {
    source: "P4 Chinese spelling.pdf — 海星中学附小 四年级 高级华文 学习单",
    pageCount: rows.length,
    lessons: rows,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), "utf8");

  const totalR = rows.reduce((s, r) => s + r.recogniseWords.length, 0);
  const totalW = rows.reduce((s, r) => s + r.writeWords.length, 0);
  const totalC = rows.reduce((s, r) => s + r.collocations.length, 0);
  console.log(`\nWrote ${OUT_PATH}`);
  console.log(`Totals: ${totalR} 识读, ${totalW} 识写, ${totalC} 搭配`);
})();
