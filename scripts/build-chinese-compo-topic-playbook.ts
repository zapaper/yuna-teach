// Build PSLE-Chinese-Compo-Playbook-Safety-Carelessness.docx
// from the existing v2 compo caches. Goal: a printable cheat-sheet a
// P6 student can memorise BEFORE the exam to handle ANY prompt that
// turns out to be about "安全意识" (safety awareness) or "不可粗心大意"
// (don't be careless) — the two morals our analysis says are most
// likely to come up next.
//
// Step 1 (Gemini): take the existing phrase + closing caches and
// produce a topic-specific playbook (openings, scenery, emotions,
// actions, closings, sample 5-paragraph skeletons) for EACH topic.
//
// Step 2 (docx): render to Word.

import "dotenv/config";
import { promises as fs } from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, AlignmentType, BorderStyle,
  ShadingType,
} from "docx";

const SCRIPT_DIR = __dirname;
const V2_PHRASES = path.join(SCRIPT_DIR, "compo-v2-phrases.json");
const V2_CLOSINGS = path.join(SCRIPT_DIR, "compo-v2-closings.json");
const V2_MORALS = path.join(SCRIPT_DIR, "compo-v2-morals.json");
const PLAYBOOK_CACHE = path.join(SCRIPT_DIR, "compo-v2-topic-playbook.json");
const FINAL_DOC = path.join(SCRIPT_DIR, "..", "..", "PSLE-Chinese-Compo-Playbook-Safety-Carelessness.docx");

const MODEL = "gemini-3.1-pro-preview";
const CJK_FONT = "Microsoft YaHei";

let _ai: GoogleGenAI | null = null;
function ai() {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { timeout: 240000 } });
  return _ai;
}

// ───────────────────────────────────────────────────────────────
// Types
// ───────────────────────────────────────────────────────────────
type PhraseGroupCn = { nameCn: string; nameEn: string; phrases: string[] };
type PhraseGroupCnEn = { nameCn: string; nameEn: string; phrases: Array<{ cn: string; en: string }> };
type StoryArc = {
  nameCn: string; nameEn: string;
  paragraphs: Array<{ labelCn: string; labelEn: string; cn: string; en: string }>;
};
type TopicPlaybook = {
  topicCn: string;
  topicEn: string;
  whenToUse: string;
  whenToUseEn: string;
  signalsFromPrompt: { cn: string; en: string }[];      // clues in the prompt that tell you it's this topic
  recommendedOpenings: PhraseGroupCnEn[];
  recommendedSetting: PhraseGroupCnEn[];                 // scenery / weather / atmosphere
  recommendedEmotions: PhraseGroupCnEn[];                // panic, fear, regret …
  recommendedActions: PhraseGroupCnEn[];                 // body-language / verbs
  recommendedClosings: { cn: string; en: string }[];
  storyArcs: StoryArc[];                                 // 2-3 reusable 5-paragraph templates
};
type Output = { topics: TopicPlaybook[] };

// ───────────────────────────────────────────────────────────────
// Stage A — playbook generation (cached)
// ───────────────────────────────────────────────────────────────
async function derivePlaybook(): Promise<Output> {
  try { return JSON.parse(await fs.readFile(PLAYBOOK_CACHE, "utf8")) as Output; } catch { /* miss */ }

  const phrases = JSON.parse(await fs.readFile(V2_PHRASES, "utf8")) as {
    openings: Array<{ nameCn: string; nameEn: string; subgroups: PhraseGroupCn[] }>;
    emotions: Array<{ emotionCn: string; emotionEn: string; phrases: string[] }>;
    sceneryWeather: { nameCn: string; nameEn: string; subgroups: PhraseGroupCn[] };
    actions: { nameCn: string; nameEn: string; subgroups: PhraseGroupCn[] };
  };
  const closings = JSON.parse(await fs.readFile(V2_CLOSINGS, "utf8")) as {
    perMoral: Array<{ moralNameCn: string; closingPhrases: Array<{ cn: string; en: string }> }>;
  };
  const morals = JSON.parse(await fs.readFile(V2_MORALS, "utf8")) as {
    morals: Array<{ nameCn: string; nameEn: string; description: string; yearsAppeared: Array<{ year: string }> }>;
  };

  const safetyClosings = closings.perMoral.find(m => m.moralNameCn === "安全意识")?.closingPhrases ?? [];
  const carelessClosings = closings.perMoral.find(m => m.moralNameCn === "不可粗心大意")?.closingPhrases ?? [];

  const phraseDump = JSON.stringify({ openings: phrases.openings, emotions: phrases.emotions, sceneryWeather: phrases.sceneryWeather, actions: phrases.actions }, null, 0);

  console.log("[playbook] generating safety + carelessness playbooks...");
  const res = await ai().models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: `你是新加坡 PSLE 华文写作教练。我们分析了过去 10 年 PSLE 华文作文，预测明年最可能考的两个主题是「安全意识」和「不可粗心大意」。学生需要一份可以「背了上考场」的速查表 — 不管题目具体是什么，只要触及这两个主题，就能套用。

下面是我们已经从范文里提取出来的高分短语库（按开头/情感/景物/动作分类）:

${phraseDump}

下面是各主题的已知结尾句：
- 安全意识结尾: ${JSON.stringify(safetyClosings)}
- 不可粗心大意结尾: ${JSON.stringify(carelessClosings)}

你的任务：为「安全意识」和「不可粗心大意」分别打造一份**主题速查表 (topic playbook)**。每份速查表必须包含：

1. **whenToUse / whenToUseEn** — 一段话说明这份速查表的覆盖范围（哪些类型的具体题目会触发它）。
2. **signalsFromPrompt** — 3-5 个**题目里出现就基本能确定是这个主题**的关键线索（例如：图里有「红灯」「电单车」「水池」「火警」「过马路」「奔跑追逐」… ）。每条都要中英对照。
3. **recommendedOpenings** — 3-5 个分类好的开头短语桶。从上面的短语库里挑出**最贴合这个主题**的开头，每个短语带英文翻译。每桶 5-8 个短语。
4. **recommendedSetting** — 3-5 个分类好的场景/天气/氛围短语桶。同上。
5. **recommendedEmotions** — 3-5 个情感桶（按 panic, fear, regret, embarrassment 等分类）。同上。
6. **recommendedActions** — 3-5 个动作短语桶（按奔跑、跌倒、惊呼、伸手等分类）。同上。
7. **recommendedClosings** — 直接照搬上面给你的对应主题的结尾句（你可以稍微删减不切题的，但不要重写）。
8. **storyArcs** — **2-3 套五段式作文骨架模板**，每段一句中文一句英文，让学生看了就能改填自己的故事。每段标注「起、承、转、合、悟」。骨架要**通用** — 例如「安全意识」一套可以是「过马路被车撞」、一套可以是「乱碰电器触电」、一套可以是「水池/泳池意外」。

请直接返回严格 JSON（不带 markdown 包装）：
{
  "topics": [
    {
      "topicCn": "安全意识",
      "topicEn": "Safety awareness",
      "whenToUse": "...",
      "whenToUseEn": "...",
      "signalsFromPrompt": [
        { "cn": "图中有红绿灯 / 斑马线 / 公路", "en": "Picture shows traffic lights / zebra crossing / road" },
        ...
      ],
      "recommendedOpenings": [
        { "nameCn": "天气铺垫不祥", "nameEn": "Foreboding weather", "phrases": [{ "cn": "天色阴沉沉的", "en": "The sky was gloomy and overcast" }, ...] }
      ],
      "recommendedSetting": [...],
      "recommendedEmotions": [...],
      "recommendedActions": [...],
      "recommendedClosings": [...],
      "storyArcs": [
        {
          "nameCn": "过马路被车撞",
          "nameEn": "Hit by car at crossing",
          "paragraphs": [
            { "labelCn": "起", "labelEn": "Setup", "cn": "...", "en": "..." },
            { "labelCn": "承", "labelEn": "Rising action", "cn": "...", "en": "..." },
            { "labelCn": "转", "labelEn": "Climax", "cn": "...", "en": "..." },
            { "labelCn": "合", "labelEn": "Resolution", "cn": "...", "en": "..." },
            { "labelCn": "悟", "labelEn": "Reflection", "cn": "...", "en": "..." }
          ]
        }
      ]
    },
    { "topicCn": "不可粗心大意", ... }
  ]
}

要求：所有短语必须带 EN 翻译。每桶 5-8 个短语。storyArcs 每个段落 30-60 字中文 + 流畅英文翻译，**留位置**让学生套自己的细节（用模糊主体名词如 "我的朋友"、"一个陌生人"、"那个东西" 而非具体名字）。` }] }],
    config: { temperature: 0.4, responseMimeType: "application/json", maxOutputTokens: 32768 },
  });
  const parsed = JSON.parse(res.text ?? "{}") as Output;
  await fs.writeFile(PLAYBOOK_CACHE, JSON.stringify(parsed, null, 2));
  console.log(`[playbook] done — ${parsed.topics.length} topic playbooks, ${parsed.topics.reduce((s, t) => s + t.storyArcs.length, 0)} story arcs total`);
  return parsed;
}

// ───────────────────────────────────────────────────────────────
// Stage B — docx
// ───────────────────────────────────────────────────────────────
function t(text: string, opts?: { bold?: boolean; italics?: boolean; size?: number; color?: string }) {
  return new TextRun({
    text, bold: opts?.bold, italics: opts?.italics, size: opts?.size, color: opts?.color,
    font: { name: CJK_FONT, eastAsia: CJK_FONT },
  });
}
function p(text: string, opts?: { heading?: HeadingLevel; before?: number; after?: number; bold?: boolean; italics?: boolean; size?: number; color?: string; align?: typeof AlignmentType[keyof typeof AlignmentType] }) {
  return new Paragraph({
    heading: opts?.heading,
    spacing: { before: opts?.before, after: opts?.after },
    alignment: opts?.align,
    children: [t(text, { bold: opts?.bold, italics: opts?.italics, size: opts?.size, color: opts?.color })],
  });
}
function bullet(text: string, opts?: { size?: number; bold?: boolean; italics?: boolean; color?: string }) {
  return new Paragraph({
    bullet: { level: 0 }, spacing: { before: 30, after: 30 },
    children: [t(text, opts)],
  });
}
function bilingual(cn: string, en: string, opts?: { size?: number }): Paragraph {
  return new Paragraph({
    bullet: { level: 0 }, spacing: { before: 40, after: 40 },
    children: [
      t(cn, { size: opts?.size ?? 22, bold: true }),
      t("  —  ", { color: "9CA3AF", size: opts?.size ?? 22 }),
      t(en, { italics: true, color: "4B5563", size: (opts?.size ?? 22) - 2 }),
    ],
  });
}
function cell(content: string | TextRun[], opts?: { bold?: boolean; size?: number; width?: number; bg?: string; color?: string }) {
  const runs = typeof content === "string" ? [t(content, { bold: opts?.bold, size: opts?.size ?? 20, color: opts?.color })] : content;
  return new TableCell({
    width: opts?.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    margins: { top: 80, bottom: 80, left: 120, right: 120 },
    shading: opts?.bg ? { type: ShadingType.CLEAR, fill: opts.bg, color: "auto" } : undefined,
    children: [new Paragraph({ children: runs })],
  });
}
function tableBorder() {
  return {
    top: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
    left: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
    right: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
    insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "DDDDDD" },
    insideVertical: { style: BorderStyle.SINGLE, size: 4, color: "DDDDDD" },
  };
}

function phraseBucketBlock(group: PhraseGroupCnEn): Paragraph[] {
  const out: Paragraph[] = [];
  out.push(new Paragraph({
    spacing: { before: 100, after: 30 },
    children: [t(group.nameCn, { bold: true, size: 22 }), t(`  (${group.nameEn})`, { italics: true, color: "6B7280", size: 20 })],
  }));
  for (const ph of group.phrases) out.push(bilingual(ph.cn, ph.en));
  return out;
}

function storyArcBlock(arc: StoryArc): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  out.push(new Paragraph({
    spacing: { before: 200, after: 60 },
    children: [t(`📋 ${arc.nameCn}`, { bold: true, size: 26, color: "5B21B6" }), t(`  —  ${arc.nameEn}`, { italics: true, color: "6B7280", size: 20 })],
  }));
  const rows: TableRow[] = [];
  rows.push(new TableRow({
    tableHeader: true,
    children: [
      cell("段落", { bold: true, width: 12, bg: "EDE9FE", size: 18 }),
      cell("中文", { bold: true, width: 48, bg: "EDE9FE", size: 18 }),
      cell("English", { bold: true, width: 40, bg: "EDE9FE", size: 18 }),
    ],
  }));
  for (const para of arc.paragraphs) {
    rows.push(new TableRow({
      children: [
        cell([
          t(para.labelCn, { bold: true, size: 22, color: "5B21B6" }),
          t(`  ${para.labelEn}`, { italics: true, color: "6B7280", size: 18 }),
        ], { bg: "F5F3FF" }),
        cell(para.cn, { size: 22 }),
        cell(para.en, { size: 20, color: "4B5563" }),
      ],
    }));
  }
  out.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: tableBorder(), rows }));
  return out;
}

function topicSection(pb: TopicPlaybook): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  out.push(p(`${pb.topicCn}  ·  ${pb.topicEn}`, { heading: HeadingLevel.HEADING_1, before: 400, after: 120 }));

  // When to use
  out.push(p("📌 这本速查表适用于哪类题目  ·  When to use", { heading: HeadingLevel.HEADING_2, before: 100, after: 40 }));
  out.push(p(pb.whenToUse, { size: 22, after: 40 }));
  out.push(p(pb.whenToUseEn, { italics: true, color: "4B5563", size: 20, after: 80 }));

  // Signals
  out.push(p("🔍 题目里出现这些线索 → 套这本  ·  Prompt signals", { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  for (const s of pb.signalsFromPrompt) out.push(bilingual(s.cn, s.en));

  // Openings
  out.push(p("✨ 推荐开头  ·  Openings", { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  for (const g of pb.recommendedOpenings) out.push(...phraseBucketBlock(g));

  // Setting
  out.push(p("🌫️ 场景 / 氛围  ·  Setting & atmosphere", { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  for (const g of pb.recommendedSetting) out.push(...phraseBucketBlock(g));

  // Emotions
  out.push(p("💢 情绪  ·  Emotions (show-don't-tell)", { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  for (const g of pb.recommendedEmotions) out.push(...phraseBucketBlock(g));

  // Actions
  out.push(p("🏃 动作 / 身体反应  ·  Actions & body language", { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  for (const g of pb.recommendedActions) out.push(...phraseBucketBlock(g));

  // Closings
  out.push(p("🎯 结尾 / 反思  ·  Closings & reflection", { heading: HeadingLevel.HEADING_2, before: 200, after: 40 }));
  for (const c of pb.recommendedClosings) out.push(bilingual(c.cn, c.en));

  // Story arcs
  out.push(p("🧱 五段式骨架（套自己的细节即可）  ·  5-paragraph templates", { heading: HeadingLevel.HEADING_2, before: 240, after: 40 }));
  for (const arc of pb.storyArcs) out.push(...storyArcBlock(arc));

  return out;
}

async function main() {
  const force = process.argv.includes("--force");
  if (force) {
    try { await fs.unlink(PLAYBOOK_CACHE); console.log("[force] removed playbook cache"); } catch { /* miss */ }
  }
  const data = await derivePlaybook();

  const children: (Paragraph | Table)[] = [];

  children.push(p("PSLE 华文作文「主题速查表」", { heading: HeadingLevel.TITLE, align: AlignmentType.CENTER, after: 100 }));
  children.push(p("PSLE Chinese Composition — Topic Playbook", { heading: HeadingLevel.HEADING_2, align: AlignmentType.CENTER, color: "4B5563", after: 200 }));
  children.push(p("两大预测主题：安全意识 + 不可粗心大意  ·  Two predicted topics: Safety awareness + Don't be careless", { italics: true, color: "6B7280", align: AlignmentType.CENTER, after: 400, size: 20 }));

  children.push(p("📖 怎么用这本速查表 · How to use", { heading: HeadingLevel.HEADING_2, before: 100, after: 40 }));
  children.push(p("考试前一周，把每个主题下的「五段式骨架」背两遍——熟记一句一句的中文 + 一句一句的英文，能让你在任何相关题目下快速写出第一段。开头、情绪、动作、结尾的短语桶按需挑——同主题题目都可以套用。", { size: 22, after: 80 }));
  children.push(p("Memorise the 5-paragraph templates for each topic the week before the exam — knowing both Chinese and English versions helps you respond confidently to ANY prompt that touches the theme. Pull from the phrase buckets (openings, emotions, actions, closings) as needed.", { italics: true, color: "4B5563", size: 20, after: 120 }));

  for (const pb of data.topics) {
    children.push(...topicSection(pb));
  }

  const doc = new Document({ sections: [{ children }] });
  const buf = await Packer.toBuffer(doc);
  await fs.writeFile(FINAL_DOC, buf);
  console.log(`Wrote ${FINAL_DOC}`);
}
main().catch(e => { console.error(e); process.exit(1); });
