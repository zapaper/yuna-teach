// Extract the curated PSLE-derived drill vocabulary, organised by
// sub-topic / question slot. Output: documents/PSLE Chinese drill
// vocab (curated from 2019-2024).md

import * as fs from "fs";
import * as path from "path";
import { prisma } from "../src/lib/db";

function cjk(s: string): string { return s.replace(/[^一-鿿]/g, ""); }

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
  const paperYear = new Map(papers.map(p => [p.id, p.year ?? "?"]));
  const allYears = [...new Set(papers.map(p => p.year ?? "?"))].sort();

  const questions = await prisma.examQuestion.findMany({
    where: {
      examPaperId: { in: papers.map(p => p.id) },
      syllabusTopic: { in: ["语文应用 MCQ", "短文填空"] },
    },
    select: {
      questionNum: true,
      transcribedStem: true,
      transcribedOptions: true,
      syllabusTopic: true,
      answer: true,
      examPaperId: true,
    },
  });

  type Item = { year: string; qNum: string; word: string; pinyinOrGloss?: string; correct: boolean; sourceStem?: string; options?: string[]; correctIdx?: number };

  // ─── Per-slot extraction ──────────────────────────────────────────
  const slot12: Item[] = [];      // Q1-Q2 pinyin
  const slot34: Item[] = [];      // Q3-Q4 homophone (compound + correct char)
  const slot56: Item[] = [];      // Q5-Q6 vocab — correct + distractors
  const slot78: Item[] = [];      // Q7-Q8 idiom meaning
  const slot910: Item[] = [];     // Q9-Q10 connectors
  const slot1315: Item[] = [];    // Q13-Q15 word usage (target word)
  const slot1620: Item[] = [];    // 短文填空 — correct answers

  for (const q of questions) {
    const year = paperYear.get(q.examPaperId) ?? "?";
    const qNum = q.questionNum ?? "?";
    const stem = q.transcribedStem ?? "";
    const opts = (Array.isArray(q.transcribedOptions) ? q.transcribedOptions : []) as string[];
    const ansNum = parseInt((q.answer ?? "").replace(/[^0-9]/g, ""), 10);
    const correctIdx = (ansNum >= 1 && ansNum <= 4) ? ansNum - 1 : -1;
    const correctText = correctIdx >= 0 ? (opts[correctIdx] ?? "") : (q.answer ?? "");

    if (q.syllabusTopic === "语文应用 MCQ") {
      const n = parseInt(qNum, 10);

      if (n >= 1 && n <= 2) {
        // Pinyin: target word is bolded compound in stem
        const m = stem.match(/\*\*([^*]+)\*\*|__([^_]+)__/);
        if (m) {
          slot12.push({
            year, qNum, word: cjk(m[1] ?? m[2] ?? ""),
            pinyinOrGloss: correctText.trim(),
            correct: true,
            sourceStem: stem.trim(), options: opts, correctIdx,
          });
        }
      } else if (n >= 3 && n <= 4) {
        // Homophone: build the compound by substituting correct char.
        const correctChar = cjk(correctText);
        if (correctChar.length === 1) {
          const reconstructed = stem.replace(/_+|＿+|□+/, correctChar).replace(/\s+/g, "");
          const reconstructedCjk = cjk(reconstructed);
          // Find compound of length 2 containing correctChar that
          // appears in the reconstructed text.
          const compounds: string[] = [];
          for (let i = 0; i + 2 <= reconstructedCjk.length; i++) {
            const sub = reconstructedCjk.slice(i, i + 2);
            if (sub.includes(correctChar)) compounds.push(sub);
          }
          // Take the first one as the canonical compound.
          slot34.push({
            year, qNum, word: compounds[0] ?? correctChar,
            pinyinOrGloss: `correct char: ${correctChar}`,
            correct: true, sourceStem: stem.trim(), options: opts, correctIdx,
          });
        }
      } else if (n >= 5 && n <= 6) {
        // Vocab: extract correct + all distractors
        for (let i = 0; i < opts.length; i++) {
          const w = cjk(opts[i] ?? "");
          if (w.length >= 2) {
            slot56.push({
              year, qNum, word: w,
              correct: i === correctIdx,
              sourceStem: stem.trim(), options: opts, correctIdx,
            });
          }
        }
      } else if (n >= 7 && n <= 8) {
        // Idiom meaning: bolded idiom in stem; correct option = meaning
        const m = stem.match(/\*\*([^*]+)\*\*|__([^_]+)__/);
        if (m) {
          slot78.push({
            year, qNum, word: cjk(m[1] ?? m[2] ?? ""),
            pinyinOrGloss: correctText.trim(),
            correct: true, sourceStem: stem.trim(), options: opts, correctIdx,
          });
        }
      } else if (n >= 9 && n <= 10) {
        // Connectors: collect all options (correct + distractor)
        for (let i = 0; i < opts.length; i++) {
          const w = cjk(opts[i] ?? "");
          if (w.length >= 2) {
            slot910.push({
              year, qNum, word: w,
              correct: i === correctIdx,
              sourceStem: stem.trim(), options: opts, correctIdx,
            });
          }
        }
      } else if (n >= 13 && n <= 15) {
        // Usage: target word = longest substring common to all 4 options
        if (opts.length === 4) {
          const o0 = cjk(opts[0] ?? "");
          const candidates: string[] = [];
          for (let nLen = 2; nLen <= 5; nLen++) {
            for (let i = 0; i + nLen <= o0.length; i++) {
              const sub = o0.slice(i, i + nLen);
              if (opts.every(o => cjk(o ?? "").includes(sub))) candidates.push(sub);
            }
          }
          const target = candidates.sort((a, b) => b.length - a.length)[0];
          if (target) {
            slot1315.push({
              year, qNum, word: target,
              pinyinOrGloss: `用法考查 — 正确句：${(opts[correctIdx] ?? "").slice(0, 40)}`,
              correct: true, sourceStem: stem.trim(), options: opts, correctIdx,
            });
          }
        }
      }
    } else if (q.syllabusTopic === "短文填空") {
      const w = cjk(correctText);
      if (w.length >= 1) {
        slot1620.push({
          year, qNum, word: w,
          correct: true, sourceStem: stem.trim(), options: opts, correctIdx,
        });
      }
    }
  }

  // ─── Aggregate per-slot deduped word lists ────────────────────────
  function uniqByWord(items: Item[]): Map<string, Item[]> {
    const m = new Map<string, Item[]>();
    for (const it of items) {
      const arr = m.get(it.word) ?? [];
      arr.push(it);
      m.set(it.word, arr);
    }
    return m;
  }

  // ─── Build the curated markdown ───────────────────────────────────
  const md: string[] = [];
  md.push("# PSLE 华文高频词汇 — 真题归纳 (2019-2024)\n");
  md.push(`本文是从 6 年 PSLE 真题中提取的"真考过"的词、字、成语。比课本词语单更聚焦——这些是 PSLE 实际用过的词。\n`);
  md.push(`**来源：** ${papers.length} 张 PSLE 华文试卷 (${allYears.join(", ")})。\n`);
  md.push(`**注意：** PSLE 每年都换新词，重复率很低 (~5-17%)。所以这不是"明年会考什么"的预测清单，而是"PSLE 风格的优先级词库"——是教学生认识 PSLE 喜欢什么类型的词。\n`);

  // ─── Q1-Q2 拼音 ───────────────────────────────────────────────────
  md.push(`\n## 1. 拼音 (Q1-Q2) — 6 年共 ${slot12.length} 个加粗词\n`);
  md.push(`| 年 | 题 | 加粗词 | 正确拼音 | 易错点 |`);
  md.push(`|----|----|--------|----------|---------|`);
  for (const it of slot12.sort((a, b) => a.year.localeCompare(b.year) || parseInt(a.qNum) - parseInt(b.qNum))) {
    // Identify the trick by comparing correct option vs first option
    const tricks: string[] = [];
    const correctPinyin = it.pinyinOrGloss ?? "";
    for (const o of it.options ?? []) {
      if (o.trim() === correctPinyin) continue;
      // Find first char difference
      for (let i = 0; i < Math.min(correctPinyin.length, o.length); i++) {
        if (correctPinyin[i] !== o[i]) {
          const ch1 = correctPinyin.slice(Math.max(0, i - 1), i + 2);
          const ch2 = o.slice(Math.max(0, i - 1), i + 2);
          if (ch1 !== ch2) tricks.push(`${ch1} ≠ ${ch2}`);
          break;
        }
      }
    }
    md.push(`| ${it.year} | Q${it.qNum} | **${it.word}** | ${correctPinyin} | ${[...new Set(tricks)].slice(0, 2).join("; ")} |`);
  }

  // ─── Q3-Q4 同音字 ─────────────────────────────────────────────────
  md.push(`\n## 2. 同音字 / 形近字 (Q3-Q4) — 6 年共 ${slot34.length} 道\n`);
  md.push(`| 年 | 题 | 完整词 | 填字 | 4 个选项 |`);
  md.push(`|----|----|--------|------|-----------|`);
  for (const it of slot34.sort((a, b) => a.year.localeCompare(b.year) || parseInt(a.qNum) - parseInt(b.qNum))) {
    const optsList = (it.options ?? []).map((o, i) => `(${i + 1})${cjk(o ?? "")}`).join(" / ");
    md.push(`| ${it.year} | Q${it.qNum} | **${it.word}** | ${(it.pinyinOrGloss ?? "").replace("correct char: ", "")} | ${optsList} |`);
  }

  // ─── Q5-Q6 词语 ───────────────────────────────────────────────────
  md.push(`\n## 3. 词语 (Q5-Q6) — 12 道题，共 48 个候选词\n`);
  // The CORRECT answers (12 words)
  const slot56Correct = slot56.filter(s => s.correct);
  md.push(`### 3a. 正确答案 (12 个，必须掌握)\n`);
  md.push(`这 12 个词是 6 年来 Q5-Q6 的正确答案。务必全部认识。\n`);
  md.push(`| 年 | 题 | 词 | 句中含义 |`);
  md.push(`|----|----|----|----|`);
  for (const it of slot56Correct.sort((a, b) => a.year.localeCompare(b.year) || parseInt(a.qNum) - parseInt(b.qNum))) {
    md.push(`| ${it.year} | Q${it.qNum} | **${it.word}** | ${(it.sourceStem ?? "").replace(/\s+/g, " ").slice(0, 60)}... |`);
  }
  md.push(`\n### 3b. 干扰选项 (36 个备选词)\n`);
  md.push(`这些是干扰选项——也是常考词，因为 PSLE 选作干扰说明学生应该认识。\n`);
  const distractors = [...new Set(slot56.filter(s => !s.correct).map(s => s.word))].sort();
  md.push(distractors.join("、"));

  // ─── Q7-Q8 成语 ───────────────────────────────────────────────────
  md.push(`\n\n## 4. 成语 / 词语解释 (Q7-Q8) — 6 年共 ${slot78.length} 个加粗词\n`);
  md.push(`| 年 | 题 | 词/成语 | 正确解释 |`);
  md.push(`|----|----|---------|----------|`);
  for (const it of slot78.sort((a, b) => a.year.localeCompare(b.year) || parseInt(a.qNum) - parseInt(b.qNum))) {
    md.push(`| ${it.year} | Q${it.qNum} | **${it.word}** | ${(it.pinyinOrGloss ?? "").replace(/\s+/g, " ")} |`);
  }

  // ─── Q9-Q10 关联词 ────────────────────────────────────────────────
  md.push(`\n## 5. 关联词 (Q9-Q10) — 6 年所有用过的关联词\n`);
  const correctConnectors = [...new Set(slot910.filter(s => s.correct).map(s => s.word))].sort();
  const allConnectors = [...new Set(slot910.map(s => s.word))].sort();
  md.push(`**6 年里做过正确答案的 ${correctConnectors.length} 个关联词 (必须掌握):**\n`);
  md.push(correctConnectors.join("、"));
  md.push(`\n\n**所有出现过的关联词 (${allConnectors.length} 个，包括干扰选项):**\n`);
  md.push(allConnectors.join("、"));

  // ─── Q13-Q15 词语应用 ────────────────────────────────────────────
  md.push(`\n\n## 6. 词语应用 (Q13-Q15) — 6 年共 ${slot1315.length} 个目标词\n`);
  md.push(`这些词在 4 个选项里都出现，考你"哪个句子用对了"。要熟悉它们的搭配习惯。\n`);
  md.push(`| 年 | 题 | 目标词 | 正确句例 |`);
  md.push(`|----|----|--------|----------|`);
  for (const it of slot1315.sort((a, b) => a.year.localeCompare(b.year) || parseInt(a.qNum) - parseInt(b.qNum))) {
    md.push(`| ${it.year} | Q${it.qNum} | **${it.word}** | ${(it.pinyinOrGloss ?? "").replace("用法考查 — 正确句：", "")} |`);
  }

  // ─── Q16-Q20 短文填空 ────────────────────────────────────────────
  md.push(`\n## 7. 短文填空 (Q16-Q20) — 6 年共 ${slot1620.length} 个正确答案词\n`);
  const cloze = slot1620.sort((a, b) => a.year.localeCompare(b.year) || parseInt(a.qNum) - parseInt(b.qNum));
  md.push(`这些是 6 年共 30 道 cloze 题的正确答案。从分布看，短文填空考的词非常分散——重复率只有 5%。\n`);
  md.push(`| 年 | 题 | 正确答案 |`);
  md.push(`|----|----|---------|`);
  for (const it of cloze) {
    md.push(`| ${it.year} | Q${it.qNum} | **${it.word}** |`);
  }

  // ─── Final summary list ──────────────────────────────────────────
  md.push(`\n## 📌 总结：必背词清单 (按主题归类)\n`);
  md.push(`### 必背成语 (12 个)`);
  md.push([...new Set(slot78.map(s => s.word))].sort().join("、"));
  md.push(`\n### 必背关联词 (按答案频次)\n`);
  md.push(correctConnectors.join("、"));
  md.push(`\n### Q5-Q6 词语正确答案 (12 个)\n`);
  md.push([...new Set(slot56Correct.map(s => s.word))].sort().join("、"));
  md.push(`\n### Q13-Q15 词语应用目标词 (18 个)\n`);
  md.push([...new Set(slot1315.map(s => s.word))].sort().join("、"));
  md.push(`\n### Q1-Q2 拼音加粗词 (12 个)\n`);
  md.push([...new Set(slot12.map(s => s.word))].sort().join("、"));
  md.push(`\n### Q3-Q4 同音字测试词 (12 个)\n`);
  md.push([...new Set(slot34.map(s => s.word))].sort().join("、"));
  md.push(`\n### Q16-Q20 短文填空答案 (30 个)\n`);
  md.push([...new Set(slot1620.map(s => s.word))].sort().join("、"));

  const outDir = path.join(__dirname, "..", "..", "documents");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "PSLE 华文高频词汇 — 真题归纳 (2019-2024).md");
  fs.writeFileSync(outPath, md.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);

  console.log(`\n=== 总词数 by slot ===`);
  console.log(`  Q1-Q2 拼音加粗词:    ${slot12.length} (${new Set(slot12.map(s => s.word)).size} unique)`);
  console.log(`  Q3-Q4 同音字测试词:  ${slot34.length} (${new Set(slot34.map(s => s.word)).size} unique)`);
  console.log(`  Q5-Q6 词语候选 (含干扰): ${slot56.length} (${new Set(slot56.map(s => s.word)).size} unique)`);
  console.log(`  Q7-Q8 成语:          ${slot78.length} (${new Set(slot78.map(s => s.word)).size} unique)`);
  console.log(`  Q9-Q10 关联词 (含干扰):  ${slot910.length} (${new Set(slot910.map(s => s.word)).size} unique)`);
  console.log(`  Q13-Q15 词语应用目标词: ${slot1315.length} (${new Set(slot1315.map(s => s.word)).size} unique)`);
  console.log(`  Q16-Q20 短文填空答案:   ${slot1620.length} (${new Set(slot1620.map(s => s.word)).size} unique)`);

  await prisma.$disconnect();
})();
