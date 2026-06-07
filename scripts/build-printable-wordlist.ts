// Build a printable PSLE 华文 study sheet by:
//
//   1. Gold set — every "test target" word from PSLE 2019-2024:
//      - Q5-Q6 vocab correct answers + distractors (~47 words)
//      - Q7-Q8 highlighted idioms/words (~10)
//      - Q13-Q15 target words (~18)
//      - Q16-Q20 cloze answers (~29)
//   2. Candidate set — words from P5+P6 wordlist that LOOK like
//      PSLE Q5-Q8 material: 2-char abstract verb/adj + 4-char idiom,
//      excluding narrative-specific nouns. Gemini classifies these.
//   3. Enrich each kept entry with pinyin, simple-Chinese meaning,
//      English meaning, and 2 sample sentences (P5-P6 reading level).
//   4. Output as printable markdown grouped by category.

import * as fs from "fs";
import * as path from "path";
import { prisma } from "../src/lib/db";
import { generateContentWithRetry } from "../src/lib/gemini";

function cjk(s: string): string { return s.replace(/[^一-鿿]/g, ""); }

type Entry = {
  word: string;
  chars: number;
  category: "2字词语" | "成语" | "关联词" | "短文填空" | "其他";
  source: "PSLE" | "P5" | "P6" | "P5+P6";
  psleHistory?: string[];   // e.g. ["2024 Q5 (correct)", "2023 Q5 (distractor)"]
  // Enriched by Gemini
  pinyin?: string;
  meaningZh?: string;
  meaningEn?: string;
  sample1?: string;
  sample2?: string;
};

(async () => {
  // ─── 1. Gold set from PSLE history ────────────────────────────────
  const papers = await prisma.examPaper.findMany({
    where: {
      OR: [{ title: { contains: "PSLE", mode: "insensitive" } }, { level: { equals: "PSLE", mode: "insensitive" } }],
      subject: { contains: "chinese", mode: "insensitive" },
      sourceExamId: null, paperType: null,
    },
    select: { id: true, year: true },
  });
  const paperYear = new Map(papers.map(p => [p.id, p.year ?? "?"]));
  const questions = await prisma.examQuestion.findMany({
    where: { examPaperId: { in: papers.map(p => p.id) }, syllabusTopic: { in: ["语文应用 MCQ", "短文填空"] } },
    select: { questionNum: true, transcribedStem: true, transcribedOptions: true, syllabusTopic: true, answer: true, examPaperId: true },
  });

  const goldEntries = new Map<string, Entry>();
  function addGold(word: string, category: Entry["category"], origin: string) {
    if (!word || cjk(word).length < 2) return;
    const ex = goldEntries.get(word);
    if (ex) {
      ex.psleHistory!.push(origin);
    } else {
      goldEntries.set(word, {
        word, chars: cjk(word).length, category, source: "PSLE",
        psleHistory: [origin],
      });
    }
  }

  for (const q of questions) {
    const year = paperYear.get(q.examPaperId) ?? "?";
    const qNum = q.questionNum ?? "?";
    const stem = q.transcribedStem ?? "";
    const opts = (Array.isArray(q.transcribedOptions) ? q.transcribedOptions : []) as string[];
    const ansNum = parseInt((q.answer ?? "").replace(/[^0-9]/g, ""), 10);
    const correctIdx = (ansNum >= 1 && ansNum <= 4) ? ansNum - 1 : -1;
    const correctText = correctIdx >= 0 ? (opts[correctIdx] ?? "") : "";

    if (q.syllabusTopic === "语文应用 MCQ") {
      const n = parseInt(qNum, 10);

      if (n >= 5 && n <= 6) {
        // Vocab: all 4 options
        for (let i = 0; i < opts.length; i++) {
          const w = cjk(opts[i] ?? "");
          const tag = i === correctIdx ? "correct" : "distractor";
          addGold(w, "2字词语", `${year} Q${qNum} (${tag})`);
        }
      } else if (n >= 7 && n <= 8) {
        // Idiom: bolded in stem
        const m = stem.match(/\*\*([^*]+)\*\*|__([^_]+)__/);
        if (m) {
          const w = cjk(m[1] ?? m[2] ?? "");
          addGold(w, w.length === 4 ? "成语" : "2字词语", `${year} Q${qNum} (考解释)`);
        }
      } else if (n >= 9 && n <= 10) {
        for (let i = 0; i < opts.length; i++) {
          const w = cjk(opts[i] ?? "");
          const tag = i === correctIdx ? "correct" : "distractor";
          if (w.length >= 2) addGold(w, "关联词", `${year} Q${qNum} (${tag})`);
        }
      } else if (n >= 13 && n <= 15) {
        // Target word
        if (opts.length === 4) {
          const o0 = cjk(opts[0] ?? "");
          let target = "";
          for (let nLen = 5; nLen >= 2; nLen--) {
            for (let i = 0; i + nLen <= o0.length; i++) {
              const sub = o0.slice(i, i + nLen);
              if (opts.every(o => cjk(o ?? "").includes(sub))) { target = sub; break; }
            }
            if (target) break;
          }
          if (target) addGold(target, target.length === 4 ? "成语" : "2字词语", `${year} Q${qNum} (用法考查)`);
        }
      }
    } else if (q.syllabusTopic === "短文填空") {
      const w = cjk(correctText);
      if (w.length >= 1) addGold(w, "短文填空", `${year} Q${qNum} (正确答案)`);
    }
  }

  console.log(`Gold set from PSLE history: ${goldEntries.size} unique words\n`);

  // ─── 2. Candidate set from P5+P6 wordlist (Gemini-classified) ────
  type RawLesson = { lessonNumber: string | null; recogniseWords: string[]; writeWords: string[]; collocations: string[] };
  const p5 = (JSON.parse(fs.readFileSync(path.join(__dirname, "p5-spelling-list.json"), "utf8")) as { lessons: RawLesson[] }).lessons;
  const p6 = (JSON.parse(fs.readFileSync(path.join(__dirname, "p6-spelling-list.json"), "utf8")) as { lessons: RawLesson[] }).lessons;

  const inP5 = new Set<string>(), inP6 = new Set<string>();
  for (const r of p5) for (const w of [...r.recogniseWords, ...r.writeWords, ...r.collocations]) inP5.add(w);
  for (const r of p6) for (const w of [...r.recogniseWords, ...r.writeWords, ...r.collocations]) inP6.add(w);
  const wordlist = new Set<string>([...inP5, ...inP6]);

  // Pre-filter: only consider 2-char and 4-char entries (PSLE's two
  // main test shapes). Skip words already in gold set.
  const candidates = [...wordlist]
    .map(w => ({ word: w, chars: cjk(w).length }))
    .filter(x => (x.chars === 2 || x.chars === 4) && !goldEntries.has(x.word));
  console.log(`P5+P6 candidate pool (2-char + 4-char, excl. gold): ${candidates.length}`);

  // Batch Gemini classify: for each candidate, is it a primary-active
  // abstract word PSLE Q5-Q8 might test? Output yes/no.
  const KEEP_TAG = "psle-likely";
  const SKIP_TAG = "skip";
  type ClassifyOut = Record<string, string>;
  async function classifyBatch(words: string[]): Promise<ClassifyOut> {
    const prompt = `你是新加坡 PSLE 华文老师。看下面每个词，判断它是否是 PSLE Q5-Q8 (词语 / 词语解释) 可能考的"P5-P6 学生应该认识的抽象核心词汇"。

判断标准:
- 是 → 抽象动词 / 形容词 / 副词 / 描述情感/动作/状态的 4 字成语。例如:后悔、慎重、敬佩、专心、神机妙算
- 否 → 课文里的具体名词 (火山、长江、龙王、三国)、人名、地名、过于罕见或太基础 (我们、东西)

回 JSON: { "<词>": "${KEEP_TAG}" | "${SKIP_TAG}" }，每个词都要有判断。

词:
${words.map(w => `- ${w}`).join("\n")}`;

    const res = await generateContentWithRetry({
      model: "gemini-2.5-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json", temperature: 0.1 },
    }, 1, 2000, `classify`);
    const text = (res.text ?? "").trim();
    const m = text.match(/\{[\s\S]*\}/);
    try {
      return JSON.parse(m ? m[0] : text);
    } catch {
      return {};
    }
  }

  const candidateClass: ClassifyOut = {};
  const BATCH = 30;
  console.log(`Classifying ${candidates.length} candidates in batches of ${BATCH}...`);
  for (let i = 0; i < candidates.length; i += BATCH) {
    const batch = candidates.slice(i, i + BATCH);
    try {
      const out = await classifyBatch(batch.map(c => c.word));
      Object.assign(candidateClass, out);
      process.stdout.write(`  ${Math.min(i + BATCH, candidates.length)}/${candidates.length}\r`);
    } catch (err) {
      console.error(`  batch ${i} failed:`, (err as Error).message);
    }
  }
  console.log();

  // Filter to keep set + classify category by chars
  const keepCandidates: Entry[] = [];
  for (const c of candidates) {
    if (candidateClass[c.word] !== KEEP_TAG) continue;
    keepCandidates.push({
      word: c.word, chars: c.chars,
      category: c.chars === 4 ? "成语" : "2字词语",
      source: inP5.has(c.word) && inP6.has(c.word) ? "P5+P6" : inP5.has(c.word) ? "P5" : "P6",
    });
  }
  console.log(`P5+P6 candidates kept by Gemini: ${keepCandidates.length}\n`);

  // ─── 3. Combine gold + candidate → enrichment list ───────────────
  const enrichList: Entry[] = [...goldEntries.values(), ...keepCandidates];
  console.log(`Total words to enrich: ${enrichList.length}`);

  // ─── 4. Enrich each with Gemini (pinyin + meanings + samples) ────
  async function enrichBatch(items: Entry[]): Promise<Record<string, { pinyin: string; meaningZh: string; meaningEn: string; sample1: string; sample2: string }>> {
    const prompt = `你是新加坡 PSLE 华文教师。为下面每个词输出标准的学习信息。每个词要 4 项:
- pinyin: 标准拼音，带声调 (例如:shāo wēi)
- meaningZh: 简单的中文解释 (10-20 字，P5-P6 学生能懂)
- meaningEn: English meaning (1 short phrase or sentence)
- sample1, sample2: 两个 P5-P6 程度的例句，简短自然，体现这个词的常见用法。例句最好和小学生生活相关 (学校 / 家庭 / 朋友 / 情感)。

返回 JSON ONLY:
{ "<词>": { "pinyin": "...", "meaningZh": "...", "meaningEn": "...", "sample1": "...", "sample2": "..." } }

词:
${items.map(it => `- ${it.word} (${it.category})`).join("\n")}`;

    const res = await generateContentWithRetry({
      model: "gemini-3.1-pro-preview",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { responseMimeType: "application/json", temperature: 0.2 },
    }, 1, 3000, "enrich");
    const text = (res.text ?? "").trim();
    const m = text.match(/\{[\s\S]*\}/);
    try {
      return JSON.parse(m ? m[0] : text);
    } catch {
      return {};
    }
  }

  const E_BATCH = 8;
  console.log(`\nEnriching ${enrichList.length} entries with gemini-3.1-pro-preview (batches of ${E_BATCH}, 3 parallel)...`);
  const PARALLEL = 3;
  for (let i = 0; i < enrichList.length; i += E_BATCH * PARALLEL) {
    const tasks: Promise<void>[] = [];
    for (let j = 0; j < PARALLEL; j++) {
      const start = i + j * E_BATCH;
      if (start >= enrichList.length) break;
      const batch = enrichList.slice(start, start + E_BATCH);
      tasks.push(enrichBatch(batch).then(out => {
        for (const e of batch) {
          const info = out[e.word];
          if (info) Object.assign(e, info);
        }
      }).catch(err => {
        console.error(`  batch starting ${start} failed:`, (err as Error).message);
      }));
    }
    await Promise.all(tasks);
    process.stdout.write(`  enriched ${Math.min(i + E_BATCH * PARALLEL, enrichList.length)}/${enrichList.length}\r`);
  }
  console.log();

  // ─── 5. Output JSON + printable markdown ──────────────────────────
  const outJson = path.join(__dirname, "psle-chinese-study-bank.json");
  fs.writeFileSync(outJson, JSON.stringify(enrichList, null, 2), "utf8");
  console.log(`\nWrote ${outJson}`);

  // Group by category, then by source (PSLE first), then alphabetically
  enrichList.sort((a, b) => {
    const order = ["2字词语", "成语", "关联词", "短文填空", "其他"].indexOf;
    const cd = ["2字词语", "成语", "关联词", "短文填空", "其他"].indexOf(a.category) - ["2字词语", "成语", "关联词", "短文填空", "其他"].indexOf(b.category);
    if (cd !== 0) return cd;
    // PSLE first within category
    if (a.source === "PSLE" && b.source !== "PSLE") return -1;
    if (b.source === "PSLE" && a.source !== "PSLE") return 1;
    return a.word.localeCompare(b.word);
  });

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
    "2字词语": enrichList.filter(e => e.category === "2字词语"),
    "成语": enrichList.filter(e => e.category === "成语"),
    "关联词": enrichList.filter(e => e.category === "关联词"),
    "短文填空": enrichList.filter(e => e.category === "短文填空"),
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

  const outDir = path.join(__dirname, "..", "..", "documents");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "PSLE 华文词汇学习卡 (打印用).md");
  fs.writeFileSync(outPath, md.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);

  console.log(`\n=== Final counts ===`);
  for (const cat of ["2字词语", "成语", "关联词", "短文填空"] as const) {
    const arr = grouped[cat];
    const psleN = arr.filter(e => e.source === "PSLE").length;
    console.log(`  ${cat.padEnd(8)}  ${String(arr.length).padStart(4)} total  (${psleN} PSLE + ${arr.length - psleN} 候选)`);
  }

  await prisma.$disconnect();
})();
