// Score every P5+P6 candidate 1-5 for "how closely does this word
// match PSLE Q5-Q15 correct-answer shape?". Then re-assign tier:
//   - PSLE history entries → Tier 1 (always)
//   - Top candidates by score → Tier 1 until we hit ~200 total candidates
//   - Remaining candidates → Tier 2

import * as fs from "fs";
import * as path from "path";
import { generateContentWithRetry } from "../src/lib/gemini";

type Entry = {
  word: string;
  chars: number;
  category: string;
  source: "PSLE" | "P5" | "P6" | "P5+P6" | string;
  psleHistory?: string[];
  pinyin?: string;
  meaningZh?: string;
  meaningEn?: string;
  sample1?: string;
  sample2?: string;
  tier?: 1 | 2;
  pscore?: number;   // 1-5 PSLE-likelihood score (NEW)
};

// Tier 1 leans on PREDICTIVE candidates rather than historical PSLE
// because PSLE rarely repeats vocabulary. Historical Q5-Q6 / Q13-Q15
// / 短文填空 correct answers go to Tier 2 (exposure, not must-know).
// Tier 1 PSLE-history is limited to the SMALL FIXED pools that
// actually recur: 关联词 (~26 forms cover Q9-Q10 every year) and
// 成语 (the 10 historical idioms — worth memorising even though
// they rotate, because idioms are dense info).
//
// Candidate slots are allocated PER CATEGORY so the deck stays
// balanced across PSLE question shapes (otherwise idioms crowd out
// the 二字词语 that drive Q5-Q6 / Q13-Q15, which are the biggest
// mark contributors).
const TIER1_CANDIDATE_BY_CAT: Record<string, number> = {
  "2字词语": 60,        // Q5-Q6 and Q13-Q15 stem-fill, biggest PSLE share
  "成语": 30,           // Q7-Q8 + Q13-Q15 idiom slots
  "关联词": 999,        // small fixed pool — take all candidates we have
  "短文填空": 20,       // Q16-Q20 cloze, mostly 2-char verbs/adj
};

(async () => {
  const jsonPath = path.join(__dirname, "psle-chinese-study-bank.json");
  const bank = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as Entry[];

  const candidates = bank.filter(e => e.source !== "PSLE");
  console.log(`Scoring ${candidates.length} candidates 1-5...`);

  // PSLE anchors for the prompt
  const anchors2 = ["陶醉", "贡献", "遵守", "充足", "保护", "解释", "支持", "讨论", "抱怨", "妒忌", "后悔", "迅速"];
  const anchors4 = ["恍然大悟", "垂头丧气", "津津有味", "目不转睛", "神机妙算", "一言为定", "左思右想", "不慌不忙"];

  async function scoreBatch(words: Entry[]): Promise<Record<string, number>> {
    const prompt = `你是新加坡 PSLE 华文老师。我把"PSLE Q5-Q15 真题正确答案"列在下面作为参考:
- 2字: ${anchors2.join("、")}
- 4字: ${anchors4.join("、")}

这些 PSLE 真题答案有3个共同特点:
1. 词义是抽象的情感 / 动作 / 态度 / 状态 (不是具体名词或人名)
2. 难度在 P5-P6 (不是 P3 太基础，也不是初中太书面)
3. 在小学生日常生活、学校、家庭场景里有用

现在请给下面每个候选词打 1-5 分，标准:
- 5 分 = 这个词和 PSLE 真题答案高度同质，下一年 PSLE 出这个词的可能性很大
- 4 分 = 风格匹配，可能出
- 3 分 = 有点像，不排除
- 2 分 = 不太可能 (太基础或太书面)
- 1 分 = 几乎不可能 (太具体、太特殊、或过于专业)

返回 JSON 格式: { "<词>": <1-5 的整数> }，每个词都要有分数。

候选词:
${words.map(w => `- ${w.word} (${w.category}${w.meaningZh ? `: ${w.meaningZh}` : ""})`).join("\n")}`;

    const res = await generateContentWithRetry({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json", temperature: 0.1 },
    }, 1, 2000, "score");
    const text = (res.text ?? "").trim();
    const m = text.match(/\{[\s\S]*\}/);
    try { return JSON.parse(m ? m[0] : text); } catch { return {}; }
  }

  const needsScoring = candidates.filter(c => c.pscore === undefined);
  if (needsScoring.length === 0) {
    console.log("All candidates already scored — skipping Gemini and re-tiering only.");
  } else {
    const BATCH = 25;
    for (let i = 0; i < needsScoring.length; i += BATCH) {
      const batch = needsScoring.slice(i, i + BATCH);
      try {
        const scores = await scoreBatch(batch);
        for (const e of batch) {
          const s = parseInt(String(scores[e.word] ?? 3), 10);
          e.pscore = Math.max(1, Math.min(5, isNaN(s) ? 3 : s));
        }
        process.stdout.write(`  ${Math.min(i + BATCH, needsScoring.length)}/${needsScoring.length}\r`);
      } catch (err) {
        console.error(`\n  batch ${i} failed:`, (err as Error).message);
        for (const e of batch) e.pscore = e.pscore ?? 3;
      }
    }
    console.log();
  }

  // Tier 1 PSLE-history inclusion — VERY restrictive. PSLE rotates
  // vocabulary every year (only ~5-17% of test-position words repeat
  // across 2+ papers), so historical correct answers are NOT
  // particularly predictive of next year's questions. We keep only
  // the two small pools that genuinely DO recur:
  //   - 关联词 (Q9-Q10): ~26 forms cover every paper
  //   - 成语 (Q7-Q8 / Q13-Q15): worth memorising even though they
  //     rotate, because idioms are dense info and small in number
  // Everything else from PSLE history (Q5-Q6 / Q13-Q15 targets /
  // 短文填空 correct answers) moves to Tier 2 — useful exposure but
  // not "must-know" since PSLE won't pick the same word again.
  function isTier1PsleHistory(e: Entry): boolean {
    if (e.source !== "PSLE") return false;
    if (e.category === "关联词") return true;
    if (e.category === "成语") return true;
    return false;
  }

  // First pass: tier PSLE-history by the rules above.
  for (const e of bank.filter(b => b.source === "PSLE")) {
    e.tier = isTier1PsleHistory(e) ? 1 : 2;
  }

  // Default everyone to Tier 2, then promote top-N PER CATEGORY by score.
  for (const c of candidates) c.tier = 2;

  for (const [cat, limit] of Object.entries(TIER1_CANDIDATE_BY_CAT)) {
    const inCat = candidates
      .filter(c => c.category === cat)
      .sort((a, b) => {
        if ((b.pscore ?? 0) !== (a.pscore ?? 0)) return (b.pscore ?? 0) - (a.pscore ?? 0);
        return a.word.localeCompare(b.word);
      });
    for (let i = 0; i < Math.min(limit, inCat.length); i++) {
      inCat[i].tier = 1;
    }
  }

  fs.writeFileSync(jsonPath, JSON.stringify(bank, null, 2), "utf8");

  const tier1 = bank.filter(e => e.tier === 1);
  const tier2 = bank.filter(e => e.tier === 2);
  const psleT1 = tier1.filter(e => e.source === "PSLE").length;
  const candT1 = tier1.length - psleT1;
  console.log(`\nTier 1: ${tier1.length} (${psleT1} PSLE history + ${candT1} top-scoring candidates)`);
  console.log(`Tier 2: ${tier2.length}`);
  const t1ByCat: Record<string, number> = {};
  for (const e of tier1) t1ByCat[e.category] = (t1ByCat[e.category] ?? 0) + 1;
  console.log("Tier 1 by category:", t1ByCat);

  // Score distribution print
  const scoreDist: Record<number, number> = {};
  for (const c of candidates) scoreDist[c.pscore ?? 0] = (scoreDist[c.pscore ?? 0] ?? 0) + 1;
  console.log(`\nScore distribution (candidates only):`);
  for (let s = 5; s >= 1; s--) {
    console.log(`  ${s}: ${scoreDist[s] ?? 0}`);
  }
})();
