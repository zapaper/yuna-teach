// Chinese composition marker — admin-side pipeline.
//
// One entry point: `analyseCompoAttempt(attemptId)`. It runs the four
// pipeline stages in order, persisting partial results so a re-run
// can resume:
//   1. OCR     — read the scanned composition (and the question
//                scan if provided) into clean text.
//   2. Wrong words — flag stroke errors, meaning errors, and
//                near-synonym misuses.
//   3. Critique — score against the PSLE 40-mark rubric
//                (内容 20 / Vocabulary & Phrases 10 / Sentence
//                Structure & Organization 10), benchmarked against
//                the 10 years of model essays in
//                ChineseSupplementaryPaper.
//   4. Recommend — structural pieces missing + 3-5 language
//                upgrades drawn from the playbook (universal
//                openings / closings + theme-specific banks).
//
// Best model for Chinese text: gemini-3.1-pro-preview. We pin to it
// and let the existing fallback chain (in gemini.ts) cover transient
// flakiness — same chain marking uses.

import fs from "fs/promises";
import path from "path";
import { prisma } from "@/lib/db";
import { generateContentWithRetry } from "@/lib/gemini";
import playbookJson from "@/data/chinese-compo/playbook.json";
import featuredJson from "@/data/chinese-compo/featured.json";

// Robust JSON extraction. Gemini occasionally appends a stray trailing
// paragraph after the JSON object — e.g. a model essay snippet or a
// "希望对你有帮助" sign-off — which trips `JSON.parse` with
// "Unexpected non-whitespace character after JSON at position N".
// We slice only the balanced outer object / array.
function extractJson(raw: string): string {
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
  const braceAt = cleaned.indexOf("{");
  const bracketAt = cleaned.indexOf("[");
  const start =
    braceAt < 0 ? bracketAt :
    bracketAt < 0 ? braceAt :
    Math.min(braceAt, bracketAt);
  if (start < 0) return cleaned;
  const open = cleaned[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (escaped) { escaped = false; continue; }
    if (c === "\\") { escaped = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return cleaned;
}

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
export const COMPO_DIR = path.join(VOLUME_PATH, "compo");

const OCR_MODEL = "gemini-3.1-pro-preview";
const ANALYSIS_MODEL = "gemini-3.1-pro-preview";

type PlaybookBucket = "opening" | "closing" | "accident" | "careless" |
  "transition" | "emotion" | "scenery" | "action" | "moral" | "other";

export type WrongWord = {
  original: string;
  suggestion: string;
  kind: "stroke" | "meaning" | "misuse" | "omission";
  reason: string;
};

// One full PSLE-style rubric breakdown (3 axes + total + why).
// Used for the as-submitted critique, the clean-rewrite projection,
// and the elevated-draft self-assessment so the UI can swap which
// breakdown is shown based on the active composition view.
export type RubricBreakdown = {
  contentScore: number;        // 0..20
  contentNotes: string;
  contentNotesEn: string;
  vocabScore: number;          // 0..10
  vocabNotes: string;
  vocabNotesEn: string;
  sentenceScore: number;       // 0..10
  sentenceNotes: string;
  sentenceNotesEn: string;
  overallScore: number;        // sum of the three
  // What changed from the as-submitted score — 1-2 sentences each.
  // Empty for the original critique (no delta to explain).
  whyChanged?: string;
  whyChangedEn?: string;
};

export type Critique = RubricBreakdown & {
  // Original-only fields.
  overallSummary: string;
  overallSummaryEn: string;
  // Clean rewrite = same essay with only wrong-word / omission fixes
  // applied. Full rubric breakdown so the side panel can swap when
  // the user toggles the Clean view.
  cleanRewrite?: RubricBreakdown;
  // Legacy aggregate kept for older rows that pre-date cleanRewrite.
  cleanRewriteScore?: number;
  benchmarkYears: string[];
};

export type Recommendations = {
  structural: Array<{
    piece: string;
    pieceEn: string;
    issue: string;
    issueEn: string;
    suggestion: string;
    suggestionEn: string;
    exampleFromModel?: { year: string; snippet: string; bucket: string };
  }>;
  language: Array<{
    phraseCn: string;
    phraseEn?: string;
    fromYear?: string;
    bucket: PlaybookBucket | string;
    whyItHelps: string;
  }>;
  // Stage 5 output — a 35-40-range rewrite anchored to the kid's
  // original draft. Plot is kept; surgical upgrades only (wrong-word
  // fixes, idiom + 好句 substitutions, opening hook, transitions,
  // climax intensification, ending moral).
  elevatedDraft?: string;
  elevatedDraftScore?: number; // self-assessed score of the elevated draft (legacy aggregate)
  // Full rubric breakdown for the elevated draft, so the side panel
  // can swap to it when the user is viewing the Elevated tab.
  elevatedDraftRubric?: RubricBreakdown;
};

// ─── OCR ─────────────────────────────────────────────────────────────

async function readFileForGemini(relPath: string): Promise<{ data: string; mimeType: string }> {
  const abs = path.join(COMPO_DIR, relPath);
  const buf = await fs.readFile(abs);
  const ext = path.extname(relPath).toLowerCase();
  // Gemini inlineData accepts image/* AND application/pdf. A user can
  // upload either a multi-page PDF (single file) or one image per page.
  const mimeType =
    ext === ".pdf"  ? "application/pdf" :
    ext === ".png"  ? "image/png"       :
    ext === ".webp" ? "image/webp"      :
                      "image/jpeg";
  return { data: buf.toString("base64"), mimeType };
}

// For text-bearing formats (.txt / .docx), pull plain text directly
// so the OCR Gemini call can be skipped. .docx uses mammoth (handles
// modern Word; older .doc not supported — kid would need to convert).
async function readTextDirectly(relPath: string): Promise<string | null> {
  const abs = path.join(COMPO_DIR, relPath);
  const ext = path.extname(relPath).toLowerCase();
  if (ext === ".txt") {
    return (await fs.readFile(abs, "utf8")).trim();
  }
  if (ext === ".docx") {
    const mammoth = (await import("mammoth")) as unknown as {
      extractRawText: (opts: { path: string }) => Promise<{ value: string }>;
    };
    const { value } = await mammoth.extractRawText({ path: abs });
    return value.trim();
  }
  return null;
}

const OCR_PROMPT_BODY = `你正在从扫描的手写小学华文作文中提取文字。

【任务】
1. 按段落顺序，把学生手写的所有文字转录成简体中文 (即原文是简体就用简体；原文是繁体也转成简体)。
2. 标点符号 (，。！？""''「」《》)请保留并用全角。
3. 段落之间用一个空行分隔。不要加任何标题，也不要加 "学生写道:" 这类元信息。
4. 如果某字看不清，先写一个最接近的猜测字，并在该字后用 "[?]" 标记，例如 "他很高[?]兴"。
5. 不要纠正错别字 — 学生原文里写的错字必须保留下来 (后续步骤会处理)。
6. 不要补充任何学生没写的字。

【手写常见误读 — 必查】
小学生手写体中，这些容易被 OCR 看错。看到候选 "数字 / 拉丁字母" 出现在中文句子里时，先想想它是不是其实是这些汉字:
- **"3" → "了"**: 句末或动词后出现 "3" 几乎一定是 "了"。例 "他走3" → "他走了"。
- "1" / "l" / "I" → "一" (横笔)
- "0" → "口" 或 "○"
- 中文夹杂的孤立拉丁字母通常是 OCR 误读，回去再看一次原图。

字形相近的汉字也容易混 (请按上下文判断):
- 已 / 己 / 巳     · 末 / 未     · 戍 / 戌 / 戊
- 干 / 千 / 于     · 八 / 入 / 人     · 太 / 大 / 犬
- 自 / 白          · 日 / 目          · 土 / 士

只输出转录的作文正文 (含段落分隔)，不要 markdown 包围、不要解释。`;

const OCR_QUESTION_PROMPT_BODY = `你正在从扫描的小学华文 PSLE Paper 1 写作题目中提取信息。

【任务】
转录题目说明、所有题目选项的标题、以及（如果有的话）看图作文的图片提示词。

输出格式（纯文本）：
说明：<说明全文>

题目一：<标题>
题目二：<标题>
（若有更多题目继续列出）

看图作文图片提示词：
- <提示词1>
- <提示词2>
...

如果某些信息缺失，直接省略对应的段落，不要写 "无" 或 "N/A"。只输出转录文本，不要 markdown 包围。`;

export async function runOcr(
  compositionImagePaths: string[],
  questionImagePath: string | null,
): Promise<{ ocrText: string; ocrQuestionText: string | null }> {
  // Fast path — if every composition file is a text-bearing format
  // (.txt or .docx), skip the OCR Gemini call entirely. The kid
  // typed the composition; there's nothing for the model to OCR.
  const textParts: string[] = [];
  let allTextOnly = compositionImagePaths.length > 0;
  for (const p of compositionImagePaths) {
    const t = await readTextDirectly(p);
    if (t === null) { allTextOnly = false; break; }
    textParts.push(t);
  }
  let ocrText: string;
  if (allTextOnly) {
    ocrText = textParts.join("\n\n").trim();
    console.log(`[compo:ocr] text-only fast path: skipped Gemini, ${ocrText.length} chars from ${compositionImagePaths.length} file(s)`);
  } else {
    // Compose all composition pages into one Gemini call so the model
    // can stitch paragraph breaks across page boundaries.
    const compParts: Array<{ inlineData: { mimeType: string; data: string } } | { text: string }> = [];
    let totalBytes = 0;
    for (const p of compositionImagePaths) {
      const img = await readFileForGemini(p);
      totalBytes += Math.ceil(img.data.length * 0.75); // base64 -> bytes
      console.log(`[compo:ocr] read ${p} (${img.mimeType}, ~${(totalBytes / 1024).toFixed(0)}KB cumulative)`);
      compParts.push({ inlineData: img });
    }
    compParts.push({ text: OCR_PROMPT_BODY });

    console.log(`[compo:ocr] calling ${OCR_MODEL} with ${compositionImagePaths.length} part(s), ~${(totalBytes / 1024).toFixed(0)}KB...`);
    const ocrStart = Date.now();
    const ocrResp = await generateContentWithRetry({
      model: OCR_MODEL,
      contents: [{ role: "user", parts: compParts }],
      config: { temperature: 0 },
    }, 2, 5000, "compo-ocr");
    ocrText = (ocrResp.text ?? "").trim();
    console.log(`[compo:ocr] composition done in ${((Date.now() - ocrStart) / 1000).toFixed(1)}s, ${ocrText.length} chars`);
  }

  let ocrQuestionText: string | null = null;
  if (questionImagePath) {
    const img = await readFileForGemini(questionImagePath);
    console.log(`[compo:ocr] question scan: ${questionImagePath} (${img.mimeType})`);
    const qStart = Date.now();
    const qResp = await generateContentWithRetry({
      model: OCR_MODEL,
      contents: [{ role: "user", parts: [
        { inlineData: img },
        { text: OCR_QUESTION_PROMPT_BODY },
      ] }],
      config: { temperature: 0 },
    }, 2, 5000, "compo-ocr-question");
    ocrQuestionText = (qResp.text ?? "").trim() || null;
    console.log(`[compo:ocr] question done in ${((Date.now() - qStart) / 1000).toFixed(1)}s, ${ocrQuestionText?.length ?? 0} chars`);
  }

  return { ocrText, ocrQuestionText };
}

// ─── Wrong-word pass ────────────────────────────────────────────────

const WRONG_WORDS_PROMPT = (ocrText: string) => `下面是一篇小学华文作文的转录。请找出确定的用字 / 语法错误，分为四类：

1. **stroke (错别字)**: 写错笔画或字形，导致不是字典里的字。例 "兔" 写成 "免"。
2. **meaning (用词不当)**: 是真字，但意思不通顺或与上下文不符。例如把 "保险柜" 用在不需要保险的情境。
3. **misuse (近义词混淆)**: 是真字，但用了意思相近但更不合适的词。例 "厉害" 用成 "凶猛" 类近义词混淆。
4. **omission (漏字)**: 句子缺少一个或几个字，使得语法不通顺。例如 "一天他妈妈" 应该是 "一天他的妈妈" (漏了 "的")。
   · original 字段写出缺字句子的上下文片段 (例 "他妈妈")。
   · suggestion 字段写出补齐后的形式 (例 "他的妈妈")。

【三次确认 — 重要】
在你列出每个错误之前，先在脑里 (不输出) 做以下三次确认：
- 第一次: 这个字 / 用词真的错吗？小学高年级作文允许文学色彩，不要把风格选择算成错误。
- 第二次: 你建议的字本身有没有错？检查你写的 suggestion 字段 — 没有错字、没有漏标点、没有多余空格。
- 第三次: 如果把 original 替换成 suggestion，整句话还通顺吗？标点 / 主谓 / 语序都对吗？

只列出 100% 确定是错误的项目。如果有怀疑，宁可不列出。
不要标记 "风格" / "可以更好" / "建议升级" 类的非错误。
不要标记 [+ +] 这种标记符号 — 那是之前 AI 留下的修订标记，不是学生写的错字。

【作文】
${ocrText}

【输出格式】严格的 JSON 数组，每个错误一项：
[
  {
    "original": "学生写的原字 (或缺字句子的上下文)",
    "suggestion": "建议的正确字 (或补齐后的形式)",
    "kind": "stroke" | "meaning" | "misuse" | "omission",
    "reason": "一句话解释 (中文，<25 字)"
  }
]

如果没有 100% 确定的错误，返回 \`[]\`。
不要 markdown 包围。`;

export async function detectWrongWords(ocrText: string): Promise<WrongWord[]> {
  console.log(`[compo:wrong-words] scanning ${ocrText.length} chars with ${ANALYSIS_MODEL}...`);
  const start = Date.now();
  const resp = await generateContentWithRetry({
    model: ANALYSIS_MODEL,
    contents: [{ role: "user", parts: [{ text: WRONG_WORDS_PROMPT(ocrText) }] }],
    config: { responseMimeType: "application/json", temperature: 0.1 },
  }, 2, 5000, "compo-wrong-words");
  console.log(`[compo:wrong-words] done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  const text = (resp.text ?? "[]").trim();
  try {
    const parsed = JSON.parse(extractJson(text));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(x => x && typeof x.original === "string" && typeof x.suggestion === "string")
      .map(x => ({
        original: String(x.original),
        suggestion: String(x.suggestion),
        kind: ["stroke", "meaning", "misuse", "omission"].includes(x.kind) ? x.kind : "meaning",
        reason: String(x.reason ?? ""),
      }));
  } catch (err) {
    console.error("[compo] wrong-words parse failed:", err);
    return [];
  }
}

// ─── Critique vs. PSLE 40-mark rubric ───────────────────────────────

type ModelEssay = { year: string; option: "option1" | "option2"; topic: string; essay: string };

async function loadModelEssays(optionType: string | null): Promise<ModelEssay[]> {
  const rows = await prisma.chineseSupplementaryPaper.findMany({
    where: {
      OR: [
        { compoOption1Model: { not: null } },
        { compoOption2Model: { not: null } },
      ],
    },
    select: { year: true, compoOption1Topic: true, compoOption1Model: true, compoOption2Model: true },
    orderBy: { year: "desc" },
  });
  const out: ModelEssay[] = [];
  for (const r of rows) {
    if ((optionType !== "option2") && r.compoOption1Model && r.compoOption1Topic) {
      out.push({ year: r.year, option: "option1", topic: r.compoOption1Topic, essay: r.compoOption1Model });
    }
    if ((optionType !== "option1") && r.compoOption2Model) {
      out.push({ year: r.year, option: "option2", topic: "(看图作文)", essay: r.compoOption2Model });
    }
  }
  return out;
}

const CRITIQUE_PROMPT = (ocrText: string, modelEssays: ModelEssay[], studentTopic: string | null) => {
  const sample = modelEssays.slice(0, 6).map(e =>
    `=== ${e.year} ${e.option === "option1" ? "Option 1" : "Option 2"} —  ${e.topic} ===\n${e.essay}`
  ).join("\n\n");

  return `你是新加坡 PSLE 华文作文 (Paper 1 写作) 阅卷老师。请按 PSLE 40 分制评分学生作文。

【三个评分轴】
- 内容 (Content) — 20 分: 情节完整、紧扣题意、有起承转合、感情真切、寓意 (moral/启示) 清楚。
- 词汇与好句 (Vocabulary & Phrases) — 10 分: 词汇准确、运用成语和好词好句、描写生动。
- 句子结构与组织 (Sentence Structure & Organization) — 10 分: 语法正确、段落过渡顺畅、故事流畅、代词使用清楚。

【真实分数分布 — 重要校准】
PSLE 华文作文的实际分数分布:
- 22 分以下: 弱 (主要错别字 / 情节不完整 / 离题)
- 23-26 分: 中等 (清晰但不亮眼)
- 27-30 分: 良好 (情节顺畅、用词正确)
- 31-34 分: 优秀 (情节有起伏 + 2-3 个成语 / 好句 + 一些描写)
- 35-37 分: 接近满分 / 上 5% (多个成语 + 生动描写 + 高潮 + 清楚寓意)
- 38-40 分: 极少数顶尖学生

下面的范文都是 40/40 的极少数顶尖作品。**不要用它们当 "及格线"**。

【打分要点】
1. 情节通顺、用词正确的小学高年级作文 → 28-30 分。
2. 加上 2-3 个成语 / 好句 + 一些描写 → 31-34 分。
3. 加上明显的高潮 + 生动描写 + 寓意点题 → 35-37 分。
4. **边界情况要往上靠**。如果犹豫是 32 还是 34，给 34。如果犹豫是 35 还是 36，给 36。
5. **看到学生明显努力 (例如多次用成语 / 加了描写句 / 有明显的开头结尾)，要给信用** — 不要因为某句不完美就拉低。
6. **不要因为 "can be better" 就扣分** — 只在真有缺陷的地方扣 (错字 / 漏字 / 情节断裂 / 语法错误)。
7. **修订标记 [+ +]**: 如果作文中出现 [+...+] 标记，那是之前 AI 留下的编辑痕迹，不算错。按 [+...+] 内的内容评分即可 (那是新加的内容)。

【对标范文 — 仅供参考写作风格】
PSLE 10 年 (2016-2025) 共 ${modelEssays.length} 篇 40/40 范文，挑了 6 篇:
${sample}

【学生作文 — 题目: ${studentTopic ?? "(未提供)"}】
${ocrText}

【评分要求】
- 以上面的范文为 40 分基准，对比学生作文找出差距。
- 评分要符合小学高年级水平 — 不要拿成年人标准，但也要诚实指出不足。
- 每个评语 (Notes) 用 1-2 个简短句子，中文，<= 60 字。

【输出格式 — 严格 JSON】每条 Notes 都需要中文 + 英文 (家长版)。
{
  "contentScore": <0-20>,
  "contentNotes": "<内容评语 - 中文短>",
  "contentNotesEn": "<content notes — short English>",
  "vocabScore": <0-10>,
  "vocabNotes": "<词汇好句评语 - 中文短>",
  "vocabNotesEn": "<vocabulary & phrases notes — short English>",
  "sentenceScore": <0-10>,
  "sentenceNotes": "<句子结构与组织评语 - 中文短>",
  "sentenceNotesEn": "<sentence structure & organization notes — short English>",
  "overallScore": <三项总和>,
  "overallSummary": "<总评 - 中文 1-2 句>",
  "overallSummaryEn": "<short overall summary in English>",
  "cleanRewrite": {
    "contentScore": <如果只修了错别字和漏字 (没改情节)，内容分会是多少。通常 +0>,
    "contentNotes": "<中文短>",
    "contentNotesEn": "<English short>",
    "vocabScore": <通常 +0 至 +0.5>,
    "vocabNotes": "<中文短>",
    "vocabNotesEn": "<English short>",
    "sentenceScore": <通常 +0.5 至 +1.5 (修标点 / 漏字 / 语法)>,
    "sentenceNotes": "<中文短>",
    "sentenceNotesEn": "<English short>",
    "overallScore": <三项总和>,
    "whyChanged": "<中文 1-2 句解释: 为什么分数有/没有提升>",
    "whyChangedEn": "<English 1-2 sentences — why the score moved (or didn't)>"
  },
  "benchmarkYears": [<参考的 PSLE 年份>]
}

不要 markdown 包围。`;
};

export async function critiqueComposition(
  ocrText: string,
  optionType: string | null,
  studentTopic: string | null,
): Promise<Critique> {
  const modelEssays = await loadModelEssays(optionType);
  if (modelEssays.length === 0) throw new Error("No model essays available in DB");
  console.log(`[compo:critique] loaded ${modelEssays.length} model essays (optionType=${optionType ?? "any"}, topic=${studentTopic ?? "(none)"}). Calling ${ANALYSIS_MODEL}...`);
  const start = Date.now();
  const resp = await generateContentWithRetry({
    model: ANALYSIS_MODEL,
    contents: [{ role: "user", parts: [{ text: CRITIQUE_PROMPT(ocrText, modelEssays, studentTopic) }] }],
    config: { responseMimeType: "application/json", temperature: 0.2 },
  }, 2, 5000, "compo-critique");
  console.log(`[compo:critique] done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  const text = (resp.text ?? "").trim();
  const parsed = JSON.parse(extractJson(text));
  const contentScore = Number(parsed.contentScore ?? 0);
  const vocabScore = Number(parsed.vocabScore ?? 0);
  const sentenceScore = Number(parsed.sentenceScore ?? 0);
  const overallScore = Number(parsed.overallScore ?? contentScore + vocabScore + sentenceScore);
  // Parse the cleanRewrite sub-object if present; default to a
  // pass-through (no delta) so the UI always has something to show.
  const cr = parsed.cleanRewrite && typeof parsed.cleanRewrite === "object" ? parsed.cleanRewrite : null;
  const cleanRewrite: RubricBreakdown | undefined = cr ? {
    contentScore:   Number(cr.contentScore ?? contentScore),
    contentNotes:   String(cr.contentNotes ?? ""),
    contentNotesEn: String(cr.contentNotesEn ?? ""),
    vocabScore:     Number(cr.vocabScore ?? vocabScore),
    vocabNotes:     String(cr.vocabNotes ?? ""),
    vocabNotesEn:   String(cr.vocabNotesEn ?? ""),
    sentenceScore:  Number(cr.sentenceScore ?? sentenceScore),
    sentenceNotes:  String(cr.sentenceNotes ?? ""),
    sentenceNotesEn:String(cr.sentenceNotesEn ?? ""),
    overallScore:   Number(cr.overallScore ?? (Number(cr.contentScore ?? contentScore) + Number(cr.vocabScore ?? vocabScore) + Number(cr.sentenceScore ?? sentenceScore))),
    whyChanged:     String(cr.whyChanged ?? ""),
    whyChangedEn:   String(cr.whyChangedEn ?? ""),
  } : undefined;
  return {
    contentScore,
    contentNotes: String(parsed.contentNotes ?? ""),
    contentNotesEn: String(parsed.contentNotesEn ?? ""),
    vocabScore,
    vocabNotes: String(parsed.vocabNotes ?? ""),
    vocabNotesEn: String(parsed.vocabNotesEn ?? ""),
    sentenceScore,
    sentenceNotes: String(parsed.sentenceNotes ?? ""),
    sentenceNotesEn: String(parsed.sentenceNotesEn ?? ""),
    overallScore,
    overallSummary: String(parsed.overallSummary ?? ""),
    overallSummaryEn: String(parsed.overallSummaryEn ?? ""),
    cleanRewrite,
    cleanRewriteScore: cleanRewrite?.overallScore ?? overallScore,
    benchmarkYears: Array.isArray(parsed.benchmarkYears) ? parsed.benchmarkYears.map(String) : [],
  };
}

// ─── Recommendations ────────────────────────────────────────────────

const RECOMMEND_PROMPT = (
  ocrText: string,
  critique: Critique,
  playbookSummary: string,
) => `你是新加坡 PSLE 华文作文老师。学生作文如下，已经过初评。请给出两类改进建议：

【学生作文】
${ocrText}

【初评】
- 内容: ${critique.contentScore}/20 — ${critique.contentNotes}
- 词汇好句: ${critique.vocabScore}/10 — ${critique.vocabNotes}
- 句子结构与组织: ${critique.sentenceScore}/10 — ${critique.sentenceNotes}
- 总评: ${critique.overallSummary}

【可参考的语句库 (从 PSLE 范文提炼)】
${playbookSummary}

【任务】
1. **structural**: 找出 2-4 个结构上的缺口 — 例如缺少开头悬念、缺过渡句、高潮不够戏剧化、结尾点题不够、寓意 (moral) 不清。每个写明具体在文章哪个位置可以加。
2. **language**: 从上面的语句库 (或自创类似水平的句子) 推荐 3-5 个具体可以加进作文的句子或词组。不要太多 — 选最有助提升的几句。每句标明应该加在哪个情境/段落。
   · **重要**: 语句库每个 bucket 都有多个候选 (开头 12+ 个、结尾 12+ 个等等)。请根据本作文的具体情境挑选最贴合的句子，不要总是用列表第一句。如果情境对得上的有 3 个，选最切题的那一个，不要看顺序。
   · 不同的作文应该用不同的句子 — 即使两篇都是 "明白了一个道理" 的题目。

【输出格式 — 严格 JSON】每个 structural 都需要中英文，方便家长理解。
{
  "structural": [
    {
      "piece":    "<中文结构部分名称，例 '开头悬念' / '过渡' / '高潮' / '结尾点题' / '寓意'>",
      "pieceEn":  "<English label, e.g. 'Opening hook' / 'Transition' / 'Climax' / 'Moral'>",
      "issue":    "<中文问题描述 - 1 句话>",
      "issueEn":  "<English issue description — 1 short sentence>",
      "suggestion":   "<中文具体改法 - 1-2 句话>",
      "suggestionEn": "<English suggestion — 1-2 short sentences>",
      "exampleFromModel": { "year": "<参考的范文年份>", "snippet": "<可借鉴的范文片段>", "bucket": "<bucket 标签>" }
    }
  ],
  "language": [
    {
      "phraseCn": "<推荐的中文句子或词组>",
      "phraseEn": "<English translation>",
      "fromYear": "<出自的范文年份。如果是创作的或没特定来源，留空字串 \"\"; 不要写 'PSLE 通用' 或类似词>",
      "bucket": "<opening | closing | accident | careless | transition | emotion | scenery | action | moral>",
      "whyItHelps": "<为什么这句对这篇作文有帮助 - 1 句话 (中文)>"
    }
  ]
}

不要 markdown 包围。`;

type PhraseEntry = { cn: string; en?: string; fromYear?: string };

// Canonical bucket names the recommend prompt + UI expect.
const PLAYBOOK_BUCKET_MAP: Record<string, string> = {
  universalOpenings: "opening",
  universalClosings: "closing",
  safetyAccidentDescription: "accident",
  carelessConfessionDescription: "careless",
};

// Build a phrase bank merging:
//   · The 4 hand-curated playbook buckets (universalOpenings / Closings,
//     safetyAccident / carelessConfession description) — 20 phrases.
//   · Every classified highlight in the 4 featured 40/40 essays — 29
//     more phrases tagged by bucket (opening/transition/accident/
//     careless/closing).
// = ~49 candidate phrases vs. the 16 the old summariser used.
function buildPhraseBank(): Map<string, PhraseEntry[]> {
  const bank = new Map<string, PhraseEntry[]>();
  const push = (bucket: string, entry: PhraseEntry) => {
    const list = bank.get(bucket) ?? [];
    list.push(entry);
    bank.set(bucket, list);
  };
  // Playbook
  const pb = playbookJson as unknown as Record<string, unknown>;
  for (const [rawBucket, items] of Object.entries(pb)) {
    if (!Array.isArray(items)) continue;
    const bucket = PLAYBOOK_BUCKET_MAP[rawBucket] ?? rawBucket;
    for (const it of items) {
      if (it && typeof it === "object" && typeof (it as { cn?: unknown }).cn === "string") {
        const e = it as { cn: string; en?: string };
        push(bucket, { cn: e.cn, en: e.en });
      }
    }
  }
  // Featured essay highlights
  const featured = featuredJson as Array<{ year?: string; highlights?: Array<{ span?: string; bucket?: string }> }>;
  for (const essay of featured) {
    if (!Array.isArray(essay.highlights)) continue;
    for (const h of essay.highlights) {
      if (h && typeof h.span === "string" && typeof h.bucket === "string") {
        push(h.bucket, { cn: h.span, fromYear: essay.year });
      }
    }
  }
  return bank;
}

// FNV-1a-ish 32-bit hash for seeding the shuffle. Same essay → same
// order across reruns (stable for the user), but different essays
// see different orders so the AI's positional bias doesn't keep
// landing on the same opening across attempts.
function seedFromText(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededShuffle<T>(arr: T[], seed: number): T[] {
  // Mulberry32 PRNG — small + fast, deterministic from seed.
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function summarizePlaybook(seedText: string): string {
  const bank = buildPhraseBank();
  const seed = seedFromText(seedText);
  const lines: string[] = [];
  for (const [bucket, items] of bank) {
    if (items.length === 0) continue;
    // Shuffle deterministically per-essay so the AI doesn't always
    // see the same #1 candidate. Show ALL — the playbook isn't large
    // enough to blow the token budget.
    const shuffled = seededShuffle(items, seed + bucket.charCodeAt(0));
    lines.push(`【${bucket}】(${items.length} 个候选)`);
    for (const item of shuffled) {
      const tag = item.fromYear ? ` (PSLE ${item.fromYear})` : "";
      lines.push(`  · ${item.cn}${tag}`);
    }
  }
  return lines.join("\n");
}

export async function recommend(
  ocrText: string,
  critique: Critique,
): Promise<Recommendations> {
  const playbookSummary = summarizePlaybook(ocrText);
  console.log(`[compo:recommend] calling ${ANALYSIS_MODEL} (playbook ${playbookSummary.length} chars)...`);
  const start = Date.now();
  const resp = await generateContentWithRetry({
    model: ANALYSIS_MODEL,
    contents: [{ role: "user", parts: [{ text: RECOMMEND_PROMPT(ocrText, critique, playbookSummary) }] }],
    config: { responseMimeType: "application/json", temperature: 0.3 },
  }, 2, 5000, "compo-recommend");
  console.log(`[compo:recommend] done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  const text = (resp.text ?? "").trim();
  const parsed = JSON.parse(extractJson(text));
  const structural = Array.isArray(parsed.structural) ? parsed.structural : [];
  const language = Array.isArray(parsed.language) ? parsed.language : [];
  return { structural, language };
}

// ─── Stage 5: elevated draft ────────────────────────────────────────

const ELEVATE_PROMPT = (
  ocrText: string,
  wrongWords: WrongWord[],
  critique: Critique,
  recs: Recommendations,
) => {
  const wrongWordLine = wrongWords.length === 0
    ? "(无错别字)"
    : wrongWords.map(w => `${w.original}→${w.suggestion} (${w.reason})`).join("; ");
  const structuralLines = recs.structural.map(s => `· ${s.piece}: ${s.suggestion}`).join("\n");
  const languageLines = recs.language.map(l => `· ${l.phraseCn} — ${l.whyItHelps}`).join("\n");

  return `你是新加坡 PSLE 华文作文老师。我们参考的是 PSLE 10 年 (2016-2025) 模范作文 — 全部 40/40。学生的作文目前得分 ${critique.overallScore}/40。现在请你帮他改写到 35-40 分水平。

【真实分数分布 — 校准】
- 23-26 分: 中等。27-30 分: 良好。31-34 分: 优秀 (2-3 个成语 + 描写)。
- 35-37 分: 接近满分 (多个成语 + 生动描写 + 高潮 + 寓意)。38-40 分: 极少数顶尖。
- 改写后要达到 35-40，必须满足: (a) 情节有明显起承转合和高潮 (b) 至少 3-4 个成语 / 好句 (c) 有描写 (人物心理 / 场景 / 动作) (d) 结尾点题/寓意清楚。
- 如果做不到，老实在 estimatedScore 写一个比较低的分数 (例如 32 或 33)。不要为了好看而虚报分数。

【规则 — 必须遵守】
1. **保留学生的故事主线** — 不要发明新情节，不要改变人物、地点、结局。
2. **不要超过原文长度太多** — 上限是原文 + 30%。小学高年级水平作文，不要写成大学水准。
3. **用 [+ +] 标记所有新加的或替换的文字** — 用法如下:
   · 插入新文字: 在新文字外面包 [+...+]，例: 那天早上[+，阳光明媚，鸟语花香，+]我和爸爸去公园。
   · 替换旧文字: 删掉旧字，写新字时也用 [+...+] 包起来。
   · 学生原本写得好的文字 — 不要包 [+...+] 标记，直接保留。
4. **改正所有错别字** (用 [+...+] 包正确字)。
5. **不要标记单字修订** 如果只是改一两个字 (如错别字)。要选成段或成句的提升点，让 markup 有价值。

【应该做的提升 (基于初评)】
- 内容: ${critique.contentNotes}
- 词汇好句: ${critique.vocabNotes}
- 句子结构: ${critique.sentenceNotes}

【结构上的建议】
${structuralLines || "(无)"}

【语言上的建议 — 可挑 2-3 句加入】
${languageLines || "(无)"}

【错别字】
${wrongWordLine}

【学生原作文】
${ocrText}

【任务】
按规则改写，并对改写后的版本做一份完整的 PSLE 40 分制评分。

【输出格式 — 严格 JSON】
{
  "draft": "<改写后的作文，含 [+ +] 标记。保留 \\n 段落换行>",
  "estimatedScore": <三项总分>,
  "rubric": {
    "contentScore": <0-20>,
    "contentNotes": "<中文短>",
    "contentNotesEn": "<English short>",
    "vocabScore": <0-10>,
    "vocabNotes": "<中文短>",
    "vocabNotesEn": "<English short>",
    "sentenceScore": <0-10>,
    "sentenceNotes": "<中文短>",
    "sentenceNotesEn": "<English short>",
    "overallScore": <三项总和，应等于 estimatedScore>,
    "whyChanged": "<中文 1-2 句: 改写后为什么得到这分 / 和原作差距在哪>",
    "whyChangedEn": "<English 1-2 sentences — why the rewrite earns this score vs the original>"
  }
}

不要 markdown 包围。`;
};

export async function buildElevatedDraft(
  ocrText: string,
  wrongWords: WrongWord[],
  critique: Critique,
  recommendations: Recommendations,
): Promise<{ draft: string; estimatedScore: number; rubric?: RubricBreakdown }> {
  console.log(`[compo:elevate] calling ${ANALYSIS_MODEL}...`);
  const start = Date.now();
  const resp = await generateContentWithRetry({
    model: ANALYSIS_MODEL,
    contents: [{ role: "user", parts: [{ text: ELEVATE_PROMPT(ocrText, wrongWords, critique, recommendations) }] }],
    config: { responseMimeType: "application/json", temperature: 0.4 },
  }, 2, 5000, "compo-elevate");
  const raw = (resp.text ?? "").trim();
  console.log(`[compo:elevate] done in ${((Date.now() - start) / 1000).toFixed(1)}s, ${raw.length} chars`);
  try {
    const parsed = JSON.parse(extractJson(raw));
    const r = parsed.rubric && typeof parsed.rubric === "object" ? parsed.rubric : null;
    const rubric: RubricBreakdown | undefined = r ? {
      contentScore:   Number(r.contentScore ?? 0),
      contentNotes:   String(r.contentNotes ?? ""),
      contentNotesEn: String(r.contentNotesEn ?? ""),
      vocabScore:     Number(r.vocabScore ?? 0),
      vocabNotes:     String(r.vocabNotes ?? ""),
      vocabNotesEn:   String(r.vocabNotesEn ?? ""),
      sentenceScore:  Number(r.sentenceScore ?? 0),
      sentenceNotes:  String(r.sentenceNotes ?? ""),
      sentenceNotesEn:String(r.sentenceNotesEn ?? ""),
      overallScore:   Number(r.overallScore ?? Number(parsed.estimatedScore ?? 0)),
      whyChanged:     String(r.whyChanged ?? ""),
      whyChangedEn:   String(r.whyChangedEn ?? ""),
    } : undefined;
    return {
      draft: String(parsed.draft ?? raw),
      estimatedScore: Number(parsed.estimatedScore ?? rubric?.overallScore ?? 33),
      rubric,
    };
  } catch {
    // AI returned plain text instead of JSON — assume the whole
    // response is the draft and pick a conservative 33/40 estimate.
    return { draft: raw, estimatedScore: 33 };
  }
}

// ─── Orchestrator ───────────────────────────────────────────────────

export async function analyseCompoAttempt(attemptId: string): Promise<void> {
  const overallStart = Date.now();
  const tag = `[compo:${attemptId.slice(-6)}]`;
  console.log(`${tag} ── analyse start ────────────────────────`);

  const attempt = await prisma.compoAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt) throw new Error(`CompoAttempt ${attemptId} not found`);

  const compositionImagePaths = (attempt.compositionImagePaths as unknown as string[] | null) ?? [];
  if (compositionImagePaths.length === 0) throw new Error("No composition images");
  console.log(`${tag} input: ${compositionImagePaths.length} composition file(s), question=${attempt.questionImagePath ?? "(none)"}, optionType=${attempt.optionType ?? "(any)"}, topic=${attempt.studentTopic ?? "(none)"}`);

  await prisma.compoAttempt.update({
    where: { id: attemptId },
    data: { status: "analysing", errorMessage: null },
  });

  try {
    // 1. OCR
    console.log(`${tag} stage 1/4: OCR`);
    const { ocrText, ocrQuestionText } = await runOcr(compositionImagePaths, attempt.questionImagePath);
    await prisma.compoAttempt.update({
      where: { id: attemptId },
      data: { ocrText, ocrQuestionText },
    });

    // 2. Wrong words
    console.log(`${tag} stage 2/4: wrong-words`);
    const wrongWords = await detectWrongWords(ocrText);
    console.log(`${tag} found ${wrongWords.length} wrong-word issue(s)`);
    await prisma.compoAttempt.update({
      where: { id: attemptId },
      data: { wrongWords: wrongWords as never },
    });

    // 3. Critique
    console.log(`${tag} stage 3/4: critique`);
    const critique = await critiqueComposition(ocrText, attempt.optionType, attempt.studentTopic);
    console.log(`${tag} score: ${critique.overallScore}/40 (内容 ${critique.contentScore}/20, 词汇 ${critique.vocabScore}/10, 句子 ${critique.sentenceScore}/10)`);
    await prisma.compoAttempt.update({
      where: { id: attemptId },
      data: { critique: critique as never },
    });

    // 4. Recommendations
    console.log(`${tag} stage 4/5: recommendations`);
    const recommendations = await recommend(ocrText, critique);
    console.log(`${tag} ${recommendations.structural.length} structural + ${recommendations.language.length} language recommendation(s)`);
    await prisma.compoAttempt.update({
      where: { id: attemptId },
      data: { recommendations: recommendations as never },
    });

    // 5. Elevated draft — write the version that would score 35-40,
    //    anchored to the kid's original plot. New text is wrapped in
    //    [+ ... +] markers so the UI can render kid words in black
    //    and additions in green.
    console.log(`${tag} stage 5/5: elevated draft`);
    const elev = await buildElevatedDraft(ocrText, wrongWords, critique, recommendations);
    console.log(`${tag} elevated draft estimated score: ${elev.estimatedScore}/40`);
    const recsWithDraft: Recommendations = {
      ...recommendations,
      elevatedDraft: elev.draft,
      elevatedDraftScore: elev.estimatedScore,
      elevatedDraftRubric: elev.rubric,
    };
    await prisma.compoAttempt.update({
      where: { id: attemptId },
      data: {
        recommendations: recsWithDraft as never,
        status: "ready",
        analysedAt: new Date(),
      },
    });
    console.log(`${tag} ── analyse done in ${((Date.now() - overallStart) / 1000).toFixed(1)}s ────────────`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${tag} analyse FAILED after ${((Date.now() - overallStart) / 1000).toFixed(1)}s:`, msg);
    if (err instanceof Error && err.stack) console.error(err.stack);
    await prisma.compoAttempt.update({
      where: { id: attemptId },
      data: { status: "failed", errorMessage: msg },
    });
    throw err;
  }
}
