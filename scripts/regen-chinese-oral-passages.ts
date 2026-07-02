// scripts/regen-chinese-oral-passages.ts
//
// Generate PSLE 朗读 passages for each Chinese oral theme. Two-stage:
//   1. Pull PSLE Chinese composition MODEL essays from the DB as
//      style / register anchors (12-year-old primary school voice
//      that matches the PSLE marking standard).
//   2. Ask Gemini to compose a ~200-260 character 朗读 passage per
//      theme in that voice — comparable reading time to the English
//      module's ~170-word passages (measured on the DB, all sit at
//      ~170 words / 980 chars). Follows the "引入句 → 现象/例子 →
//      反思 → 呼吁" arc used in the one authentic sample we have
//      (2022_2 screen time — kept as-is, not regenerated).
//
// Writes back into src/lib/oral-themes-zh.ts by regex-replacing each
// theme's `passage: "TODO..."` line. Themes with an authentic
// passage (passageAuthentic: true) are skipped.
//
// Usage:
//   npx tsx scripts/regen-chinese-oral-passages.ts
//   npx tsx scripts/regen-chinese-oral-passages.ts --theme 2025_1
//   npx tsx scripts/regen-chinese-oral-passages.ts --dry-run

import "dotenv/config";
import { promises as fs } from "fs";
import path from "path";
import { GoogleGenAI, Type } from "@google/genai";
import { prisma } from "../src/lib/db";
import { ORAL_THEMES_ZH } from "../src/lib/oral-themes-zh";

const MODEL = "gemini-3.1-pro-preview";
const TARGET_FILE = path.join(process.cwd(), "src/lib/oral-themes-zh.ts");

const themeIdx = process.argv.indexOf("--theme");
const THEME_FILTER = themeIdx >= 0 ? process.argv[themeIdx + 1] : null;
const DRY_RUN = process.argv.includes("--dry-run");

const PASSAGE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    passage: {
      type: Type.STRING,
      description: "The 朗读 passage in Simplified Chinese, 200-260 characters (about the same reading time as a PSLE English oral passage of ~170 words). NO speech marks, NO parenthetical hints, just the passage text as it would be read aloud.",
    },
  },
  required: ["passage"],
} as const;

async function fetchStyleAnchor(): Promise<string> {
  const rows = await prisma.chineseSupplementaryPaper.findMany({
    where: {
      OR: [
        { compoOption1Model: { not: null } },
        { compoOption2Model: { not: null } },
      ],
    },
    orderBy: { year: "desc" },
    take: 3,
    select: { year: true, compoOption1Model: true, compoOption2Model: true },
  });
  const samples: string[] = [];
  for (const r of rows) {
    if (r.compoOption1Model) samples.push(`【${r.year} 作文范文一】\n${r.compoOption1Model.slice(0, 300)}`);
    if (r.compoOption2Model) samples.push(`【${r.year} 作文范文二】\n${r.compoOption2Model.slice(0, 300)}`);
  }
  return samples.join("\n\n");
}

async function generatePassage(
  ai: GoogleGenAI,
  theme: typeof ORAL_THEMES_ZH[number],
  styleAnchor: string,
): Promise<string> {
  const prompt = `你是一位新加坡小学华文老师,正在为小学六年级的学生编写 PSLE 朗读段落。

【朗读段落的规范】
- 长度:200 到 260 字之间(简体中文,朗读时间约一分钟,和 PSLE 英文朗读段落长度相当)。
- 语言:小学高年级学生能读懂的书面语,不用生僻字。
- 结构:一句引入 → 描述现象或举一个具体例子 → 简短反思 → 一句呼吁或总结。
- 风格:以下是从新加坡 PSLE 华文范文中选出的样本(可作为语言风格与用词水平的参考,不要抄写内容):

${styleAnchor}

【本次要写的主题】
主题标签:${theme.theme}
情境描述:${theme.blurb}
简介:${theme.prompts.describe}

请为这个主题编写一段合适的 PSLE 朗读段落。字数要严格控制在 200-260 字之间。不要用引号、括号、注释,直接给我朗读的原文即可。段落要能自然衔接、有起承转合,让 12 岁的孩子读起来通顺、抑扬有度。`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      responseMimeType: "application/json",
      responseSchema: PASSAGE_SCHEMA,
      temperature: 0.6,
    },
  });
  const text = response.text;
  if (!text) throw new Error("empty response");
  const { passage } = JSON.parse(text) as { passage: string };
  // Normalise whitespace inside the passage — collapse newlines to
  // single spaces, trim ends. PSLE 朗读 passages are single-paragraph.
  return passage.replace(/\s+/g, "").trim();
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  const ai = new GoogleGenAI({ apiKey });

  console.log("Fetching PSLE model-composition style anchor from DB…");
  const styleAnchor = await fetchStyleAnchor();
  console.log(`  Loaded ${styleAnchor.split("【").length - 1} samples (${styleAnchor.length} chars total).\n`);

  let source = await fs.readFile(TARGET_FILE, "utf-8");
  let done = 0, skipped = 0, failed = 0;

  for (const theme of ORAL_THEMES_ZH) {
    if (THEME_FILTER && theme.id !== THEME_FILTER) { skipped++; continue; }
    if (theme.passageAuthentic) {
      console.log(`  ${theme.id} SKIP (authentic passage already in place: ${theme.theme})`);
      skipped++;
      continue;
    }
    try {
      console.log(`  ${theme.id} ${theme.theme} — generating…`);
      const passage = await generatePassage(ai, theme, styleAnchor);
      console.log(`    (${passage.length} chars) ${passage.slice(0, 60)}…`);

      if (!DRY_RUN) {
        // Replace this theme's TODO passage line. Use a regex that
        // finds the theme's block start + the passage line within.
        // The passage line looks like:
        //   passage: "TODO: passage on ...",
        // We match the FULL passage value (could be multi-line if the
        // TS file was ever hand-edited) but our current file always
        // has it on one line as a single string literal.
        const escapedId = theme.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Look for the block starting with the theme id, then grab the
        // first `passage:` value in the same block, replace only that.
        const blockRegex = new RegExp(
          `(id:\\s*"${escapedId}"[\\s\\S]*?passage:\\s*)"(?:[^"\\\\]|\\\\.)*"`,
          "m",
        );
        const escapedPassage = passage
          .replace(/\\/g, "\\\\")
          .replace(/"/g, '\\"');
        const before = source;
        source = source.replace(blockRegex, `$1"${escapedPassage}"`);
        if (source === before) {
          console.log(`    WARN: regex didn't match for ${theme.id} — passage NOT overwritten`);
          failed++;
          continue;
        }
      }
      done++;
    } catch (e) {
      console.log(`  ${theme.id} FAIL: ${(e as Error).message.slice(0, 150)}`);
      failed++;
    }
  }

  if (!DRY_RUN && done > 0) {
    await fs.writeFile(TARGET_FILE, source, "utf-8");
    console.log(`\nWrote ${done} passage(s) to ${path.relative(process.cwd(), TARGET_FILE)}`);
  }
  console.log(`\nSummary: ${done} ok, ${skipped} skipped, ${failed} failed${DRY_RUN ? " [DRY-RUN — file unchanged]" : ""}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
