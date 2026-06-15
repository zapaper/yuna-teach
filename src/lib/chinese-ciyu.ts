// P4 词语搭配 (word-collocation matching) shared extract + passage
// builder. Used by:
//   · /api/admin/exam/[id]/normal-extract-chinese — augments duihua
//     re-extract for P4 papers
//   · /api/exam/[id]/reextract-section — handles the section directly
//     when the admin clicks Re-extract on a 词语搭配 section
//
// 词语搭配 prints a numbered phrase bank at the top of the section
// (typically 6 or 8 phrases) and a row of short prompt phrases like
// "Q11 摇摆 (   )" / "Q12 (   ) 规则" — the empty parens is the answer
// slot. Default Chinese OCR drops both pieces, so this module re-OCRs
// the page with a 词语搭配-specific prompt and emits a synthetic
// markdown passage that the existing grammar-cloze renderer
// (PassageWithInputs) already knows how to lay out:
//   · digit row + phrase row (2-row word bank — the linkedLabels pre-
//     pass auto-strikes used phrases for free, same as the PSLE
//     2024/2025 完成对话 bank)
//   · each Q on its own line with a **(qNum)____** marker that
//     becomes a labelled input.
//
// P4-only. P5/P6 don't use this layout and rewriting their dialogue
// sections would be destructive.

import { GoogleGenAI } from "@google/genai";

export type CiyuExtract = {
  wordBank: Array<{ num: number; phrase: string }>;
  questions: Array<{ qNum: number; stemBefore: string; stemAfter: string }>;
};

let _ai: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? "" });
  return _ai;
}

export async function extractCiyuP4Content(
  pageBytes: Buffer,
  pageIndex: number,
  expectedQNums: number[],
): Promise<CiyuExtract | null> {
  const prompt = `You are reading page ${pageIndex + 1} of a Singapore Primary 4 Chinese (华文) paper. The section on this page is 词语搭配 — a word-collocation matching exercise.

LAYOUT:
- Top of the section: a TABLE of numbered Chinese phrases. There are typically 6 or 8 phrases (count whatever you see), labelled (1) through (N). Example: (1) 家长 (2) 插队 (3) 身体 (4) 穷人 (5) 挥动 (6) 遵守.
- Below the table: 4-6 short prompt rows. Each row has a printed question number in parentheses, an empty bracket where the student writes the matching phrase number, and a prompt phrase. The empty bracket can appear AFTER the prompt phrase ("Q11 摇摆 (   )") OR BEFORE it ("Q12 (   ) 规则"). The "Q11" / "Q12" / "(11)" / "(12)" labels are the QUESTION NUMBER, NOT the answer.

EXTRACT:
1. EVERY phrase in the word bank, in order, with its bank-number. Count and report ALL of them, whether 6 or 8.
2. For each prompt row whose question number is in this list: ${expectedQNums.join(", ")}. Report:
   - "qNum": the question number (e.g. 11)
   - "stemBefore": the Chinese text BEFORE the empty parens, trimmed (often empty when parens come first)
   - "stemAfter": the Chinese text AFTER the empty parens, trimmed (often empty when parens come last)

Output STRICTLY this JSON shape — no markdown, no commentary:
{
  "wordBank": [{ "num": 1, "phrase": "家长" }, { "num": 2, "phrase": "插队" }],
  "questions": [
    { "qNum": 11, "stemBefore": "摇摆", "stemAfter": "" },
    { "qNum": 12, "stemBefore": "", "stemAfter": "规则" }
  ]
}`;

  const resp = await getAI().models.generateContent({
    model: "gemini-3.1-pro-preview",
    contents: [{
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/jpeg", data: pageBytes.toString("base64") } },
        { text: prompt },
      ],
    }],
    config: { responseMimeType: "application/json", temperature: 0 },
  });

  try {
    const parsed = JSON.parse(resp.text ?? "{}") as {
      wordBank?: Array<{ num?: unknown; phrase?: unknown }>;
      questions?: Array<{ qNum?: unknown; stemBefore?: unknown; stemAfter?: unknown }>;
    };
    const wordBank: CiyuExtract["wordBank"] = [];
    for (const w of parsed.wordBank ?? []) {
      const num = Number(w.num);
      const phrase = String(w.phrase ?? "").trim();
      if (Number.isFinite(num) && phrase) wordBank.push({ num, phrase });
    }
    const questions: CiyuExtract["questions"] = [];
    for (const q of parsed.questions ?? []) {
      const qNum = Number(q.qNum);
      if (!Number.isFinite(qNum)) continue;
      questions.push({
        qNum,
        stemBefore: String(q.stemBefore ?? "").trim(),
        stemAfter: String(q.stemAfter ?? "").trim(),
      });
    }
    return { wordBank, questions };
  } catch (err) {
    console.error(`[chinese-ciyu] parse failed for page ${pageIndex}:`, err);
    return null;
  }
}

// Build the synthetic passage that PassageWithInputs renders:
//   row 1: "| 1 | 2 | 3 | … | N |"  (digit labels)
//   sep:   "|---|---|---|---|---|---|---|---|"
//   row 2: "| 家长 | 插队 | … |"      (phrase row, auto-linked to digits)
//   blank line
//   "11. 摇摆 **(11)____**"
//   "12. **(12)____** 规则"
//   ...
export function buildCiyuPassage(extract: CiyuExtract): string {
  const lines: string[] = [];
  if (extract.wordBank.length > 0) {
    const sorted = [...extract.wordBank].sort((a, b) => a.num - b.num);
    const nums = sorted.map(w => String(w.num));
    const phrases = sorted.map(w => w.phrase);
    lines.push(`| ${nums.join(" | ")} |`);
    lines.push(`|${sorted.map(() => "---").join("|")}|`);
    lines.push(`| ${phrases.join(" | ")} |`);
    lines.push("");
  }
  for (const q of extract.questions) {
    const blank = `**(${q.qNum})________**`;
    const before = q.stemBefore.trim();
    const after = q.stemAfter.trim();
    const body = [before, blank, after].filter(Boolean).join(" ");
    lines.push(`${q.qNum}. ${body}`);
  }
  return lines.join("\n");
}
