// OCR each page of the P6 高级华文 词语单 with Gemini and extract
// the per-lesson structured data: lesson title, 识读词语, 识写字词,
// 词语搭配, 句式. Skip 佳句 and 默写 (dictation passage) — those are
// for the drill, not the wordlist.

import * as fs from "fs";
import * as path from "path";
import { generateContentWithRetry } from "../src/lib/gemini";

const PAGES_DIR = path.join(__dirname, "spelling-list-pages");
const OUT_PATH = path.join(__dirname, "p6-spelling-list.json");

type LessonRow = {
  page: number;
  lessonNumber: string | null;    // e.g. "第一课" / "第二课"
  lessonTitle: string | null;     // e.g. "加油！加油！"
  recogniseWords: string[];       // 识读词语 (list of comma-separated entries)
  writeWords: string[];           // 识写字词
  collocations: string[];         // 词语搭配
  sentencePatterns: string[];     // 句式
  rawDump?: string;               // for debugging if structure parse fails
};

const PROMPT = `You are reading a single page from a Singapore Primary 6 高级华文 词语单 (Higher Chinese word list).

Each page covers ONE lesson. The page typically contains these labelled sections (in a table or list form):
- 第N课《课题》  (lesson number + title at the top)
- 识读词语   — list of words separated by 、 commas
- 识写字词  — list of words separated by 、 commas
- 词语搭配  — verb-noun or adjective-noun collocations, separated by 、
- 句式      — sentence pattern examples (may have arrows ➔ or bullet •)
- 佳句      — example sentences (you can IGNORE this)
- 默写      — dictation passage (you can IGNORE this)

Some pages may be missing some sections (especially the last few pages).
Some pages may NOT have a lesson header at all (continuation page or cover) — return nulls.
The PDF was scanned; small handwritten circles/marks may appear on words — ignore them, return the printed text.

Extract and return ONLY valid JSON (no markdown fences) of this exact shape:
{
  "lessonNumber": "第一课" | null,
  "lessonTitle": "加油！加油！" | null,
  "recogniseWords": ["word1", "word2", ...],
  "writeWords": [...],
  "collocations": [...],
  "sentencePatterns": ["sentence pattern with bold parts kept as plain text", ...]
}

Rules:
- Each list entry is ONE word/phrase as printed (do NOT split a 4-char idiom into 2-char pieces).
- Preserve characters as-is (don't convert simplified ↔ traditional).
- Use [] for sections that don't appear on this page.
- If the page is purely a cover/blank/non-lesson page, return all nulls and empty arrays.
`;

async function ocrPage(jpgBuf: Buffer, pageNum: number): Promise<LessonRow> {
  // gemini-3.1-pro-preview is much more accurate on dense Chinese
  // characters than 2.5-flash; falls back to 2.5-flash on timeout
  // via generateContentWithRetry's FALLBACK_MODELS map.
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
  }, 2, 3000, `spelling-list-p${pageNum}`);
  const text = res.text ?? "";
  let parsed: Partial<LessonRow> = {};
  try {
    const m = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse((m ? m[0] : text).trim());
  } catch {
    parsed = { rawDump: text.slice(0, 500) };
  }
  return {
    page: pageNum,
    lessonNumber: parsed.lessonNumber ?? null,
    lessonTitle: parsed.lessonTitle ?? null,
    recogniseWords: Array.isArray(parsed.recogniseWords) ? parsed.recogniseWords : [],
    writeWords: Array.isArray(parsed.writeWords) ? parsed.writeWords : [],
    collocations: Array.isArray(parsed.collocations) ? parsed.collocations : [],
    sentencePatterns: Array.isArray(parsed.sentencePatterns) ? parsed.sentencePatterns : [],
    rawDump: parsed.rawDump,
  };
}

(async () => {
  const files = fs.readdirSync(PAGES_DIR)
    .filter(f => f.endsWith(".jpg"))
    .sort();

  console.log(`OCRing ${files.length} pages...`);
  const rows: LessonRow[] = [];

  // Batch parallel — 2 at a time for pro model (slower, more polite).
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

  // Aggregate global sets for the repository view.
  const allRecognise = new Set<string>();
  const allWrite = new Set<string>();
  const allCollocations = new Set<string>();
  for (const r of rows) {
    r.recogniseWords.forEach(w => allRecognise.add(w));
    r.writeWords.forEach(w => allWrite.add(w));
    r.collocations.forEach(w => allCollocations.add(w));
  }

  const out = {
    source: "P6 Chinese spelling list.pdf — 海星中学附小 六年级 高级华文 词语单",
    pageCount: rows.length,
    lessons: rows,
    aggregate: {
      recogniseTotal: allRecognise.size,
      writeTotal: allWrite.size,
      collocationsTotal: allCollocations.size,
      recogniseAll: [...allRecognise].sort(),
      writeAll: [...allWrite].sort(),
      collocationsAll: [...allCollocations].sort(),
    },
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), "utf8");
  console.log(`\nWrote ${OUT_PATH}`);
  console.log(`Totals: ${allRecognise.size} 识读, ${allWrite.size} 识写, ${allCollocations.size} 搭配`);
})();
