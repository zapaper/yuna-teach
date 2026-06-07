// PSLE Chinese composition v2 analysis pipeline. Replaces stages
// 2 + 3 of analyze-compo-themes.ts with a finer-grained morals
// classification, cross-essay phrase aggregation, and per-moral
// closing phrases — all with English translations.
//
// Inputs (read-only, from prior pipeline):
//   - DB: ChineseSupplementaryPaper rows for compoOption1Topic,
//     compoOption2, compoOption1Model, compoOption2Model
//   - scripts/compo-stage1-interpretations.json (picture scenes)
//
// Outputs (cached, re-runnable):
//   - scripts/compo-v2-morals.json       — specific morals + English + year hits
//   - scripts/compo-v2-phrases.json      — opening / descriptor / action phrases
//   - scripts/compo-v2-closings.json     — per-moral closing phrases with EN trans
//
// Then build-compo-analysis-v2-docx.ts builds the final Word doc.

import { promises as fs } from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import { prisma } from "../src/lib/db";

const MODEL = "gemini-3.1-pro-preview";
const SCRIPT_DIR = __dirname;
const STAGE1_CACHE = path.join(SCRIPT_DIR, "compo-stage1-interpretations.json");
const V2_MORALS = path.join(SCRIPT_DIR, "compo-v2-morals.json");
const V2_PHRASES = path.join(SCRIPT_DIR, "compo-v2-phrases.json");
const V2_CLOSINGS = path.join(SCRIPT_DIR, "compo-v2-closings.json");
const V2_SENTENCES_PATH = path.join(SCRIPT_DIR, "compo-v2-sentences.json");

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
      if (![504, 503, 429].includes(status as number) || i === 3) break;
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
  compoOption1Topic: string | null;
  compoOption2: { instructions?: string; helpingWords?: string[] } | null;
  compoOption1Model: string | null;
  compoOption2Model: string | null;
};
type Interpretation = { year: string; option2Scene: string; option2StoryHint: string };

type Moral = {
  nameCn: string;            // 中文名 e.g. "孝顺"
  nameEn: string;            // English e.g. "Filial piety"
  description: string;       // 1-line core idea
  yearsAppeared: Array<{ year: string; option: 1 | 2; note: string }>;
  frequency: number;
};
type MoralsOutput = { overview: string; overviewEn?: string; morals: Moral[] };

type EmotionBucket = { emotionCn: string; emotionEn: string; phrases: string[] };
type SubGroup = { nameCn: string; nameEn: string; phrases: string[] };
type GroupedBank = { nameCn: string; nameEn: string; subgroups: SubGroup[] };
type PhrasesOutput = {
  openings: GroupedBank[];            // 2 buckets only: weather + reflection — each with sub-groups
  emotions: EmotionBucket[];          // grouped by specific emotion (already flat)
  sceneryWeather: GroupedBank;        // sub-grouped (sunny / rainy / dawn-dusk / hot-cold)
  actions: GroupedBank;               // sub-grouped (movement / speaking / eating / hand-action / facial)
};
type SentenceExample = {
  boringCn: string;     // generic noun+verb version
  boringEn: string;
  goodCn: string;       // better version using connector/joint phrase
  goodEn: string;
  connectorCn: string;  // substring of goodCn to bold — the key joint phrase
  techniqueCn: string;  // 1-line technique name
  techniqueEn: string;
};
type SentenceVariety = { examples: SentenceExample[] };

type ClosingPhrase = { cn: string; en: string };
type ClosingsForMoral = {
  moralNameCn: string;
  closingPhrases: ClosingPhrase[];
};
type ClosingsOutput = { perMoral: ClosingsForMoral[] };

// ───────────────────────────────────────────────────────────────
// Load DB + cached interpretations
// ───────────────────────────────────────────────────────────────
async function loadRows(): Promise<CompoRow[]> {
  const rows = await prisma.chineseSupplementaryPaper.findMany({
    where: { status: "ready" },
    orderBy: { year: "asc" },
    select: {
      year: true, compoOption1Topic: true, compoOption2: true,
      compoOption1Model: true, compoOption2Model: true,
    },
  });
  return rows.map(r => ({ ...r, compoOption2: r.compoOption2 as CompoRow["compoOption2"] }));
}

async function loadInterpretations(): Promise<Interpretation[]> {
  return JSON.parse(await fs.readFile(STAGE1_CACHE, "utf8")) as Interpretation[];
}

// ───────────────────────────────────────────────────────────────
// Stage A — specific morals classification
// ───────────────────────────────────────────────────────────────
async function deriveMorals(rows: CompoRow[], interps: Interpretation[]): Promise<MoralsOutput> {
  try { return JSON.parse(await fs.readFile(V2_MORALS, "utf8")) as MoralsOutput; } catch { /* miss */ }

  const byYear = new Map(interps.map(i => [i.year, i]));
  const summary = rows.map(r => {
    const i = byYear.get(r.year);
    return `
=== ${r.year} ===
Option 1 题目: ${r.compoOption1Topic ?? "(未提取)"}
Option 2 帮助词: ${r.compoOption2?.helpingWords?.join("、") ?? "(无)"}
Option 2 图片场景: ${i?.option2Scene ?? "(未解读)"}
Option 1 范文片段: ${(r.compoOption1Model ?? "").slice(0, 250)}…
Option 2 范文片段: ${(r.compoOption2Model ?? "").slice(0, 250)}…`.trim();
  }).join("\n\n");

  console.log(`[stage A] morals classification...`);
  const res = await withRetry("morals", () => ai().models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: `以下是 2016-2025 年 PSLE 华文作文试卷一的题目、看图作文场景、与范文片段。

${summary}

请识别每篇作文真正传达的**具体道德 / 教训 / 价值观**，而不是宽泛的「责任与教训」「道德与品格」这种笼统标签。具体的道德例子包括：
- 孝顺 (filial piety)
- 感恩 (gratitude)
- 诚实 (honesty)
- 勇气 (courage)
- 坚持 (perseverance)
- 助人为乐 (joy in helping others)
- 言而有信 (keeping one's word)
- 团结合作 (teamwork)
- 不可粗心大意 (don't be careless)
- 谦虚 (humility)
- 友谊珍贵 (cherishing friendship)
- 自私的代价 (the cost of selfishness)
- 安全意识 (safety awareness)
... 等等

**关键要求：**
1. 主题颗粒度要够细 — 12-18 个具体道德。即使某个道德只出现 1 次也要单独列出（例如「诚实」如果某年范文里有撒谎/坦白情节，应单列；「宽容」如果范文里有「原谅」「谅解」情节，应单列）。**目的是让明年的预测有据可循。**
2. 每个主题必须有清晰的中英文名
3. 同一年同一题可以涉及多个具体道德（例如「我感谢我的朋友」可以同时归于「感恩」+「友谊珍贵」）
4. 描述 ≤ 25 字，说清这个道德的具体含义
5. 即使是次要 / 衬托主题（不是该篇主旨）也要包含进去，只要它清晰出现在题目 / 帮助词 / 范文中

返回严格 JSON：
{
  "overview": "中文一段话 (≤220 字) 总结：10 年来 PSLE 反复出现哪些具体道德、考察重点。**重要规则：明年预测必须只引用上面列出的主题，且必须在括号中点出依据年份**（例如「2021、2024 都出现过宽容主题」）。如果某个主题完全没出现在过去 10 年，不要预测它。",
  "overviewEn": "English summary (≤180 words) mirroring the Chinese overview. Same prediction rules: only predict morals that have actually appeared in the data, and cite the supporting years in parentheses.",
  "morals": [
    {
      "nameCn": "孝顺",
      "nameEn": "Filial piety",
      "description": "对父母祖辈表达关怀、感激与尊敬",
      "yearsAppeared": [
        { "year": "2019", "option": 1, "note": "范文中表达对妈妈的感激" },
        { "year": "2021", "option": 2, "note": "图片展现对外婆的关心" }
      ],
      "frequency": 2
    },
    ...
  ]
}

按 frequency 从高到低排序。不要使用 markdown 代码围栏。` }] }],
    config: { temperature: 0.3, responseMimeType: "application/json" },
  }));
  const parsed = JSON.parse(res.text ?? "{}") as MoralsOutput;
  await fs.writeFile(V2_MORALS, JSON.stringify(parsed, null, 2));
  console.log(`[stage A] done — ${parsed.morals.length} specific morals`);
  return parsed;
}

// ───────────────────────────────────────────────────────────────
// Stage B — cross-essay phrase aggregation
// ───────────────────────────────────────────────────────────────
async function aggregatePhrases(rows: CompoRow[]): Promise<PhrasesOutput> {
  try { return JSON.parse(await fs.readFile(V2_PHRASES, "utf8")) as PhrasesOutput; } catch { /* miss */ }

  const allEssays: string[] = [];
  for (const r of rows) {
    if (r.compoOption1Model) allEssays.push(`--- ${r.year} 第一题 ---\n${r.compoOption1Model}`);
    if (r.compoOption2Model) allEssays.push(`--- ${r.year} 第二题 ---\n${r.compoOption2Model}`);
  }

  console.log(`[stage B] cross-essay phrase aggregation (${allEssays.length} essays)...`);
  const res = await withRetry("phrases", () => ai().models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: `以下是 PSLE 华文 10 年的作文范文（约 ${allEssays.length} 篇）。请从所有范文中**汇总**实用的高分短语，**不限于某一年某一篇**——汇总越广越好，方便学生套用。

每个 sub-group 至少 6-10 个短语，短语长度 4-15 字，优先选有画面感、动作感、感情色彩的成型短语。

返回严格 JSON：
{
  "openings": [
    {
      "nameCn": "天气 / 景物开头",
      "nameEn": "Weather / scenery opening",
      "subgroups": [
        { "nameCn": "晴天", "nameEn": "Sunny", "phrases": ["阳光明媚的早晨", "万里无云的下午", ...] },
        { "nameCn": "雨天", "nameEn": "Rainy / stormy", "phrases": [...] },
        { "nameCn": "清晨 / 黄昏", "nameEn": "Dawn / Dusk", "phrases": [...] },
        { "nameCn": "节日 / 季节", "nameEn": "Holiday / season", "phrases": [...] }
      ]
    },
    {
      "nameCn": "倒叙 / 感慨 开头",
      "nameEn": "Flashback / Reflective opening",
      "subgroups": [
        { "nameCn": "时光飞逝感", "nameEn": "Time flies / nostalgia", "phrases": ["时光匆匆", "转眼间", "一晃眼", ...] },
        { "nameCn": "生动回忆", "nameEn": "Vivid recount", "phrases": ["至今我还记得", "每当我想起", "那一幕至今历历在目", ...] },
        { "nameCn": "感慨 / 设问", "nameEn": "Reflection / rhetorical question", "phrases": ["难道这就是...", "谁能想到...", ...] }
      ]
    }
  ],
  "emotions": [
    { "emotionCn": "愤怒", "emotionEn": "Anger", "phrases": ["怒火中烧", "火冒三丈", ...] },
    { "emotionCn": "悲伤", "emotionEn": "Sadness", "phrases": [...] },
    { "emotionCn": "喜悦", "emotionEn": "Joy", "phrases": [...] },
    { "emotionCn": "紧张 / 害怕", "emotionEn": "Nervous / Fear", "phrases": [...] },
    { "emotionCn": "惭愧 / 后悔", "emotionEn": "Shame / Regret", "phrases": [...] },
    { "emotionCn": "感激", "emotionEn": "Gratitude", "phrases": [...] },
    { "emotionCn": "惊讶", "emotionEn": "Surprise", "phrases": [...] }
  ],
  "sceneryWeather": {
    "nameCn": "景物 / 天气",
    "nameEn": "Scenery / Weather",
    "subgroups": [
      { "nameCn": "晴朗 / 阳光", "nameEn": "Sunny / bright", "phrases": [...] },
      { "nameCn": "阴雨 / 风暴", "nameEn": "Rainy / stormy", "phrases": [...] },
      { "nameCn": "炎热", "nameEn": "Hot", "phrases": [...] },
      { "nameCn": "寒冷 / 清凉", "nameEn": "Cold / cool", "phrases": [...] },
      { "nameCn": "夜晚 / 星空", "nameEn": "Night / starry", "phrases": [...] }
    ]
  },
  "actions": {
    "nameCn": "动作",
    "nameEn": "Action verbs",
    "subgroups": [
      { "nameCn": "跑 / 走 / 移动", "nameEn": "Run / walk / move", "phrases": ["飞快地跑过去", "踉踉跄跄地走", ...] },
      { "nameCn": "说话 / 喊叫", "nameEn": "Speak / shout", "phrases": ["气喘吁吁地说", "声嘶力竭地喊", ...] },
      { "nameCn": "看 / 望", "nameEn": "Look / gaze", "phrases": [...] },
      { "nameCn": "手部动作", "nameEn": "Hand actions", "phrases": ["猛地推开门", "紧紧抓住", ...] },
      { "nameCn": "面部表情 / 笑哭", "nameEn": "Facial / laugh-cry", "phrases": [...] }
    ]
  }
}

规则：
- 每个 sub-group **必须有英文翻译标签 (nameEn)**
- 如果范文里没有某 sub-group 的素材，可以省略该 sub-group（但不要返回空数组）
- 不要使用 markdown 代码围栏

范文：
${allEssays.join("\n\n")}` }] }],
    config: { temperature: 0.2, responseMimeType: "application/json" },
  }));
  const parsed = JSON.parse(res.text ?? "{}") as PhrasesOutput;
  await fs.writeFile(V2_PHRASES, JSON.stringify(parsed, null, 2));
  const sgCount = (b: GroupedBank | undefined) => (b?.subgroups ?? []).reduce((s, sg) => s + sg.phrases.length, 0);
  const totalPhrases =
    (parsed.openings ?? []).reduce((s, b) => s + sgCount(b), 0) +
    (parsed.emotions ?? []).reduce((s, b) => s + b.phrases.length, 0) +
    sgCount(parsed.sceneryWeather) + sgCount(parsed.actions);
  console.log(`[stage B] done — ${totalPhrases} phrases across ${parsed.openings?.length ?? 0} opening + ${parsed.emotions?.length ?? 0} emotion buckets, plus scenery/actions sub-groups`);
  return parsed;
}

// ───────────────────────────────────────────────────────────────
// Stage C — per-moral closing phrases with English translations
// ───────────────────────────────────────────────────────────────
async function mineClosings(rows: CompoRow[], morals: MoralsOutput): Promise<ClosingsOutput> {
  let cache: ClosingsOutput;
  try {
    cache = JSON.parse(await fs.readFile(V2_CLOSINGS, "utf8")) as ClosingsOutput;
  } catch {
    cache = { perMoral: [] };
  }
  const cachedNames = new Set(cache.perMoral.map(c => c.moralNameCn));

  const byYear = new Map(rows.map(r => [r.year, r]));

  for (const moral of morals.morals) {
    if (cachedNames.has(moral.nameCn)) {
      console.log(`[stage C] "${moral.nameCn}" cached`);
      continue;
    }
    const essays: string[] = [];
    for (const yt of moral.yearsAppeared) {
      const row = byYear.get(yt.year);
      if (!row) continue;
      const txt = yt.option === 1 ? row.compoOption1Model : row.compoOption2Model;
      if (txt) essays.push(`--- ${yt.year} 第${yt.option === 1 ? "一" : "二"}题 ---\n${txt}`);
    }
    if (essays.length === 0) {
      cache.perMoral.push({ moralNameCn: moral.nameCn, closingPhrases: [] });
      await fs.writeFile(V2_CLOSINGS, JSON.stringify(cache, null, 2));
      continue;
    }
    process.stdout.write(`[stage C] mining closings for "${moral.nameCn}" (${moral.nameEn})… `);
    const res = await withRetry(`closing-${moral.nameCn}`, () => ai().models.generateContent({
      model: MODEL,
      contents: [{ role: "user", parts: [{ text: `以下是 PSLE 华文范文中体现「${moral.nameCn}」(${moral.nameEn} — ${moral.description}) 这个道德主题的作文片段。

请提取 5-12 个适合作为**作文结尾点题 / 道理感悟**的句子或短语。每个都要附上准确流畅的英文翻译（专为帮助学生理解短语含义、向英文老师 / 家长解释用）。

要求：
- 中文短语长度 5-20 字
- 选最能直接套用到学生作文结尾的句子
- 避免太过哲学 / 抽象 — 要 P6 学生能理解

返回严格 JSON：
{
  "closingPhrases": [
    { "cn": "做人不能忘恩负义", "en": "One must never be ungrateful" },
    { "cn": "父母的爱是我们一辈子的财富", "en": "Our parents' love is a lifelong treasure" },
    ...
  ]
}

不要使用 markdown 代码围栏。范文：
${essays.join("\n\n")}` }] }],
      config: { temperature: 0.2, responseMimeType: "application/json" },
    }));
    const parsed = JSON.parse(res.text ?? "{}") as { closingPhrases: ClosingPhrase[] };
    cache.perMoral.push({ moralNameCn: moral.nameCn, closingPhrases: parsed.closingPhrases ?? [] });
    await fs.writeFile(V2_CLOSINGS, JSON.stringify(cache, null, 2));
    console.log(`done (${parsed.closingPhrases?.length ?? 0} phrases)`);
  }
  return cache;
}

// ───────────────────────────────────────────────────────────────
// Stage D — sentence variety examples
// ───────────────────────────────────────────────────────────────
// Show 5-6 boring vs. interesting sentence pairs. Each interesting
// version starts with a connector / joint phrase that turns a flat
// noun+verb construction into a more textured one. The connector
// substring is returned separately so the docx renderer can bold it.
async function deriveSentenceVariety(rows: CompoRow[]): Promise<SentenceVariety> {
  try { return JSON.parse(await fs.readFile(V2_SENTENCES_PATH, "utf8")) as SentenceVariety; } catch { /* miss */ }

  const essays = rows
    .flatMap(r => [r.compoOption1Model, r.compoOption2Model].filter((x): x is string => !!x))
    .join("\n\n--- next essay ---\n\n");

  console.log(`[stage D] sentence variety examples...`);
  const res = await withRetry("sentences", () => ai().models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: `以下是 PSLE 华文范文。请帮 P6 学生整理 5-6 个**句首变化**的范例 — 教他们不要总是「名词 + 动词」开头，可以用**关联词或衔接短语**让句子更有变化。

每个例子要展示「乏味写法」vs「有变化的写法」，并附上英文翻译方便家长讨论。

返回严格 JSON：
{
  "examples": [
    {
      "boringCn": "我很紧张。我走进考场。",
      "boringEn": "I was nervous. I walked into the exam hall.",
      "goodCn": "尽管我心里七上八下，我还是硬着头皮走进了考场。",
      "goodEn": "Although my heart was pounding, I forced myself to walk into the exam hall.",
      "connectorCn": "尽管……我还是",
      "techniqueCn": "用「尽管 …… 还是 ……」让步关联词开头",
      "techniqueEn": "Open with the concessive connector 尽管/还是 ('although/still')"
    },
    {
      "boringCn": "妈妈走进厨房。她开始做饭。",
      "boringEn": "Mum went into the kitchen. She started cooking.",
      "goodCn": "一进厨房，妈妈就立刻系上围裙，麻利地开始准备晚餐。",
      "goodEn": "The moment she stepped into the kitchen, Mum tied on her apron and briskly started preparing dinner.",
      "connectorCn": "一……就……",
      "techniqueCn": "用「一 …… 就 ……」表示动作紧接的关联词",
      "techniqueEn": "Use the 一/就 ('as soon as / immediately') pair to chain actions"
    },
    ...
  ]
}

要求：
- 5-6 个例子，每个使用**不同的**关联词 / 衔接技巧（避免重复）
- 优先选 P6 学生容易记的：尽管/还是、一/就、不仅/还、虽然/但是、每当/总会、当 …… 时、直到 …… 才、要不是 …… 就、自从 …… 以后……
- "connectorCn" 必须是 "goodCn" 里的真实子串（或最关键的关联词主词），用来标粗
- 不要使用 markdown 代码围栏

参考范文：
${essays.slice(0, 8000)}` }] }],
    config: { temperature: 0.3, responseMimeType: "application/json" },
  }));
  const parsed = JSON.parse(res.text ?? "{}") as SentenceVariety;
  await fs.writeFile(V2_SENTENCES_PATH, JSON.stringify(parsed, null, 2));
  console.log(`[stage D] done — ${parsed.examples?.length ?? 0} sentence pairs`);
  return parsed;
}

// ───────────────────────────────────────────────────────────────
async function main() {
  const rows = await loadRows();
  const interps = await loadInterpretations();
  console.log(`Loaded ${rows.length} years + ${interps.length} interpretations\n`);

  const morals = await deriveMorals(rows, interps);
  console.log(`Stage A done: ${morals.morals.length} morals\n`);

  const phrases = await aggregatePhrases(rows);
  console.log(`Stage B done\n`);

  const closings = await mineClosings(rows, morals);
  console.log(`Stage C done: ${closings.perMoral.length} moral closings\n`);

  const sentences = await deriveSentenceVariety(rows);
  console.log(`Stage D done: ${sentences.examples?.length ?? 0} sentence pairs\n`);

  console.log(`All v2 caches written. Run build-compo-analysis-v2-docx.ts to generate the Word doc.`);
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
