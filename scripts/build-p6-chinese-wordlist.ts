// Build a Primary 6 Chinese word list by combining two sources:
//
// 1. EMPIRICAL — every 2-4 char Chinese word/idiom that appears in
//    Section 1 (语文应用 MCQ) across PSLE Chinese 2019-2024.
//    This is the gold standard of "what PSLE actually tests".
//
// 2. CURATED (partial) — the 欢乐伙伴 6A lessons 1-3 + 6B lessons 7-10
//    character lists assembled from web search snippets. Incomplete
//    (6A lessons 4-6 missing) — flagged as such in the output.
//
// Output: scripts/p6-chinese-wordlist.json + a markdown summary.

import { prisma } from "../src/lib/db";
import * as fs from "fs";
import * as path from "path";

// ─── Curated section (web-snippet seed) ────────────────────────────
// Each lesson is the concatenated character string as published in
// the 欢乐伙伴 student edition. Empty strings = lesson not yet sourced.
const HUAN_LE_HUO_BAN: Record<string, { recognise: string; write: string }> = {
  "6A-L1": { recognise: "克锻炼验严勤懒惰划临", write: "压克梦勤复计划勇景引" },
  "6A-L2": { recognise: "托艳滴埋暴狂榜颜阵榜", write: "孙牵促庭谐拨智闯斜迅" },
  "6A-L3": { recognise: "孙趣解贴共陪斜踩歪眯", write: "踩眯呀挡唇忆换挡忆" },
  "6A-L4": { recognise: "", write: "" },  // TODO: source missing
  "6A-L5": { recognise: "", write: "" },
  "6A-L6": { recognise: "", write: "" },
  "6B-L7": { recognise: "幅抄赚氛局厦贡置政府街幅抄消巧置骑底梯篮", write: "罩遭技搜索堵航幻源砖品按眨幻度恼厉晃敲窗" },
  "6B-L8": { recognise: "廊吊租吩咐津捏津邻拖扁厕", write: "咦厉瞧虑端胀丝荡尝滴存" },
  "6B-L9": { recognise: "版社章朗译妖魔鬼申悉介绍录页码式篇义翻败", write: "毕届恳邀致仪奏诵幕键毕邀证醒务盼踏依舍弃" },
  "6B-L10": { recognise: "贫余忧跨寻暂鬼申牌穷算糟吞", write: "悲稍含怨途孤途坚废守" },
};

// Strip non-CJK from a string.
function cjkOnly(s: string): string {
  return s.replace(/[^一-鿿]/g, "");
}

// Split a long string into single CJK chars (dedupe-friendly).
function chars(s: string): string[] {
  return cjkOnly(s).split("");
}

// Extract every 2-char-or-longer CJK run from a sentence. We use this
// to surface "word units" PSLE actually presents in context, beyond
// the single-character Q3-Q4 vocab.
function extractWordRuns(s: string): string[] {
  const matches = s.match(/[一-鿿]+/g) ?? [];
  // Slide window: 2..5 char substrings inside each run.
  const out = new Set<string>();
  for (const run of matches) {
    for (let n = 2; n <= 5; n++) {
      for (let i = 0; i + n <= run.length; i++) {
        out.add(run.slice(i, i + n));
      }
    }
  }
  return [...out];
}

(async () => {
  // ─── Pull every PSLE Chinese 语文应用 question ────────────────────
  const papers = await prisma.examPaper.findMany({
    where: {
      OR: [
        { title: { contains: "PSLE", mode: "insensitive" } },
        { level: { equals: "PSLE", mode: "insensitive" } },
      ],
      subject: { contains: "chinese", mode: "insensitive" },
      sourceExamId: null,
      paperType: null,
    },
    select: { id: true, year: true },
    orderBy: { year: "desc" },
  });
  const paperYear = new Map(papers.map(p => [p.id, p.year]));

  const questions = await prisma.examQuestion.findMany({
    where: {
      examPaperId: { in: papers.map(p => p.id) },
      syllabusTopic: "语文应用 MCQ",
    },
    select: {
      questionNum: true,
      transcribedStem: true,
      transcribedOptions: true,
      answer: true,
      examPaperId: true,
    },
  });

  // ─── 1. Single-character bucket (Q3-Q4 homophones) ────────────────
  // The options for Q3-Q4 are exactly the 4 candidate characters.
  // We snapshot which ones PSLE has tested and which the answer key
  // marked correct.
  const singleCharOptions: Array<{
    year: string; qNum: string; correctChar: string;
    distractors: string[]; stem: string;
  }> = [];
  for (const q of questions) {
    const opts = (Array.isArray(q.transcribedOptions) ? q.transcribedOptions : []) as string[];
    if (opts.length !== 4) continue;
    // Single-char only — each option must be exactly 1 CJK character.
    if (!opts.every(o => cjkOnly(o ?? "").length === 1)) continue;
    const ansNum = parseInt((q.answer ?? "").replace(/[^0-9]/g, ""), 10);
    if (!(ansNum >= 1 && ansNum <= 4)) continue;
    const correct = cjkOnly(opts[ansNum - 1] ?? "");
    if (!correct) continue;
    singleCharOptions.push({
      year: paperYear.get(q.examPaperId) ?? "?",
      qNum: q.questionNum ?? "?",
      correctChar: correct,
      distractors: opts.filter((_, i) => i !== ansNum - 1).map(o => cjkOnly(o ?? "")),
      stem: (q.transcribedStem ?? "").trim(),
    });
  }

  // ─── 2. Two-char compound bucket (Q5-Q6 vocabulary) ───────────────
  const twoCharOptions: Array<{
    year: string; qNum: string; correct: string; distractors: string[]; stem: string;
  }> = [];
  for (const q of questions) {
    const opts = (Array.isArray(q.transcribedOptions) ? q.transcribedOptions : []) as string[];
    if (opts.length !== 4) continue;
    if (!opts.every(o => cjkOnly(o ?? "").length === 2)) continue;
    const ansNum = parseInt((q.answer ?? "").replace(/[^0-9]/g, ""), 10);
    if (!(ansNum >= 1 && ansNum <= 4)) continue;
    twoCharOptions.push({
      year: paperYear.get(q.examPaperId) ?? "?",
      qNum: q.questionNum ?? "?",
      correct: cjkOnly(opts[ansNum - 1] ?? ""),
      distractors: opts.filter((_, i) => i !== ansNum - 1).map(o => cjkOnly(o ?? "")),
      stem: (q.transcribedStem ?? "").trim(),
    });
  }

  // ─── 3. Idiom bucket (Q7-Q8 meaning + Q13-Q15 usage) ──────────────
  // Q7-Q8: the highlighted token in the stem is the idiom — usually
  //   2-4 chars. We pick the longest CJK run in the stem.
  // Q13-Q15: the same word appears in all 4 options; intersect them.
  const idioms = new Map<string, { year: string; qNum: string; kind: string }[]>();
  function recordIdiom(word: string, year: string, qNum: string, kind: string) {
    if (word.length < 2) return;
    const arr = idioms.get(word) ?? [];
    arr.push({ year, qNum, kind });
    idioms.set(word, arr);
  }
  for (const q of questions) {
    const opts = (Array.isArray(q.transcribedOptions) ? q.transcribedOptions : []) as string[];
    if (opts.length !== 4) continue;
    const year = paperYear.get(q.examPaperId) ?? "?";
    const qNum = q.questionNum ?? "?";

    // Idiom-in-options trap (Q13-Q15): find the longest CJK run that
    // appears in ALL 4 options — that's the target word.
    const runs0 = extractWordRuns(opts[0] ?? "");
    const common = runs0.filter(r => r.length >= 2 && opts.every(o => o.includes(r)));
    if (common.length > 0) {
      const longest = common.sort((a, b) => b.length - a.length)[0];
      recordIdiom(longest, year, qNum, "Q13-15 usage");
      continue;
    }

    // Q7-Q8 meaning: the OPTIONS look like full sentences (>= 6 chars
    // each), and the STEM has a 2-4 char idiom. Use the longest run.
    const optsLooksLikeDefinitions = opts.every(o => cjkOnly(o ?? "").length >= 5);
    if (optsLooksLikeDefinitions) {
      const stemRuns = extractWordRuns(q.transcribedStem ?? "")
        .filter(r => r.length >= 2 && r.length <= 4);
      // The idiom is usually the longest stem token NOT also in the
      // options (options are paraphrases, not the idiom itself).
      const inOpts = (s: string) => opts.some(o => o.includes(s));
      const candidate = stemRuns
        .filter(r => !inOpts(r))
        .sort((a, b) => b.length - a.length)[0];
      if (candidate) recordIdiom(candidate, year, qNum, "Q7-8 meaning");
    }
  }

  // ─── 4. Connector bucket (Q9-Q10) ─────────────────────────────────
  const connectors = new Set<string>();
  for (const q of questions) {
    const opts = (Array.isArray(q.transcribedOptions) ? q.transcribedOptions : []) as string[];
    if (opts.length !== 4) continue;
    // Connectors are short (2-6 CJK chars) and most contain "……" or
    // are pure conjunctions like 由于/虽然/如果/只要.
    const looksLikeConn = opts.every(o => {
      const c = cjkOnly(o ?? "");
      return c.length >= 2 && c.length <= 6 && /^[一-鿿]+$/.test(c);
    });
    if (!looksLikeConn) continue;
    for (const o of opts) {
      const c = (o ?? "").replace(/\s+/g, "");
      if (c) connectors.add(c);
    }
  }

  // ─── Assemble output JSON ─────────────────────────────────────────
  const empirical = {
    singleChars: {
      total: singleCharOptions.length,
      correctCharsTested: [...new Set(singleCharOptions.map(s => s.correctChar))].sort(),
      allCharsAppeared: [...new Set(singleCharOptions.flatMap(s => [s.correctChar, ...s.distractors]))].sort(),
      questions: singleCharOptions,
    },
    twoCharCompounds: {
      total: twoCharOptions.length,
      correctTested: [...new Set(twoCharOptions.map(s => s.correct))].sort(),
      allAppeared: [...new Set(twoCharOptions.flatMap(s => [s.correct, ...s.distractors]))].sort(),
      questions: twoCharOptions,
    },
    idiomsAndPhrases: {
      total: idioms.size,
      list: [...idioms.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([word, hits]) => ({ word, hits })),
    },
    connectors: {
      total: connectors.size,
      list: [...connectors].sort(),
    },
  };

  const curated = {
    source: "欢乐伙伴 (Huan Le Huo Ban) 6A/6B — partial, from web snippets",
    coverage: "6A lessons 1-3 + 6B lessons 7-10 (6A L4-L6 missing)",
    lessons: Object.entries(HUAN_LE_HUO_BAN).map(([id, { recognise, write }]) => ({
      lesson: id,
      recognise: chars(recognise),
      write: chars(write),
      hasContent: !!(recognise || write),
    })),
    allRecogniseChars: [...new Set(Object.values(HUAN_LE_HUO_BAN).flatMap(l => chars(l.recognise)))].sort(),
    allWriteChars: [...new Set(Object.values(HUAN_LE_HUO_BAN).flatMap(l => chars(l.write)))].sort(),
  };

  const out = {
    generatedAt: new Date().toISOString(),
    notes: [
      "EMPIRICAL = chars/words observed in PSLE Chinese 2019-2024 Section 1 (90 questions).",
      "CURATED = excerpted from 欢乐伙伴 6A/6B character list (partial — missing 6A L4-L6).",
      "Use empirical for PSLE-targeted drills; use curated for textbook-aligned ting xie.",
    ],
    empirical,
    curated,
  };

  const outPath = path.join(__dirname, "p6-chinese-wordlist.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");

  // ─── Markdown summary ─────────────────────────────────────────────
  const lines: string[] = [];
  lines.push("# Primary 6 Chinese Word List — combined empirical + curated\n");
  lines.push(`Generated: ${out.generatedAt}\n`);
  lines.push("## Empirical (from PSLE 2019-2024 Section 1)\n");
  lines.push(`- **Q3-Q4 single chars:** ${empirical.singleChars.allCharsAppeared.length} distinct (correct + distractors)`);
  lines.push(`  - Correct answers tested: ${empirical.singleChars.correctCharsTested.join("")}`);
  lines.push(`  - All 4-option chars: ${empirical.singleChars.allCharsAppeared.join("")}`);
  lines.push(`- **Q5-Q6 two-char compounds:** ${empirical.twoCharCompounds.allAppeared.length} distinct`);
  lines.push(`  - Correct: ${empirical.twoCharCompounds.correctTested.join("、")}`);
  lines.push(`  - All: ${empirical.twoCharCompounds.allAppeared.join("、")}`);
  lines.push(`- **Q7-Q8 + Q13-Q15 target words/idioms:** ${empirical.idiomsAndPhrases.total} distinct`);
  lines.push(`  - List: ${empirical.idiomsAndPhrases.list.map(i => i.word).join("、")}`);
  lines.push(`- **Q9-Q10 connectors:** ${empirical.connectors.total} distinct`);
  lines.push(`  - List: ${empirical.connectors.list.join("、")}`);
  lines.push("\n## Curated (欢乐伙伴 6A/6B, partial)\n");
  for (const lesson of curated.lessons) {
    const tag = lesson.hasContent ? "" : "  ⚠️  MISSING";
    lines.push(`### ${lesson.lesson}${tag}`);
    if (lesson.hasContent) {
      lines.push(`- 识读字 (${lesson.recognise.length}): ${lesson.recognise.join("")}`);
      lines.push(`- 识写字 (${lesson.write.length}): ${lesson.write.join("")}`);
    }
    lines.push("");
  }
  lines.push(`\n**Total curated 识读字:** ${curated.allRecogniseChars.length} distinct`);
  lines.push(`**Total curated 识写字:** ${curated.allWriteChars.length} distinct`);

  const mdPath = path.join(__dirname, "p6-chinese-wordlist.md");
  fs.writeFileSync(mdPath, lines.join("\n"), "utf8");

  console.log(`Wrote ${outPath}`);
  console.log(`Wrote ${mdPath}`);
  console.log(`\nSummary:`);
  console.log(`  Empirical single chars: ${empirical.singleChars.allCharsAppeared.length}`);
  console.log(`  Empirical two-char compounds: ${empirical.twoCharCompounds.allAppeared.length}`);
  console.log(`  Empirical idioms/phrases: ${empirical.idiomsAndPhrases.total}`);
  console.log(`  Empirical connectors: ${empirical.connectors.total}`);
  console.log(`  Curated 识读字: ${curated.allRecogniseChars.length}`);
  console.log(`  Curated 识写字: ${curated.allWriteChars.length}`);

  await prisma.$disconnect();
})();
