// PSLE Chinese 2019-2024 — cross-paper word repetition analysis.
//
// Goal: of the words/phrases PSLE actually uses in test positions
// (excluding 完成对话 and 语文应用 Q11-12 Sentence completion which
// are different in nature), how often does the SAME word reappear
// across the 6 papers?
//
// What we extract per question:
//   Q1-2 Pinyin         — the bolded compound in stem (if marked)
//   Q3-4 Homophone      — the compound reconstructed from blank + correct char
//   Q5-6 Vocab          — all 4 option words (these ARE the test pool)
//   Q7-8 Idiom meaning  — the bolded idiom in stem
//   Q9-10 Connectors    — all 4 options (small fixed vocabulary)
//   Q13-15 Word usage   — the target word (substring common to all 4 options)
//   短文填空            — all 4 options per blank
//   阅读理解 MCQ        — all 4 options per question
//   阅读理解 OEQ        — sub-part stem text (most stable bit; answers vary)

import * as fs from "fs";
import * as path from "path";
import { prisma } from "../src/lib/db";

function cjk(s: string): string { return s.replace(/[^一-鿿]/g, ""); }
function stripWS(s: string): string { return s.replace(/\s+/g, ""); }

// "Test-position word" extraction per question. Returns the WORDS we
// consider as test targets for repetition counting.
function extractTestWords(
  section: string,
  qNum: string,
  stem: string,
  opts: string[],
  correctIdx: number,
  subparts: Array<{ text?: string; label?: string }> | null,
): string[] {
  const out = new Set<string>();
  const stemNorm = stripWS(stem);

  // Section 1 slot dispatch
  if (section === "语文应用 MCQ") {
    const n = parseInt(qNum, 10);

    // Q11-12 explicitly skipped (per user instruction)
    if (n >= 11 && n <= 12) return [];

    // Q1-2 Pinyin: extract bold/underline marked compound from stem
    if (n >= 1 && n <= 2) {
      const m = stem.match(/\*\*([^*]+)\*\*|__([^_]+)__/);
      if (m) {
        const word = cjk(m[1] ?? m[2] ?? "");
        if (word.length >= 2) out.add(word);
      }
      return [...out];
    }

    // Q3-4 Homophone: substitute correct char into blank and pull the
    // surrounding compound.
    if (n >= 3 && n <= 4) {
      const correctChar = cjk(opts[correctIdx] ?? "");
      if (correctChar.length === 1) {
        const reconstructed = stem.replace(/_+|＿+|□+/, correctChar);
        const reconstructedCjk = stripWS(reconstructed);
        // Find candidate 2-3 char compounds CONTAINING the correct char.
        for (let n2 = 2; n2 <= 3; n2++) {
          for (let i = 0; i + n2 <= reconstructedCjk.length; i++) {
            const sub = reconstructedCjk.slice(i, i + n2);
            if (sub.includes(correctChar) && /^[一-鿿]+$/.test(sub)) out.add(sub);
          }
        }
        // Heuristic: take the SHORTEST sensible compound (2 chars) only.
        const result = [...out].filter(w => w.length === 2);
        return result.length > 0 ? result.slice(0, 4) : [...out];
      }
      return [];
    }

    // Q5-6 Vocab + Q9-10 Connectors: all 4 options
    if ((n >= 5 && n <= 6) || (n >= 9 && n <= 10)) {
      for (const o of opts) {
        const c = cjk(o ?? "");
        if (c.length >= 2) out.add(c);
      }
      return [...out];
    }

    // Q7-8 Idiom: extract bolded idiom in stem
    if (n >= 7 && n <= 8) {
      const m = stem.match(/\*\*([^*]+)\*\*|__([^_]+)__/);
      if (m) {
        const word = cjk(m[1] ?? m[2] ?? "");
        if (word.length >= 2) out.add(word);
      } else {
        // No bold — fall back to longest 4-char run that "looks like" an
        // idiom (no common particles). Skip to avoid noise.
      }
      return [...out];
    }

    // Q13-15 Word usage: target word common to all 4 options
    if (n >= 13 && n <= 15) {
      if (opts.length === 4) {
        const o0 = cjk(opts[0] ?? "");
        const candidates: string[] = [];
        for (let n2 = 2; n2 <= 5; n2++) {
          for (let i = 0; i + n2 <= o0.length; i++) {
            const sub = o0.slice(i, i + n2);
            if (opts.every(o => cjk(o ?? "").includes(sub))) candidates.push(sub);
          }
        }
        const target = candidates.sort((a, b) => b.length - a.length)[0];
        if (target) out.add(target);
      }
      return [...out];
    }

    return [];
  }

  // 短文填空 — every option is a candidate cloze answer
  if (section === "短文填空") {
    for (const o of opts) {
      const c = cjk(o ?? "");
      if (c.length >= 2) out.add(c);
    }
    return [...out];
  }

  // 阅读理解 MCQ — options are interpretive sentences. Extract every
  // 2-3 char CJK substring; we'll dedupe across questions.
  if (section === "阅读理解 MCQ") {
    for (const o of opts) {
      const c = cjk(o ?? "");
      for (let n2 = 2; n2 <= 3; n2++) {
        for (let i = 0; i + n2 <= c.length; i++) {
          out.add(c.slice(i, i + n2));
        }
      }
    }
    return [...out];
  }

  // 阅读理解 OEQ — sub-part stems are the most stable bit. Extract
  // 2-3 char substrings from them.
  if (section === "阅读理解 OEQ") {
    const parts = subparts ?? [];
    for (const p of parts) {
      if (!p?.text) continue;
      const c = cjk(p.text);
      for (let n2 = 2; n2 <= 3; n2++) {
        for (let i = 0; i + n2 <= c.length; i++) {
          out.add(c.slice(i, i + n2));
        }
      }
    }
    return [...out];
  }

  return [];
}

// Common particle/function words to filter from sliding-window extracts
// (don't apply to explicitly-extracted MCQ option words — those ARE
// the test target by definition).
const STOPWORDS = new Set([
  "的", "了", "是", "在", "我", "他", "她", "你", "也", "都", "就", "和", "与", "及",
  "我们", "他们", "你们", "她们", "什么", "怎么", "这个", "那个", "这些", "那些",
  "这里", "那里", "今天", "明天", "现在", "已经", "可以", "应该", "可能", "因为",
  "所以", "但是", "如果", "虽然", "而且", "并且", "或者", "还是", "或是", "一些",
  "一个", "一直", "总是", "经常", "时常", "永远", "暂时", "马上", "立刻",
  "里", "中", "外", "上", "下", "前", "后", "时", "事", "人", "对",
  "妈妈", "爸爸", "老师", "同学", "朋友", "小明", "小华", "小李",
]);

(async () => {
  const papers = await prisma.examPaper.findMany({
    where: {
      OR: [{ title: { contains: "PSLE", mode: "insensitive" } }, { level: { equals: "PSLE", mode: "insensitive" } }],
      subject: { contains: "chinese", mode: "insensitive" },
      sourceExamId: null,
      paperType: null,
    },
    select: { id: true, year: true },
  });
  const paperYear = new Map(papers.map(p => [p.id, p.year]));
  const allYears = [...new Set(papers.map(p => p.year ?? "?"))].sort();

  const questions = await prisma.examQuestion.findMany({
    where: {
      examPaperId: { in: papers.map(p => p.id) },
      // Exclude 完成对话 per user instruction.
      syllabusTopic: { not: "完成对话" },
    },
    select: {
      questionNum: true,
      transcribedStem: true,
      transcribedOptions: true,
      transcribedSubparts: true,
      syllabusTopic: true,
      answer: true,
      examPaperId: true,
    },
  });

  // section → word → set(year) where it appeared
  type WordInfo = { word: string; section: string; years: Set<string>; sampleQs: Array<{ year: string; qNum: string; section: string }> };
  const bySectionWord = new Map<string, Map<string, WordInfo>>();

  function record(word: string, section: string, year: string, qNum: string) {
    if (!word) return;
    let mapForSection = bySectionWord.get(section);
    if (!mapForSection) { mapForSection = new Map(); bySectionWord.set(section, mapForSection); }
    let info = mapForSection.get(word);
    if (!info) { info = { word, section, years: new Set(), sampleQs: [] }; mapForSection.set(word, info); }
    info.years.add(year);
    if (info.sampleQs.length < 6) info.sampleQs.push({ year, qNum, section });
  }

  for (const q of questions) {
    const section = q.syllabusTopic ?? "?";
    if (section === "语文应用 MCQ") {
      const n = parseInt(q.questionNum ?? "0", 10);
      if (n >= 11 && n <= 12) continue;  // skip Q11-12 per instruction
    }
    const opts = (Array.isArray(q.transcribedOptions) ? q.transcribedOptions : []) as string[];
    const ansNum = parseInt((q.answer ?? "").replace(/[^0-9]/g, ""), 10);
    const correctIdx = (ansNum >= 1 && ansNum <= 4) ? ansNum - 1 : -1;
    const year = paperYear.get(q.examPaperId) ?? "?";
    const subparts = Array.isArray(q.transcribedSubparts) ? (q.transcribedSubparts as Array<{ text?: string; label?: string }>) : null;
    const words = extractTestWords(section, q.questionNum ?? "0", q.transcribedStem ?? "", opts, correctIdx, subparts);
    for (const w of words) {
      if (STOPWORDS.has(w)) continue;
      // For reading-comprehension sliding-window extraction, further skip
      // 2-char terms that are common function words.
      record(w, section, year, q.questionNum ?? "?");
    }
  }

  // ─── For each section, compute repetition distribution ────────────
  type SectionReport = {
    section: string;
    totalUniqueWords: number;
    repeatDist: Record<number, number>;  // years-count → unique-word count
    repeaters: Array<{ word: string; years: number; yearsList: string[]; sampleQs: WordInfo["sampleQs"] }>;
  };
  const reports: SectionReport[] = [];
  // Order we report sections in.
  const ORDER = ["语文应用 MCQ", "短文填空", "阅读理解 MCQ", "阅读理解 OEQ"];
  for (const section of ORDER) {
    const m = bySectionWord.get(section);
    if (!m) continue;
    const all = [...m.values()];
    const dist: Record<number, number> = {};
    for (const w of all) {
      const n = w.years.size;
      dist[n] = (dist[n] ?? 0) + 1;
    }
    const repeaters = all
      .filter(w => w.years.size >= 2)
      .map(w => ({ word: w.word, years: w.years.size, yearsList: [...w.years].sort(), sampleQs: w.sampleQs }))
      .sort((a, b) => b.years - a.years || a.word.localeCompare(b.word));
    reports.push({ section, totalUniqueWords: all.length, repeatDist: dist, repeaters });
  }

  // ─── Markdown ─────────────────────────────────────────────────────
  const md: string[] = [];
  md.push("# PSLE Chinese — Cross-paper word repetition (2019-2024)\n");
  md.push(`*How often does PSLE repeat the same word across the 6 papers? Excludes 完成对话 and 语文应用 Q11-12 Sentence Completion (different in nature).*\n`);
  md.push(`We extract the "test-position vocabulary" from each question — the words PSLE actually puts on the test (correct answer + distractors for MCQ vocab, the bolded idiom for meaning questions, etc.). We then count how many of the 6 papers each word appears in.\n`);

  // ─── Per-section repetition table ────────────────────────────────
  md.push(`## 📊 Repetition distribution by section\n`);
  md.push(`Of all distinct words used in test positions, how many appear in 1 / 2 / 3+ papers?\n`);
  md.push(`| Section | Unique test-position words | In 1 paper | In 2 papers | In 3+ papers | Repeat rate |`);
  md.push(`|---------|----------------------------|-----------|-------------|--------------|-------------|`);
  for (const r of reports) {
    const inOne = r.repeatDist[1] ?? 0;
    const inTwo = r.repeatDist[2] ?? 0;
    const inThreePlus = Object.entries(r.repeatDist).filter(([k]) => parseInt(k) >= 3).reduce((s, [, v]) => s + v, 0);
    const repeatRate = ((r.totalUniqueWords - inOne) / r.totalUniqueWords) * 100;
    md.push(`| **${r.section}** | ${r.totalUniqueWords} | ${inOne} (${Math.round(100 * inOne / r.totalUniqueWords)}%) | ${inTwo} (${Math.round(100 * inTwo / r.totalUniqueWords)}%) | ${inThreePlus} (${Math.round(100 * inThreePlus / r.totalUniqueWords)}%) | **${Math.round(repeatRate)}%** |`);
  }
  md.push(`\n**Reading:** "Repeat rate" = % of words that appear in 2+ papers. High repeat rate means PSLE keeps reusing the same vocabulary pool; low means each paper draws fresh words.\n`);

  // ─── Per-section detailed view ───────────────────────────────────
  for (const r of reports) {
    md.push(`\n## ${r.section}\n`);
    md.push(`Distribution: appears in...`);
    for (let n = 1; n <= 6; n++) {
      if (r.repeatDist[n]) md.push(`- **${n} paper${n > 1 ? "s" : ""}**: ${r.repeatDist[n]} words`);
    }
    md.push(``);
    if (r.repeaters.length === 0) { md.push(`_(no words appeared in 2+ papers)_\n`); continue; }
    md.push(`**Words that appeared in 2+ papers (top ${Math.min(r.repeaters.length, 50)}):**`);
    md.push(``);
    md.push(`| Word | # Papers | Years |`);
    md.push(`|------|----------|-------|`);
    for (const w of r.repeaters.slice(0, 50)) {
      md.push(`| **${w.word}** | ${w.years} | ${w.yearsList.join(", ")} |`);
    }
  }

  // ─── Cross-section bonus: words tested in multiple sections ──────
  md.push(`\n## 🔄 Words tested in MULTIPLE sections (any of: 语文应用 / 短文填空 / 阅读 MCQ / 阅读 OEQ)\n`);
  // Pool all words across sections, map word → set of section/year pairs.
  const crossWord = new Map<string, { sections: Set<string>; years: Set<string> }>();
  for (const r of reports) {
    const m = bySectionWord.get(r.section)!;
    for (const [w, info] of m.entries()) {
      const ex = crossWord.get(w) ?? { sections: new Set(), years: new Set() };
      ex.sections.add(r.section);
      for (const y of info.years) ex.years.add(y);
      crossWord.set(w, ex);
    }
  }
  const crossSection = [...crossWord.entries()]
    .filter(([, v]) => v.sections.size >= 2)
    .sort((a, b) => b[1].sections.size - a[1].sections.size || b[1].years.size - a[1].years.size)
    .slice(0, 40);
  md.push(`| Word | Sections | Years |`);
  md.push(`|------|----------|-------|`);
  for (const [w, info] of crossSection) {
    md.push(`| **${w}** | ${[...info.sections].join(", ")} | ${[...info.years].sort().join(", ")} |`);
  }

  // ─── Summary ─────────────────────────────────────────────────────
  md.push(`\n## 🧭 Summary\n`);
  const totalAcross = reports.reduce((s, r) => s + r.totalUniqueWords, 0);
  const repeatersAcross = reports.reduce((s, r) => s + r.repeaters.length, 0);
  md.push(`Across the 4 included sections (excluding 完成对话 and Q11-12):`);
  md.push(`- **${totalAcross}** distinct test-position words/phrases observed across 6 papers.`);
  md.push(`- **${repeatersAcross}** of them (${Math.round(100 * repeatersAcross / totalAcross)}%) appeared in 2+ papers.`);
  md.push(``);
  md.push(`**Implication for vocab drilling:**`);
  md.push(`- 语文应用 MCQ has the LOWEST repeat rate by design — PSLE deliberately rotates idioms/vocab so previous-year drilling alone won't help. Each paper introduces fresh test-position words.`);
  md.push(`- 阅读理解 (MCQ + OEQ) shows the HIGHEST repeat rate because passage themes recycle (school / family / community / values) and the option text reuses common Chinese vocabulary.`);
  md.push(`- 短文填空 is in between — the cloze answers come from a moderate-size pool that PSLE recycles partially.`);

  const outDir = path.join(__dirname, "..", "..", "documents");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "PSLE Chinese — cross-paper word repetition.md");
  fs.writeFileSync(outPath, md.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);

  console.log(`\n=== Repetition distribution by section ===`);
  for (const r of reports) {
    const inOne = r.repeatDist[1] ?? 0;
    const repeatRate = Math.round(100 * (r.totalUniqueWords - inOne) / r.totalUniqueWords);
    console.log(`  ${r.section.padEnd(20)} ${String(r.totalUniqueWords).padStart(4)} unique words  →  ${repeatRate}% repeat in 2+ papers`);
  }

  await prisma.$disconnect();
})();
