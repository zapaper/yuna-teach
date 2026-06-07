// Fix the 3 broken entries in the printable wordlist:
//   1. "不慌不忙地" → "不慌不忙" (trailing 地 particle)
//   2. "的详情" → "详情" (leading 的 particle)
//   3. "漫（过）" → drop (OCR artifact with parens)
//
// Also scan for any other entries with leading/trailing particles
// (地, 着, 了, 的, 得, 也) that should be stripped, OR contain
// parens/punctuation that shouldn't be there.

import * as fs from "fs";
import * as path from "path";
import { generateContentWithRetry } from "../src/lib/gemini";

type Entry = {
  word: string;
  chars: number;
  category: string;
  source: string;
  psleHistory?: string[];
  pinyin?: string;
  meaningZh?: string;
  meaningEn?: string;
  sample1?: string;
  sample2?: string;
};

function cjk(s: string): string { return s.replace(/[^一-鿿]/g, ""); }

const TRAILING_PARTICLES = ["地", "着", "了", "得"];
const LEADING_PARTICLES = ["的", "也"];

function cleanWord(w: string): { cleaned: string; changed: boolean; reason: string } {
  let cleaned = w;
  let reason = "";
  // Drop anything with parens / non-CJK
  if (/[（）()\s]/.test(cleaned)) {
    const onlyCjk = cjk(cleaned);
    if (onlyCjk.length >= 2 && onlyCjk.length <= 4) {
      reason += `stripped non-CJK; `;
      cleaned = onlyCjk;
    } else {
      return { cleaned: "", changed: true, reason: "dropped: non-cjk content" };
    }
  }
  // Strip trailing particle
  for (const p of TRAILING_PARTICLES) {
    if (cleaned.length > 2 && cleaned.endsWith(p)) {
      cleaned = cleaned.slice(0, -1);
      reason += `dropped trailing ${p}; `;
    }
  }
  // Strip leading particle
  for (const p of LEADING_PARTICLES) {
    if (cleaned.length > 2 && cleaned.startsWith(p)) {
      cleaned = cleaned.slice(1);
      reason += `dropped leading ${p}; `;
    }
  }
  return { cleaned, changed: cleaned !== w, reason };
}

(async () => {
  const jsonPath = path.join(__dirname, "psle-chinese-study-bank.json");
  const bank = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as Entry[];

  // Find entries needing cleanup
  const needCleaning: Array<{ original: Entry; cleaned: string; reason: string }> = [];
  for (const e of bank) {
    const { cleaned, changed, reason } = cleanWord(e.word);
    if (changed) needCleaning.push({ original: e, cleaned, reason });
  }
  console.log(`Found ${needCleaning.length} entries needing cleanup:`);
  for (const c of needCleaning) {
    console.log(`  "${c.original.word}" → "${c.cleaned}"  (${c.reason})`);
  }

  // Apply cleanup. If a cleaned word already exists in the bank, MERGE
  // (keep the existing enrichment + add psleHistory). If the cleaned
  // word is empty, mark for removal.
  const existingWords = new Set(bank.map(b => b.word));
  const toRemove = new Set<string>();
  const toReenrich: Entry[] = [];

  for (const c of needCleaning) {
    const oldEntry = c.original;
    toRemove.add(oldEntry.word);

    if (!c.cleaned) continue;
    if (existingWords.has(c.cleaned)) {
      // Merge psleHistory into existing
      const existing = bank.find(b => b.word === c.cleaned)!;
      if (oldEntry.psleHistory) {
        existing.psleHistory = [...new Set([...(existing.psleHistory ?? []), ...oldEntry.psleHistory])];
      }
    } else {
      // Need to create a new entry with cleaned word + re-enrich
      const newEntry: Entry = {
        word: c.cleaned,
        chars: c.cleaned.length,
        category: oldEntry.category,
        source: oldEntry.source,
        psleHistory: oldEntry.psleHistory,
      };
      toReenrich.push(newEntry);
    }
  }

  // Re-enrich the new clean entries.
  if (toReenrich.length > 0) {
    console.log(`\nEnriching ${toReenrich.length} cleaned entries...`);
    const prompt = `你是新加坡 PSLE 华文教师。为下面每个词输出标准的学习信息。每个词要 4 项:
- pinyin: 标准拼音，带声调
- meaningZh: 简单的中文解释 (10-20 字，P5-P6 学生能懂)
- meaningEn: English meaning (1 short phrase)
- sample1, sample2: 两个 P5-P6 程度的例句 (school/family/friends context)

返回 JSON ONLY:
{ "<词>": { "pinyin": "...", "meaningZh": "...", "meaningEn": "...", "sample1": "...", "sample2": "..." } }

词:
${toReenrich.map(e => `- ${e.word} (${e.category})`).join("\n")}`;

    const res = await generateContentWithRetry({
      model: "gemini-3.1-pro-preview",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json", temperature: 0.2 },
    }, 1, 3000, "fix-enrich");
    const text = (res.text ?? "").trim();
    const m = text.match(/\{[\s\S]*\}/);
    try {
      const out = JSON.parse(m ? m[0] : text);
      for (const e of toReenrich) {
        const info = out[e.word];
        if (info) Object.assign(e, info);
      }
    } catch {
      console.log("  enrichment parse failed");
    }
  }

  // Apply changes to bank
  const newBank = bank.filter(e => !toRemove.has(e.word));
  for (const e of toReenrich) newBank.push(e);

  // Re-sort
  const CAT_ORDER = ["2字词语", "成语", "关联词", "短文填空"];
  newBank.sort((a, b) => {
    const cd = CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category);
    if (cd !== 0) return cd;
    if (a.source === "PSLE" && b.source !== "PSLE") return -1;
    if (b.source === "PSLE" && a.source !== "PSLE") return 1;
    return a.word.localeCompare(b.word);
  });

  fs.writeFileSync(jsonPath, JSON.stringify(newBank, null, 2), "utf8");
  console.log(`\nUpdated ${jsonPath}: ${bank.length} → ${newBank.length} entries`);

  // ─── Regenerate the markdown ──────────────────────────────────────
  const md: string[] = [];
  md.push("# PSLE 华文词汇学习卡 — 高频候选词\n");
  md.push(`*把这页打印出来，让孩子带回家慢慢背。每个词配有拼音、中文意思、English meaning 和 2 句例句。*\n`);
  md.push(`**来源:**`);
  md.push(`- 🏆 **PSLE 真题归纳** — 6 年 PSLE 真考过的词 (Q5-Q15 + 短文填空)`);
  md.push(`- 📘 **P5/P6 词语单候选** — 课本词语单里和 PSLE 风格相符的核心词`);
  md.push(`\n**怎么用这页:**`);
  md.push(`1. 先看 🏆 部分 — 这些是 PSLE 一定考过的词，要全部认识`);
  md.push(`2. 再看 📘 部分 — 这些是 PSLE 可能考的同类词，越早认识越好`);
  md.push(`3. 每天背 10-15 个，每周复习一次`);

  const grouped = {
    "2字词语": newBank.filter(e => e.category === "2字词语"),
    "成语": newBank.filter(e => e.category === "成语"),
    "关联词": newBank.filter(e => e.category === "关联词"),
    "短文填空": newBank.filter(e => e.category === "短文填空"),
  };

  function emitTable(title: string, entries: Entry[], extraNote = "") {
    const psleCount = entries.filter(e => e.source === "PSLE").length;
    const candCount = entries.length - psleCount;
    md.push(`\n## ${title}  (${entries.length} 个 — ${psleCount} 真题 🏆 + ${candCount} 候选 📘)\n`);
    if (extraNote) md.push(extraNote + "\n");
    md.push(`| 词 | 拼音 | 中文意思 | English | 例句 1 | 例句 2 | 来源 |`);
    md.push(`|----|------|----------|---------|---------|---------|------|`);
    for (const e of entries) {
      const src = e.source === "PSLE" ? "🏆" : "📘 " + e.source;
      md.push(`| **${e.word}** | ${e.pinyin ?? "—"} | ${e.meaningZh ?? "—"} | ${e.meaningEn ?? "—"} | ${e.sample1 ?? "—"} | ${e.sample2 ?? "—"} | ${src} |`);
    }
  }

  emitTable("一、二字词语 (Q5-Q6 / Q13-Q15 风格)", grouped["2字词语"], "考的是抽象动词、形容词、情感动作词。这一类最容易丢分。");
  emitTable("二、四字成语 (Q7-Q8 风格)", grouped["成语"], "考的是成语的真正意思 (不是字面意思)。背的时候要连\"用在什么场景\"一起记。");
  emitTable("三、关联词 (Q9-Q10)", grouped["关联词"], "数量少，但每年都考。务必全部背熟。");
  emitTable("四、短文填空高频词 (Q16-Q20)", grouped["短文填空"], "短文填空的正确答案。这些词每年都换，但风格类似。");

  const outPath = path.join(__dirname, "..", "..", "documents", "PSLE 华文词汇学习卡 (打印用).md");
  fs.writeFileSync(outPath, md.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);

  // Verify no more gaps
  const stillBlank = newBank.filter(e => !e.pinyin || !e.meaningZh);
  console.log(`\nRemaining blank entries: ${stillBlank.length}`);
  for (const b of stillBlank) console.log(`  ${b.word}`);
})();
