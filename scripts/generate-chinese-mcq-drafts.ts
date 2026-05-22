// Generate Chinese MCQ drafts from the Tier 1 study-bank wordlist.
//
// Priority order (high-value words first):
//   1. PSLE-history correct-answer words (16 words) — known PSLE shape
//   2. PSLE-history distractor + Q7-Q8 + Q13-Q15 words (~49 words)
//   3. Top P5/P6 candidates (Gemini score=5, ~286 words) — predictive
//
// Each seed word produces 1-2 PSLE-style MCQs via gemini-3.1-pro-preview.
// MCQ shape is chosen by word category:
//   - 2字词语   → Q5-Q6 style (sentence with blank + 4 word options)
//   - 成语      → Q7-Q8 style (sentence with bolded idiom + 4 paraphrase
//                  options) — most reliable since explanations are
//                  what Q7-Q8 actually tests
//   - 关联词    → Q9-Q10 style (sentence with blank + 4 connector options)
//   - 短文填空  → SKIP for now (cloze needs passage context — generate
//                  later when we want to seed mini-passages)
//
// Output:
//   scripts/chinese-mcq-drafts.json   (machine-readable, full data)
//   scripts/chinese-mcq-drafts.md     (human-readable for review)
//
// User reviews the .md file, marks which drafts to KEEP, then a
// follow-up script promotes them into the synthetic bank.

import * as fs from "fs";
import * as path from "path";
import { generateContentWithRetry } from "../src/lib/gemini";

const BANK_PATH = path.join(__dirname, "psle-chinese-study-bank.json");
const OUT_JSON = path.join(__dirname, "chinese-mcq-drafts.json");
const OUT_MD = path.join(__dirname, "chinese-mcq-drafts.md");

type BankEntry = {
  word: string;
  chars: number;
  category: string;
  source: string;
  tier?: 1 | 2;
  pscore?: number;
  pinyin?: string;
  meaningZh?: string;
  meaningEn?: string;
  sample1?: string;
  sample2?: string;
  psleHistory?: string[];
};

type Draft = {
  seedWord: string;
  seedMeaning: string;
  shape: "Q5-Q6" | "Q7-Q8" | "Q9-Q10";
  stem: string;
  options: string[];
  correctAnswer: number; // 1-4
  explanation: string;
  syllabusTopic: string;
  subTopic: string;
  priority: number; // lower = higher priority
};

function shapeFor(entry: BankEntry): Draft["shape"] | null {
  if (entry.category === "成语") return "Q7-Q8";
  if (entry.category === "关联词") return "Q9-Q10";
  if (entry.category === "2字词语") return "Q5-Q6";
  return null; // skip 短文填空 etc.
}

function priorityFor(entry: BankEntry): number {
  // Lower = higher priority:
  //   0  = was a CORRECT answer in PSLE history
  //   1  = was a distractor / stem / Q13-Q15 target in PSLE history
  //   2  = P5/P6 candidate, score=5 (highest predictive)
  //   3  = P5/P6 candidate, score<5
  if (entry.source === "PSLE") {
    const wasCorrect = entry.psleHistory?.some(h => /correct/.test(h));
    return wasCorrect ? 0 : 1;
  }
  if (entry.pscore === 5) return 2;
  return 3;
}

// ─── Prompts per shape ───────────────────────────────────────────
function promptFor(entry: BankEntry, shape: Draft["shape"]): string {
  const head = `你是新加坡 PSLE 华文老师。请按 PSLE Booklet A 的风格出一道选择题, 用下面这个种子词:
词:    ${entry.word}
拼音:  ${entry.pinyin ?? "(unknown)"}
释义:  ${entry.meaningZh ?? "(unknown)"}
例句:  ${entry.sample1 ?? "(none)"} / ${entry.sample2 ?? "(none)"}

`;

  if (shape === "Q5-Q6") {
    return head + `题型: PSLE Q5-Q6 词语题。
要求:
- 写一个 1-2 句话的句子, 中间留一个空格 (用 ___ 表示)
- 句子用 P5-P6 学生能懂的语言, 贴近学校 / 家庭 / 朋友的场景
- 正确答案就是种子词 "${entry.word}"
- 写 3 个 plausible 但 wrong 的干扰选项 (近义词或同类词, 但放在这个句子里不对)
- 4 个选项都是 2 字词语
- 简短解释为什么正确答案对、其他错

返回 JSON ONLY:
{ "stem": "...", "options": ["correct", "distractor1", "distractor2", "distractor3"], "correctAnswer": 1, "explanation": "..." }

注意:
- correctAnswer 总是 1 (正确答案在第一个) — 我会自己 shuffle
- explanation 用中文, 简短 (1-2 句)
- 整道题不能太难、不能太简单, 难度匹配 PSLE P5-P6`;
  }

  if (shape === "Q7-Q8") {
    return head + `题型: PSLE Q7-Q8 词语解释题。
要求:
- 写一个 1-2 句话的句子, 句中包含种子词 "${entry.word}" (用 **${entry.word}** 加粗)
- 4 个选项是对这个词的不同解释 (1 句话各, 长度差不多)
- 正确答案是种子词的真正意思
- 3 个干扰选项是"字面意思"或"看起来对但不准确"的解释
- 简短解释为什么正确答案对

返回 JSON ONLY:
{ "stem": "...", "options": ["correct meaning", "wrong1", "wrong2", "wrong3"], "correctAnswer": 1, "explanation": "..." }

注意: correctAnswer 总是 1, 我会自己 shuffle。整体难度匹配 PSLE P5-P6。`;
  }

  if (shape === "Q9-Q10") {
    return head + `题型: PSLE Q9-Q10 关联词题。
要求:
- 写一个有两个分句的句子, 在 1 个或 2 个位置留空 (用 ___ 表示) — 这要看 "${entry.word}" 是单个关联词还是配对
- 正确答案的关联词 ("${entry.word}") 把两个分句合理地连起来
- 3 个干扰选项是其他关联词, 但语义关系不对 (因果 / 转折 / 条件 / 递进)
- 简短解释为什么正确答案对、其他错

返回 JSON ONLY:
{ "stem": "...", "options": ["correct", "distractor1", "distractor2", "distractor3"], "correctAnswer": 1, "explanation": "..." }

注意: correctAnswer 总是 1, 我会自己 shuffle。难度匹配 PSLE P5-P6。`;
  }

  throw new Error("unknown shape");
}

// Fisher-Yates shuffle that also returns the new index of the correct
// answer (originally at index 0).
function shuffleOptions(opts: string[]): { shuffled: string[]; correctIdx: number } {
  const arr = opts.slice();
  // Track original index of [0] (the correct one).
  let correctIdx = 0;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    if (correctIdx === i) correctIdx = j;
    else if (correctIdx === j) correctIdx = i;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return { shuffled: arr, correctIdx };
}

async function generateForSeed(entry: BankEntry, shape: Draft["shape"]): Promise<Draft | null> {
  const prompt = promptFor(entry, shape);
  try {
    const res = await generateContentWithRetry({
      model: "gemini-3.1-pro-preview",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json", temperature: 0.6 },
    }, 1, 3000, `seed-${entry.word}`);
    const text = (res.text ?? "").trim();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as {
      stem?: string; options?: string[]; correctAnswer?: number; explanation?: string;
    };
    if (!parsed.stem || !Array.isArray(parsed.options) || parsed.options.length !== 4) return null;
    // Shuffle so correct isn't always (1)
    const { shuffled, correctIdx } = shuffleOptions(parsed.options);

    // syllabusTopic + subTopic mapping
    const isCloze = entry.category === "短文填空";
    return {
      seedWord: entry.word,
      seedMeaning: entry.meaningZh ?? "",
      shape,
      stem: parsed.stem,
      options: shuffled,
      correctAnswer: correctIdx + 1,
      explanation: String(parsed.explanation ?? ""),
      syllabusTopic: isCloze ? "短文填空" : "语文应用 MCQ",
      subTopic:
        shape === "Q5-Q6" ? "vocabulary" :
        shape === "Q7-Q8" ? "idiom" :
        shape === "Q9-Q10" ? "connectors" :
        "vocabulary",
      priority: priorityFor(entry),
    };
  } catch (err) {
    console.error(`  ${entry.word} FAILED: ${(err as Error).message}`);
    return null;
  }
}

(async () => {
  const bank = JSON.parse(fs.readFileSync(BANK_PATH, "utf8")) as BankEntry[];

  // Filter to seedable entries + sort by priority
  const seedable: BankEntry[] = bank
    .filter(e => shapeFor(e) !== null)
    .filter(e => e.tier === 1)  // Tier 1 only — high-priority subset
    .sort((a, b) => priorityFor(a) - priorityFor(b));

  console.log(`Tier 1 seedable entries: ${seedable.length}`);
  // Limit to first run — 100 drafts is enough to validate the approach
  const LIMIT = 100;
  const slice = seedable.slice(0, LIMIT);
  console.log(`Generating drafts for the top ${slice.length} entries (priority-ordered).\n`);

  const drafts: Draft[] = [];
  // Generate sequentially (pro model is slow + we want to stay under
  // any per-second rate limits). Could parallelise 2-3 if needed.
  for (let i = 0; i < slice.length; i++) {
    const entry = slice[i];
    const shape = shapeFor(entry)!;
    process.stdout.write(`[${i + 1}/${slice.length}] ${entry.word} (${shape}, prio=${priorityFor(entry)})... `);
    const draft = await generateForSeed(entry, shape);
    if (draft) {
      drafts.push(draft);
      process.stdout.write("✓\n");
    } else {
      process.stdout.write("✗\n");
    }
  }

  fs.writeFileSync(OUT_JSON, JSON.stringify(drafts, null, 2), "utf8");

  // ─── Human-readable markdown for review ──────────────────────────
  const md: string[] = [];
  md.push("# Chinese MCQ Drafts — for review\n");
  md.push(`Generated ${drafts.length} drafts from Tier 1 wordlist seed words.\n`);
  md.push(`Priority order: PSLE correct-answer history → PSLE distractor history → P5/P6 candidates (score 5) → other.\n`);
  md.push(`**Reviewer:** mark each draft with ✓ KEEP or ✗ DROP. After you've gone through them, I'll batch-import the kept ones into the synthetic bank.\n`);

  for (const cat of ["Q5-Q6", "Q7-Q8", "Q9-Q10"] as const) {
    const subset = drafts.filter(d => d.shape === cat);
    if (subset.length === 0) continue;
    md.push(`\n## ${cat} drafts (${subset.length})\n`);
    for (let i = 0; i < subset.length; i++) {
      const d = subset[i];
      md.push(`\n### [${cat}-${i + 1}]  种子词: **${d.seedWord}**  (${d.seedMeaning})  priority=${d.priority}`);
      md.push(``);
      md.push(`**Stem:** ${d.stem}`);
      md.push(``);
      d.options.forEach((o, j) => {
        const marker = j + 1 === d.correctAnswer ? "✓" : " ";
        md.push(`- ${marker} (${j + 1}) ${o}`);
      });
      md.push(``);
      md.push(`**Explanation:** ${d.explanation}`);
      md.push(``);
      md.push(`**Verdict:** ☐ KEEP   ☐ DROP   (write your choice)`);
    }
  }

  fs.writeFileSync(OUT_MD, md.join("\n"), "utf8");

  console.log(`\nDone.`);
  console.log(`  ${OUT_JSON}  (${drafts.length} drafts, full JSON)`);
  console.log(`  ${OUT_MD}  (human-readable for review)`);
  console.log(`\nBy shape:`);
  console.log(`  Q5-Q6:  ${drafts.filter(d => d.shape === "Q5-Q6").length}`);
  console.log(`  Q7-Q8:  ${drafts.filter(d => d.shape === "Q7-Q8").length}`);
  console.log(`  Q9-Q10: ${drafts.filter(d => d.shape === "Q9-Q10").length}`);
  console.log(`\nBy priority:`);
  for (let p = 0; p <= 3; p++) {
    console.log(`  ${p}: ${drafts.filter(d => d.priority === p).length}`);
  }
})();
