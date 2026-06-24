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

export type Critique = {
  contentScore: number;        // 0..20
  contentNotes: string;
  vocabScore: number;          // 0..10
  vocabNotes: string;
  sentenceScore: number;       // 0..10
  sentenceNotes: string;
  overallScore: number;        // sum of the three
  overallSummary: string;
  benchmarkYears: string[];
};

export type Recommendations = {
  structural: Array<{
    piece: string;
    issue: string;
    suggestion: string;
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

const OCR_PROMPT_BODY = `你正在从扫描的手写小学华文作文中提取文字。

【任务】
1. 按段落顺序，把学生手写的所有文字转录成简体中文 (即原文是简体就用简体；原文是繁体也转成简体)。
2. 标点符号 (，。！？""''「」《》)请保留并用全角。
3. 段落之间用一个空行分隔。不要加任何标题，也不要加 "学生写道:" 这类元信息。
4. 如果某字看不清，先写一个最接近的猜测字，并在该字后用 "[?]" 标记，例如 "他很高[?]兴"。
5. 不要纠正错别字 — 学生原文里写的错字必须保留下来 (后续步骤会处理)。
6. 不要补充任何学生没写的字。

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
  const ocrText = (ocrResp.text ?? "").trim();
  console.log(`[compo:ocr] composition done in ${((Date.now() - ocrStart) / 1000).toFixed(1)}s, ${ocrText.length} chars`);

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

const WRONG_WORDS_PROMPT = (ocrText: string) => `下面是一篇小学华文作文的转录。请找出所有用字 / 语法错误，分为四类：

1. **stroke (错别字)**: 写错笔画或字形，导致不是字典里的字。例 "兔" 写成 "免"。
2. **meaning (用词不当)**: 是真字，但意思不通顺或与上下文不符。例如把 "保险柜" 用在不需要保险的情境。
3. **misuse (近义词混淆)**: 是真字，但用了意思相近但更不合适的词。例 "厉害" 用成 "凶猛" 类近义词混淆。
4. **omission (漏字)**: 句子缺少一个或几个字，使得语法不通顺。例如 "一天他妈妈" 应该是 "一天他的妈妈" (漏了 "的")。
   · original 字段写出缺字句子的上下文片段 (例 "他妈妈")。
   · suggestion 字段写出补齐后的形式 (例 "他的妈妈")。

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

如果没有错误，返回 \`[]\`。
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
    const parsed = JSON.parse(text.replace(/^```json\s*/i, "").replace(/```\s*$/i, ""));
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

【对标范文】
下面是 PSLE 10 年 (2016-2025) 的模范作文，全部是 40/40 满分水平。一共有 ${modelEssays.length} 篇 (Option 1 + Option 2)，下面挑了 6 篇做参考：
${sample}

【学生作文 — 题目: ${studentTopic ?? "(未提供)"}】
${ocrText}

【评分要求】
- 以上面的范文为 40 分基准，对比学生作文找出差距。
- 评分要符合小学高年级水平 — 不要拿成年人标准，但也要诚实指出不足。
- 每个评语 (Notes) 用 1-2 个简短句子，中文，<= 60 字。

【输出格式 — 严格 JSON】
{
  "contentScore": <0-20 的整数或半分如 17.5>,
  "contentNotes": "<内容评语 - 短>",
  "vocabScore": <0-10>,
  "vocabNotes": "<词汇好句评语 - 短>",
  "sentenceScore": <0-10>,
  "sentenceNotes": "<句子结构与组织评语 - 短>",
  "overallScore": <三项总和>,
  "overallSummary": "<总评 - 1-2 句>",
  "benchmarkYears": [<参考的 PSLE 年份，如 "2022", "2021">]
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
  const parsed = JSON.parse(text.replace(/^```json\s*/i, "").replace(/```\s*$/i, ""));
  return {
    contentScore: Number(parsed.contentScore ?? 0),
    contentNotes: String(parsed.contentNotes ?? ""),
    vocabScore: Number(parsed.vocabScore ?? 0),
    vocabNotes: String(parsed.vocabNotes ?? ""),
    sentenceScore: Number(parsed.sentenceScore ?? 0),
    sentenceNotes: String(parsed.sentenceNotes ?? ""),
    overallScore: Number(parsed.overallScore ?? 0),
    overallSummary: String(parsed.overallSummary ?? ""),
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

【输出格式 — 严格 JSON】
{
  "structural": [
    {
      "piece": "<结构部分名称，例如 '开头悬念' / '过渡' / '高潮' / '结尾点题' / '寓意'>",
      "issue": "<问题描述 - 1 句话>",
      "suggestion": "<具体怎么改 - 1-2 句话>",
      "exampleFromModel": { "year": "<参考的范文年份>", "snippet": "<可借鉴的范文片段>", "bucket": "<bucket 标签>" }
    }
  ],
  "language": [
    {
      "phraseCn": "<推荐的中文句子或词组>",
      "phraseEn": "<英文翻译，如有>",
      "fromYear": "<出自的范文年份，如果是创作的可省略>",
      "bucket": "<opening | closing | accident | careless | transition | emotion | scenery | action | moral>",
      "whyItHelps": "<为什么这句对这篇作文有帮助 - 1 句话>"
    }
  ]
}

不要 markdown 包围。`;

function summarizePlaybook(): string {
  // The playbook JSON mixes shapes per top-level key (most are { cn,
  // en }[], but multiTopicEssays has a different shape). Iterate
  // dynamically and only emit entries that carry a `cn` field.
  const pb = playbookJson as unknown as Record<string, unknown>;
  const lines: string[] = [];
  for (const [bucket, items] of Object.entries(pb)) {
    if (!Array.isArray(items)) continue;
    const cnItems = items.filter((it): it is { cn: string; en?: string } =>
      !!it && typeof it === "object" && typeof (it as { cn?: unknown }).cn === "string"
    );
    if (cnItems.length === 0) continue;
    lines.push(`【${bucket}】`);
    for (const item of cnItems.slice(0, 4)) {
      lines.push(`  · ${item.cn}`);
    }
  }
  return lines.join("\n");
}

export async function recommend(
  ocrText: string,
  critique: Critique,
): Promise<Recommendations> {
  const playbookSummary = summarizePlaybook();
  console.log(`[compo:recommend] calling ${ANALYSIS_MODEL} (playbook ${playbookSummary.length} chars)...`);
  const start = Date.now();
  const resp = await generateContentWithRetry({
    model: ANALYSIS_MODEL,
    contents: [{ role: "user", parts: [{ text: RECOMMEND_PROMPT(ocrText, critique, playbookSummary) }] }],
    config: { responseMimeType: "application/json", temperature: 0.3 },
  }, 2, 5000, "compo-recommend");
  console.log(`[compo:recommend] done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  const text = (resp.text ?? "").trim();
  const parsed = JSON.parse(text.replace(/^```json\s*/i, "").replace(/```\s*$/i, ""));
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
按规则改写。只输出改写后的作文 (含 [+ +] 标记)，不要 markdown 包围，不要解释，不要标题。`;
};

export async function buildElevatedDraft(
  ocrText: string,
  wrongWords: WrongWord[],
  critique: Critique,
  recommendations: Recommendations,
): Promise<string> {
  console.log(`[compo:elevate] calling ${ANALYSIS_MODEL}...`);
  const start = Date.now();
  const resp = await generateContentWithRetry({
    model: ANALYSIS_MODEL,
    contents: [{ role: "user", parts: [{ text: ELEVATE_PROMPT(ocrText, wrongWords, critique, recommendations) }] }],
    config: { temperature: 0.4 },
  }, 2, 5000, "compo-elevate");
  const out = (resp.text ?? "").trim();
  console.log(`[compo:elevate] done in ${((Date.now() - start) / 1000).toFixed(1)}s, ${out.length} chars`);
  return out;
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
    const elevatedDraft = await buildElevatedDraft(ocrText, wrongWords, critique, recommendations);
    const recsWithDraft: Recommendations = { ...recommendations, elevatedDraft };
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
