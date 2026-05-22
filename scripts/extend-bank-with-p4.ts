// Extend the existing study bank with P4 candidates.
//
// Pipeline:
//   1. Load existing psle-chinese-study-bank.json (P5+P6 entries)
//   2. Load p4-spelling-list.json
//   3. Find P4 words NOT already in the bank, length 2 or 4 chars only
//      (PSLE doesn't test 3-char nouns or 5+ char sayings)
//   4. Gemini classify: STRICT filter — only abstract verb/adj/idiom,
//      drop narrative nouns and lesson-specific words
//   5. Gemini enrich kept entries (pinyin / 中文意思 / English / 2 samples)
//   6. Append to bank, save
//
// Use the same Gemini prompts as build-printable-wordlist.ts so the
// character of the bank stays consistent.

import * as fs from "fs";
import * as path from "path";
import { generateContentWithRetry } from "../src/lib/gemini";

type Entry = {
  word: string;
  chars: number;
  category: "2字词语" | "成语" | "关联词" | "短文填空" | "其他";
  source: "PSLE" | "P4" | "P5" | "P6" | "P5+P6" | "P4+P5" | "P4+P6" | "P4+P5+P6" | string;
  psleHistory?: string[];
  pinyin?: string;
  meaningZh?: string;
  meaningEn?: string;
  sample1?: string;
  sample2?: string;
  tier?: 1 | 2;
  pscore?: number;
};

type RawLesson = { lessonNumber: string | null; recogniseWords: string[]; writeWords: string[]; collocations: string[] };

function cjk(s: string): string { return s.replace(/[^一-鿿]/g, ""); }

const BANK_PATH = path.join(__dirname, "psle-chinese-study-bank.json");
const P4_PATH = path.join(__dirname, "p4-spelling-list.json");

const KEEP_TAG = "psle-likely";
const SKIP_TAG = "skip";

const CLASSIFY_PROMPT_HEAD = `你是新加坡 PSLE 华文老师。看下面每个词, 判断它是否是 PSLE Q5-Q8 (词语 / 词语解释) 可能考的"P5-P6 学生应该认识的抽象核心词汇"。

PSLE 不考的类型 (必须 skip):
- 具体名词:火山、长江、龙王、三国、玉石、太阳、月亮、电脑、书包
- 课文里的人名 / 地名 / 物品 / 食物 / 动物名
- 太基础的词:我们、东西、今天、明天、可以、应该
- 太罕见 / 太书面 / 太专业的词
- 课文情节里的具体细节

PSLE 喜欢考的类型 (keep):
- 抽象动词 / 形容词 / 副词 (描述情感、动作、态度、状态)
- 描述抽象状态的 4 字成语
- 关联词

回 JSON: { "<词>": "${KEEP_TAG}" | "${SKIP_TAG}" }, 每个词都要有判断。

词:
`;

async function classifyBatch(words: string[]): Promise<Record<string, string>> {
  const prompt = CLASSIFY_PROMPT_HEAD + words.map(w => `- ${w}`).join("\n");
  const res = await generateContentWithRetry({
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseMimeType: "application/json", temperature: 0.1 },
  }, 1, 2000, `p4-classify`);
  const text = (res.text ?? "").trim();
  const m = text.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : text); } catch { return {}; }
}

async function enrichBatch(items: Entry[]): Promise<Record<string, { pinyin: string; meaningZh: string; meaningEn: string; sample1: string; sample2: string }>> {
  const prompt = `你是新加坡 PSLE 华文教师。为下面每个词输出标准的学习信息。每个词要 5 项:
- pinyin: 标准拼音, 带声调
- meaningZh: 简单的中文解释 (10-20 字, P5-P6 学生能懂)
- meaningEn: English meaning (1 short phrase or sentence)
- sample1, sample2: 两个 P5-P6 程度的例句 (school / family / friends context)

返回 JSON ONLY:
{ "<词>": { "pinyin": "...", "meaningZh": "...", "meaningEn": "...", "sample1": "...", "sample2": "..." } }

词:
${items.map(it => `- ${it.word} (${it.category})`).join("\n")}`;
  const res = await generateContentWithRetry({
    model: "gemini-3.1-pro-preview",
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseMimeType: "application/json", temperature: 0.2 },
  }, 1, 3000, "p4-enrich");
  const text = (res.text ?? "").trim();
  const m = text.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m ? m[0] : text); } catch { return {}; }
}

(async () => {
  const bank = JSON.parse(fs.readFileSync(BANK_PATH, "utf8")) as Entry[];
  console.log(`Existing bank: ${bank.length} entries`);
  const existingByWord = new Map(bank.map(e => [e.word, e] as const));

  const p4 = (JSON.parse(fs.readFileSync(P4_PATH, "utf8")) as { lessons: RawLesson[] }).lessons;

  // Gather P4 candidates that aren't already in the bank.
  // Restrict to 2 and 4 char (PSLE rarely tests 3-char nouns or 5+ char sayings).
  type Candidate = { word: string; chars: number; category: Entry["category"]; isCollocation: boolean };
  const collocSet = new Set<string>();
  for (const r of p4) for (const c of r.collocations) collocSet.add(c);

  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const r of p4) {
    for (const w of [...r.recogniseWords, ...r.writeWords, ...r.collocations]) {
      const c = cjk(w);
      if (c.length !== 2 && c.length !== 4) continue;
      if (seen.has(w)) continue;
      seen.add(w);
      if (existingByWord.has(w)) {
        // Word already in bank — mark its source as including P4 so the
        // printable shows it correctly.
        const ex = existingByWord.get(w)!;
        if (ex.source !== "PSLE" && !ex.source.includes("P4")) {
          ex.source = ex.source ? `P4+${ex.source}` : "P4";
        }
        continue;
      }
      const category: Entry["category"] = collocSet.has(w)
        ? "搭配" as never  // not in the type, drop to 2字词语 below
        : c.length === 4 ? "成语" : "2字词语";
      // We don't have a separate 搭配 category in the bank; treat collocations
      // as 2字词语 if they're 2-char (rare) or 成语 if 4-char.
      candidates.push({
        word: w,
        chars: c.length,
        category: c.length === 4 ? "成语" : "2字词语",
        isCollocation: collocSet.has(w),
      });
    }
  }
  console.log(`P4 candidates (not in bank, 2 or 4 char): ${candidates.length}`);

  // Classify in batches of 30
  const BATCH = 30;
  const classMap: Record<string, string> = {};
  console.log(`Classifying with STRICT noun-rejection filter...`);
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    try {
      const out = await classifyBatch(batch.map(c => c.word));
      Object.assign(classMap, out);
      process.stdout.write(`  ${Math.min(i + BATCH, candidates.length)}/${candidates.length}\r`);
    } catch (err) {
      console.error(`  batch failed: ${(err as Error).message}`);
    }
  }
  console.log();

  const kept = candidates.filter(c => classMap[c.word] === KEEP_TAG);
  console.log(`After classify: ${kept.length} kept (out of ${candidates.length})\n`);

  // Enrich kept entries
  const newEntries: Entry[] = kept.map(c => ({
    word: c.word, chars: c.chars, category: c.category, source: "P4",
  }));

  console.log(`Enriching ${newEntries.length} kept entries with gemini-3.1-pro-preview...`);
  const E_BATCH = 8;
  const PARALLEL = 3;
  for (let i = 0; i < newEntries.length; i += E_BATCH * PARALLEL) {
    const tasks: Promise<void>[] = [];
    for (let j = 0; j < PARALLEL; j++) {
      const start = i + j * E_BATCH;
      if (start >= newEntries.length) break;
      const batch = newEntries.slice(start, start + E_BATCH);
      tasks.push(enrichBatch(batch).then(out => {
        for (const e of batch) {
          const info = out[e.word];
          if (info) Object.assign(e, info);
        }
      }).catch(err => { console.error(`  batch ${start} failed: ${(err as Error).message}`); }));
    }
    await Promise.all(tasks);
    process.stdout.write(`  ${Math.min(i + E_BATCH * PARALLEL, newEntries.length)}/${newEntries.length}\r`);
  }
  console.log();

  // Drop any entries we failed to enrich
  const enriched = newEntries.filter(e => e.pinyin && e.meaningZh);
  console.log(`Enriched successfully: ${enriched.length} / ${newEntries.length}`);

  // Merge into bank
  const merged = [...bank, ...enriched];
  fs.writeFileSync(BANK_PATH, JSON.stringify(merged, null, 2), "utf8");
  console.log(`\nBank size: ${bank.length} → ${merged.length}`);

  // Counts
  const sourceCounts: Record<string, number> = {};
  for (const e of merged) sourceCounts[e.source] = (sourceCounts[e.source] ?? 0) + 1;
  console.log(`By source:`);
  for (const [s, n] of Object.entries(sourceCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s}: ${n}`);
  }
})();
