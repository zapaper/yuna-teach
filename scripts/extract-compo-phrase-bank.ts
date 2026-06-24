// One-shot phrase-bank extractor for the Chinese compo helper.
//
// Reads every model essay in ChineseSupplementaryPaper (10 years
// × 2 options = 20 essays, all PSLE 40/40), asks Gemini 3.1-pro
// to pull 6-10 transferable highlight phrases per essay, tagged
// by bucket (opening / transition / climax / accident / careless /
// moral / closing / idiom / description / connector). Writes the
// result to src/data/chinese-compo/extended-highlights.json.
//
// `buildPhraseBank()` in src/lib/compo-analysis.ts merges this file
// alongside featured.json so the live swap dropdown has phrases
// from the full 20-essay corpus, not just the 4 hand-curated ones.
//
// Run: npx tsx scripts/extract-compo-phrase-bank.ts
// Optional flags:
//   --year=2024              process one year only (both options)
//   --concurrency=4          parallel Gemini calls (default 4)
//   --out=path/to/file.json  override output path

import fs from "fs/promises";
import path from "path";
import { prisma } from "../src/lib/db";
import { generateContentWithRetry } from "../src/lib/gemini";

const args = process.argv.slice(2);
const argMap = new Map(
  args.map(a => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "true"] as const; })
);
const ONLY_YEAR = argMap.get("year");
const CONCURRENCY = parseInt(argMap.get("concurrency") ?? "4", 10);
const OUT_PATH = argMap.get("out") ?? path.join("src", "data", "chinese-compo", "extended-highlights.json");

const MODEL = "gemini-3.1-pro-preview";

const EXTRACT_PROMPT = (year: string, option: 1 | 2, topic: string, essay: string) => `你是新加坡 PSLE 华文作文 (Paper 1 写作) 教研老师。下面是 PSLE ${year} Option ${option} 的 40/40 范文 (题目: "${topic}")。

【任务】
从这篇范文里挑选 6-10 个最有价值的 **可迁移到其他作文** 的高分句子或短语。每个挑选出来:
- 写出原文片段 (span) — 必须和原文一字不差。
- 分类到 bucket。
- 用 1 句话说明为什么这句话好 + 适合什么时候用 (why)。
- 如果合适，给个更细的子类 (subType)，例如 "天气开头" / "心理描写" / "时间紧接" / "动作描写"。

【bucket 取值】
- opening (开头) / transition (过渡) / climax (高潮) / accident (突发事件) / careless (粗心懊悔) / moral (寓意点题) / closing (结尾)
- idiom (成语) — 4 字成语、谚语、俗语
- description (描写句 — 心理 / 场景 / 动作 / 神态)
- connector (连接词 — 此时此刻 / 一……就 / 与此同时 / 等等)

【挑选准则】
- **可迁移**: 跳过和本故事情节绑死的句子 (例如 "我把弟弟的玩具弄坏了") — 那种没法在别的作文里用。挑结构性 / 情感性 / 风格性的句子。
- 偏好成语、生动描写、连接词、画面感强的句子。
- 不要挑太长的句子 (一句最长 60 字)。
- 不要重复 — 同一句不要列两次。

【作文】
${essay}

【输出格式 — 严格 JSON 数组】
[
  {
    "span": "<原文片段, 1-60 字>",
    "bucket": "<上面 10 个 bucket 之一>",
    "subType": "<可选，更细的分类>",
    "why": "<1 句中文: 为什么好 + 何时可用>"
  }
]

不要 markdown 包围，只输出 JSON 数组。`;

type Highlight = { span: string; bucket: string; subType?: string; why: string };

function extractJson(raw: string): string {
  const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
  const braceAt = cleaned.indexOf("{");
  const bracketAt = cleaned.indexOf("[");
  const start = braceAt < 0 ? bracketAt : bracketAt < 0 ? braceAt : Math.min(braceAt, bracketAt);
  if (start < 0) return cleaned;
  const open = cleaned[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = false, escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (escaped) { escaped = false; continue; }
    if (c === "\\") { escaped = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return cleaned.slice(start, i + 1); }
  }
  return cleaned;
}

async function extractOne(year: string, option: 1 | 2, topic: string, essay: string): Promise<Highlight[]> {
  const t0 = Date.now();
  const resp = await generateContentWithRetry({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: EXTRACT_PROMPT(year, option, topic, essay) }] }],
    config: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 8192 },
  }, 2, 5000, `extract-${year}-O${option}`);
  const raw = (resp.text ?? "").trim();
  let parsed: unknown;
  try { parsed = JSON.parse(extractJson(raw)); }
  catch (err) {
    console.error(`  [${year} O${option}] parse failed (${raw.length} chars): ${err instanceof Error ? err.message : err}`);
    console.error(`  first 200: ${raw.slice(0, 200)}`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.error(`  [${year} O${option}] expected array, got ${typeof parsed}`);
    return [];
  }
  const hl: Highlight[] = parsed
    .filter((h): h is Highlight & Record<string, unknown> =>
      !!h && typeof h === "object"
      && typeof (h as { span?: unknown }).span === "string"
      && typeof (h as { bucket?: unknown }).bucket === "string"
    )
    .map(h => ({
      span: String(h.span).trim(),
      bucket: String(h.bucket).trim().toLowerCase(),
      subType: h.subType ? String(h.subType).trim() : undefined,
      why: String(h.why ?? "").trim(),
    }))
    .filter(h => h.span.length > 0 && h.span.length <= 200);
  console.log(`  [${year} O${option}] ${hl.length} highlights in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return hl;
}

async function runInPool<T, R>(items: T[], poolSize: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  const worker = async () => {
    while (true) {
      const my = idx++;
      if (my >= items.length) return;
      out[my] = await fn(items[my]);
    }
  };
  await Promise.all(Array.from({ length: poolSize }, worker));
  return out;
}

(async () => {
  console.log(`Loading model essays (year filter: ${ONLY_YEAR ?? "ALL"})…`);
  const where = ONLY_YEAR ? { year: ONLY_YEAR } : undefined;
  const rows = await prisma.chineseSupplementaryPaper.findMany({
    where,
    select: { year: true, compoOption1Topic: true, compoOption1Model: true, compoOption2Model: true },
    orderBy: { year: "asc" },
  });
  console.log(`Found ${rows.length} year(s)`);

  type Job = { year: string; option: 1 | 2; topic: string; essay: string };
  const jobs: Job[] = [];
  for (const r of rows) {
    if (r.compoOption1Model && r.compoOption1Topic) {
      jobs.push({ year: r.year, option: 1, topic: r.compoOption1Topic, essay: r.compoOption1Model });
    }
    if (r.compoOption2Model) {
      jobs.push({ year: r.year, option: 2, topic: "(看图作文)", essay: r.compoOption2Model });
    }
  }
  console.log(`Total essays to extract: ${jobs.length}\n`);

  const results = await runInPool(jobs, CONCURRENCY, async (job) => {
    return {
      year: job.year,
      option: job.option,
      titleCn: job.topic,
      highlights: await extractOne(job.year, job.option, job.topic, job.essay),
    };
  });

  // Filter out essays that yielded zero highlights (failed parse, etc.)
  const useful = results.filter(r => r.highlights.length > 0);
  const totalPhrases = useful.reduce((s, r) => s + r.highlights.length, 0);
  console.log(`\nExtracted ${totalPhrases} phrases across ${useful.length}/${jobs.length} essays`);

  const bucketCounts = new Map<string, number>();
  for (const r of useful) {
    for (const h of r.highlights) {
      bucketCounts.set(h.bucket, (bucketCounts.get(h.bucket) ?? 0) + 1);
    }
  }
  console.log("By bucket:");
  const sorted = [...bucketCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [bucket, n] of sorted) console.log(`  ${n.toString().padStart(4)}  ${bucket}`);

  await fs.writeFile(OUT_PATH, JSON.stringify(useful, null, 2), "utf8");
  console.log(`\nWrote ${OUT_PATH}`);
  await prisma.$disconnect();
})();
