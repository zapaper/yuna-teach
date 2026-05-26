// PSLE Chinese composition theme + phrase analysis pipeline.
//
// Stage 1: For each year's Option 2 picture, render the page from
//          the stored PDF and ask Gemini 3.1-pro to describe the
//          scene + likely story setup. Cached to JSON so re-runs
//          skip already-interpreted years.
// Stage 2: Cross-year theme analysis. Feeds all 10 years of (Option
//          1 topic, Option 2 scene + helping words) to one Gemini
//          call and asks for recurring themes with year tags.
// Stage 3: Phrase mining per theme. For each theme, sends the
//          relevant model essays back to Gemini and asks for
//          phrases grouped by purpose (opening, emotion,
//          description, climax, conclusion / moral).
// Stage 4: Final report compiled as a markdown document in the
//          parent folder.
//
// Each stage caches its output to JSON so partial failures or
// iteration on later stages don't re-pay the earlier Gemini calls.

import { promises as fs } from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import { prisma } from "../src/lib/db";
import { renderSinglePage } from "../src/lib/chinese-supplementary";

// PDFs live on Railway's volume; locally we don't have them. Fall
// back to fetching the rendered picture page from the API endpoint
// using the eval cookie when REMOTE_BASE is set (or auto-detected
// from eval/cookie.txt).
const REMOTE_BASE = process.env.COMPO_REMOTE_BASE ?? "https://www.markforyou.com";
async function loadCookie(): Promise<string | null> {
  try {
    return (await fs.readFile(path.join(SCRIPT_DIR, "..", "eval", "cookie.txt"), "utf8")).trim();
  } catch { return null; }
}
async function fetchOption2PageViaApi(rowId: string, cookie: string): Promise<Buffer | null> {
  const url = `${REMOTE_BASE}/api/admin/chinese-oral-compo/${rowId}/option2-picture?type=page`;
  const res = await fetch(url, { headers: { cookie: `yuna_session=${cookie}` } });
  if (!res.ok) {
    console.warn(`  remote fetch ${url} → ${res.status}`);
    return null;
  }
  return Buffer.from(await res.arrayBuffer());
}

const MODEL = "gemini-3.1-pro-preview";
const SCRIPT_DIR = __dirname;
const STAGE1_CACHE = path.join(SCRIPT_DIR, "compo-stage1-interpretations.json");
const STAGE2_CACHE = path.join(SCRIPT_DIR, "compo-stage2-themes.json");
const STAGE3_CACHE = path.join(SCRIPT_DIR, "compo-stage3-phrases.json");
const FINAL_DOC = path.join(SCRIPT_DIR, "..", "..", "PSLE-Chinese-Compo-Analysis.md");

let _ai: GoogleGenAI | null = null;
function ai() {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { timeout: 240000 } });
  return _ai;
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let last: unknown = null;
  for (let i = 1; i <= 3; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const status = (e as { status?: number }).status;
      const retryable = status === 504 || status === 503 || status === 429;
      if (!retryable || i === 3) break;
      const wait = 5000 * i;
      console.warn(`[${label}] ${status} attempt ${i}/3, retrying in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw last;
}

// ───────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────
type CompoRow = {
  year: string;
  pdfPath: string | null;
  compoOption1Topic: string | null;
  compoOption2: { instructions?: string; helpingWords?: string[]; picturePageNum?: number } | null;
  compoOption1Model: string | null;
  compoOption2Model: string | null;
};
type Interpretation = {
  year: string;
  option2Scene: string;            // 2-3 sentence description of the scene
  option2StoryHint: string;        // 1-2 sentence guess at the story arc
};
type Theme = { name: string; description: string; yearsAppeared: Array<{ year: string; option: 1 | 2; note: string }>; frequency: number };
type Themes = { themes: Theme[]; overview: string };
type PhrasesBucket = { opening: string[]; emotion: string[]; description: string[]; climax: string[]; conclusion: string[] };
type ThemePhrases = { themeName: string; phrases: PhrasesBucket; notes: string };

// ───────────────────────────────────────────────────────────────
// Stage 1 — interpret Option 2 pictures
// ───────────────────────────────────────────────────────────────
type LoadedRow = CompoRow & { id: string };
async function loadCompoRows(): Promise<LoadedRow[]> {
  const rows = await prisma.chineseSupplementaryPaper.findMany({
    where: { status: "ready" },
    orderBy: { year: "asc" },
    select: {
      id: true, year: true, pdfPath: true,
      compoOption1Topic: true, compoOption2: true,
      compoOption1Model: true, compoOption2Model: true,
    },
  });
  return rows.map(r => ({ ...r, compoOption2: r.compoOption2 as CompoRow["compoOption2"] }));
}

async function interpretOption2(row: LoadedRow, cookie: string | null): Promise<{ year: string; option2Scene: string; option2StoryHint: string }> {
  const pageNum = row.compoOption2?.picturePageNum;
  if (!pageNum) return { year: row.year, option2Scene: "", option2StoryHint: "" };

  // Prefer local PDF; fall back to remote API fetch when not on disk.
  let pageJpeg: Buffer | null = null;
  if (row.pdfPath) {
    try {
      const pdfBuffer = await fs.readFile(row.pdfPath);
      pageJpeg = await renderSinglePage(pdfBuffer, pageNum, 1600, 85);
    } catch { /* missing local PDF — fall through */ }
  }
  if (!pageJpeg && cookie) {
    pageJpeg = await fetchOption2PageViaApi(row.id, cookie);
  }
  if (!pageJpeg) {
    console.warn(`  no picture source for ${row.year} (no local PDF, no API access)`);
    return { year: row.year, option2Scene: "", option2StoryHint: "" };
  }
  const helpingWords = row.compoOption2?.helpingWords?.join("、") ?? "";

  const res = await withRetry(`interpret-${row.year}`, () => ai().models.generateContent({
    model: MODEL,
    contents: [{
      role: "user",
      parts: [
        { text: `这是 PSLE ${row.year} 年华文试卷一第二题（看图作文）的图片。

附加信息：
- 帮助词汇：${helpingWords || "（无）"}
- 题目指示：${row.compoOption2?.instructions ?? "（未提供）"}

请用简体中文回答：
1. **scene**（场景描述）：用 2-3 句话描述图片中看到的场景、人物、动作。
2. **storyHint**（故事走向）：根据图片 + 帮助词汇，推测这篇作文最可能讲述的故事主线（1-2 句）。

返回严格 JSON：
{ "scene": "…", "storyHint": "…" }` },
        { inlineData: { mimeType: "image/jpeg", data: pageJpeg.toString("base64") } },
      ],
    }],
    config: { temperature: 0.2, responseMimeType: "application/json" },
  }));
  const parsed = JSON.parse(res.text ?? "{}") as { scene?: string; storyHint?: string };
  return {
    year: row.year,
    option2Scene: parsed.scene ?? "",
    option2StoryHint: parsed.storyHint ?? "",
  };
}

async function stage1(rows: LoadedRow[], cookie: string | null): Promise<Interpretation[]> {
  // Load cache, only interpret missing years.
  let cache: Interpretation[] = [];
  try {
    cache = JSON.parse(await fs.readFile(STAGE1_CACHE, "utf8")) as Interpretation[];
  } catch { /* no cache yet */ }
  const cachedYears = new Set(cache.map(c => c.year));
  for (const row of rows) {
    if (cachedYears.has(row.year)) {
      console.log(`[stage1] ${row.year} cached`);
      continue;
    }
    process.stdout.write(`[stage1] interpreting ${row.year}… `);
    const interp = await interpretOption2(row, cookie);
    cache.push(interp);
    await fs.writeFile(STAGE1_CACHE, JSON.stringify(cache, null, 2));
    console.log(`done (scene=${interp.option2Scene.length}ch)`);
  }
  return cache.sort((a, b) => a.year.localeCompare(b.year));
}

// ───────────────────────────────────────────────────────────────
// Stage 2 — cross-year theme analysis
// ───────────────────────────────────────────────────────────────
async function stage2(rows: CompoRow[], interps: Interpretation[]): Promise<Themes> {
  try {
    return JSON.parse(await fs.readFile(STAGE2_CACHE, "utf8")) as Themes;
  } catch { /* miss — compute */ }

  const byYear = new Map(interps.map(i => [i.year, i]));
  const summary = rows.map(r => {
    const i = byYear.get(r.year);
    return `
=== ${r.year} ===
Option 1 题目: ${r.compoOption1Topic ?? "(未提取)"}
Option 2 帮助词: ${r.compoOption2?.helpingWords?.join("、") ?? "(无)"}
Option 2 图片场景: ${i?.option2Scene ?? "(未解读)"}
Option 2 故事走向推测: ${i?.option2StoryHint ?? "(未推测)"}
`.trim();
  }).join("\n\n");

  console.log(`[stage2] running theme analysis...`);
  const res = await withRetry("stage2", () => ai().models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: `以下是过去 10 年（2016-2025）PSLE 华文作文试卷一（第一题 命题作文 + 第二题 看图作文）的题目与图片解读：

${summary}

请进行跨年度主题分析。识别在这些作文题中反复出现的常见主题（例如 友谊、责任、坚持、家庭、诚实、勇气、互相合作 等）。

返回严格 JSON：
{
  "overview": "一段话总结 10 年来 PSLE 华文作文的整体主题倾向、考察重点、与近年是否有偏向某些价值观（≤150 字）",
  "themes": [
    {
      "name": "主题名（中文，例如「友谊」「责任」）",
      "description": "这个主题的核心内涵（≤30 字）",
      "yearsAppeared": [
        { "year": "2019", "option": 1, "note": "题目「我做了正确的决定」涉及为朋友做对的决定" },
        { "year": "2020", "option": 2, "note": "图片展示朋友间分享物品" }
      ],
      "frequency": <int — 涉及此主题的年份-选项数量>
    },
    ...
  ]
}

要求：
- 至少识别 6-10 个清晰的主题，按 frequency 从高到低排序。
- yearsAppeared 中 option 必须是 1 或 2（数字）。
- 主题之间可有重叠（一年-一题可属于多个主题）。
- 同一作文题若同时涉及多个主题，可在多个主题的 yearsAppeared 中出现。
- 不要使用 markdown 代码围栏。` }] }],
    config: { temperature: 0.3, responseMimeType: "application/json" },
  }));
  const themes = JSON.parse(res.text ?? "{}") as Themes;
  await fs.writeFile(STAGE2_CACHE, JSON.stringify(themes, null, 2));
  console.log(`[stage2] done (${themes.themes.length} themes)`);
  return themes;
}

// ───────────────────────────────────────────────────────────────
// Stage 3 — phrase mining per theme
// ───────────────────────────────────────────────────────────────
async function stage3(rows: CompoRow[], themes: Themes): Promise<ThemePhrases[]> {
  let cache: ThemePhrases[] = [];
  try {
    cache = JSON.parse(await fs.readFile(STAGE3_CACHE, "utf8")) as ThemePhrases[];
  } catch { /* miss */ }
  const cachedNames = new Set(cache.map(c => c.themeName));

  const byYear = new Map(rows.map(r => [r.year, r]));

  for (const theme of themes.themes) {
    if (cachedNames.has(theme.name)) {
      console.log(`[stage3] "${theme.name}" cached`);
      continue;
    }
    // Collect model essays for the years where this theme appears.
    const essays: Array<{ year: string; option: number; text: string }> = [];
    for (const yt of theme.yearsAppeared) {
      const row = byYear.get(yt.year);
      if (!row) continue;
      const txt = yt.option === 1 ? row.compoOption1Model : row.compoOption2Model;
      if (txt && txt.trim()) essays.push({ year: yt.year, option: yt.option, text: txt });
    }
    if (essays.length === 0) {
      console.log(`[stage3] "${theme.name}" no essays available — skipping`);
      cache.push({ themeName: theme.name, phrases: { opening: [], emotion: [], description: [], climax: [], conclusion: [] }, notes: "No model essays available for this theme." });
      await fs.writeFile(STAGE3_CACHE, JSON.stringify(cache, null, 2));
      continue;
    }
    process.stdout.write(`[stage3] mining "${theme.name}" (${essays.length} essays)… `);
    const essaysBlob = essays.map(e => `\n--- ${e.year} Option ${e.option} ---\n${e.text}`).join("\n");
    const res = await withRetry(`stage3-${theme.name}`, () => ai().models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: `以下是 PSLE 华文范文中与主题「${theme.name}」（${theme.description}）相关的作文片段。

请从这些范文中提取**实用的高分短语 / 句式 / 词组**，按用途分类。专为 P6 学生考前备考用——背熟这些短语就能在自己的作文中套用。

每个类别提取 5-12 个短语。短语应：
- 长度 4-15 字
- 是可以直接用于作文的「成型」短语，不是单独的形容词
- 优先选择有画面感、有感情色彩、有动作的短语

类别说明：
1. **opening** — 开头句式 / 引入背景的短语
2. **emotion** — 描写情感（喜悦、悲伤、紧张、惭愧、感激等）的短语
3. **description** — 描写动作、场景、人物外貌的短语
4. **climax** — 描写故事高潮、转折、冲突的短语
5. **conclusion** — 总结、点题、感悟、道理的短语（即「moral of story」类）

返回严格 JSON：
{
  "phrases": {
    "opening": ["短语1", "短语2", ...],
    "emotion": [...],
    "description": [...],
    "climax": [...],
    "conclusion": [...]
  },
  "notes": "对这个主题的一两句备考建议（例如：「写这个主题时，开头宜以场景切入，结尾必须扣回主题」≤50 字）"
}

不要使用 markdown 代码围栏。范文如下：
${essaysBlob}` }] }],
      config: { temperature: 0.2, responseMimeType: "application/json" },
    }));
    const parsed = JSON.parse(res.text ?? "{}") as { phrases?: PhrasesBucket; notes?: string };
    cache.push({
      themeName: theme.name,
      phrases: {
        opening: parsed.phrases?.opening ?? [],
        emotion: parsed.phrases?.emotion ?? [],
        description: parsed.phrases?.description ?? [],
        climax: parsed.phrases?.climax ?? [],
        conclusion: parsed.phrases?.conclusion ?? [],
      },
      notes: parsed.notes ?? "",
    });
    await fs.writeFile(STAGE3_CACHE, JSON.stringify(cache, null, 2));
    const total = Object.values(cache[cache.length - 1].phrases).reduce((s, a) => s + a.length, 0);
    console.log(`done (${total} phrases)`);
  }
  return cache;
}

// ───────────────────────────────────────────────────────────────
// Stage 4 — compile final report
// ───────────────────────────────────────────────────────────────
function buildReport(rows: CompoRow[], interps: Interpretation[], themes: Themes, phrases: ThemePhrases[]): string {
  const byYear = new Map(interps.map(i => [i.year, i]));
  const phraseByTheme = new Map(phrases.map(p => [p.themeName, p]));

  const lines: string[] = [];
  lines.push("# PSLE 华文作文 10 年主题与高分短语分析 (2016-2025)");
  lines.push("");
  lines.push("> *基于 10 年 PSLE 华文试卷一（命题作文 + 看图作文）的题目、图片场景解读、与官方范文，由 Gemini 3.1-pro 进行跨年度主题归纳与短语挖掘。专为 P6 学生考前备考使用。*");
  lines.push("");
  lines.push(`*生成时间：${new Date().toISOString().slice(0, 10)}*`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // Year-by-year summary table.
  lines.push("## 一、10 年题目一览");
  lines.push("");
  lines.push("| 年份 | 第一题（命题） | 第二题（看图）场景 |");
  lines.push("|---|---|---|");
  for (const r of rows) {
    const interp = byYear.get(r.year);
    const o1 = (r.compoOption1Topic ?? "—").slice(0, 60);
    const o2 = (interp?.option2Scene ?? "—").slice(0, 80);
    lines.push(`| ${r.year} | ${o1} | ${o2} |`);
  }
  lines.push("");

  // Overview.
  lines.push("## 二、主题倾向总览");
  lines.push("");
  lines.push(`> ${themes.overview}`);
  lines.push("");

  // Theme frequency table.
  lines.push("## 三、常见主题（按出现频率）");
  lines.push("");
  lines.push("| 主题 | 出现次数 | 涉及年份 |");
  lines.push("|---|---|---|");
  for (const t of themes.themes) {
    const years = t.yearsAppeared.map(y => `${y.year}(O${y.option})`).join(", ");
    lines.push(`| **${t.name}** | ${t.frequency} | ${years} |`);
  }
  lines.push("");

  // Per-theme phrases.
  lines.push("## 四、各主题高分短语");
  lines.push("");
  for (const t of themes.themes) {
    const p = phraseByTheme.get(t.name);
    lines.push(`### ${t.name} — ${t.description}`);
    lines.push("");
    if (!p || Object.values(p.phrases).every(a => a.length === 0)) {
      lines.push("*（无范文可挖掘）*");
      lines.push("");
      continue;
    }
    if (p.notes) {
      lines.push(`> 💡 ${p.notes}`);
      lines.push("");
    }
    const sections: Array<[keyof PhrasesBucket, string]> = [
      ["opening", "✏️ 开头句式"],
      ["emotion", "💗 情感描写"],
      ["description", "🖼️ 动作 / 场景描写"],
      ["climax", "⚡ 高潮 / 转折"],
      ["conclusion", "🎯 结尾 / 道理（Moral）"],
    ];
    for (const [key, title] of sections) {
      const list = p.phrases[key];
      if (list.length === 0) continue;
      lines.push(`**${title}**`);
      lines.push("");
      for (const ph of list) lines.push(`- ${ph}`);
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }

  // Methodology.
  lines.push("## 五、方法说明");
  lines.push("");
  lines.push("- **数据来源**：MarkForYou Chinese Oral / Compo 后台已抽取的 10 年 PSLE 华文试卷一数据（含题目、看图作文图片、帮助词、官方范文）。");
  lines.push("- **Stage 1（图片解读）**：每年第二题的图片送入 Gemini 3.1-pro，输出场景描述与故事走向推测。");
  lines.push("- **Stage 2（主题归纳）**：将 10 年的题目 + 帮助词 + 图片解读合并送入 Gemini，识别反复出现的主题。");
  lines.push("- **Stage 3（短语挖掘）**：每个主题对应的范文送入 Gemini，提取开头 / 情感 / 描写 / 高潮 / 结尾五大类高分短语。");
  lines.push("- 所有中间结果缓存在 `scripts/compo-stage{1,2,3}-*.json`，可单独重新生成任一阶段。");
  lines.push("");

  return lines.join("\n");
}

// ───────────────────────────────────────────────────────────────
async function main() {
  const rows = await loadCompoRows();
  console.log(`Loaded ${rows.length} years from DB\n`);
  const cookie = await loadCookie();
  if (cookie) console.log(`Using session cookie from eval/cookie.txt for remote PDF fetches\n`);

  const interps = await stage1(rows, cookie);
  console.log(`Stage 1 done: ${interps.length} interpretations\n`);

  const themes = await stage2(rows, interps);
  console.log(`Stage 2 done: ${themes.themes.length} themes\n`);

  const phrases = await stage3(rows, themes);
  console.log(`Stage 3 done: ${phrases.length} theme-phrase sets\n`);

  const report = buildReport(rows, interps, themes, phrases);
  await fs.writeFile(FINAL_DOC, report);
  console.log(`Wrote ${FINAL_DOC}`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
