// Auto-fix the Q3-Q4 homophone compound column.
//
// My naive heuristic grabbed the first 2-char window containing the
// correct char, but the blank is between two arbitrary chars — the
// actual compound is the one IMMEDIATELY adjacent to the blank, not
// the first window we find.
//
// Better heuristic: find the position of the blank in the stem, take
// the chars [blank-1, blank, blank+1] with the correct char in the
// blank slot, then build candidate compounds:
//   [blank-1 + correct]   (compound ends with correct char)
//   [correct + blank+1]   (compound starts with correct char)
// Pick whichever looks like a real word (cheap check: it's also a
// known compound from the combined P5+P6 wordlist OR a common 2-char
// word). Fall back to Gemini for any we can't resolve.

import * as fs from "fs";
import * as path from "path";
import { prisma } from "../src/lib/db";
import { generateContentWithRetry } from "../src/lib/gemini";

type RawLesson = { lessonNumber: string | null; recogniseWords: string[]; writeWords: string[]; collocations: string[] };

function cjk(s: string): string { return s.replace(/[^一-鿿]/g, ""); }

(async () => {
  // Load wordlist for cheap dictionary check
  const p5 = (JSON.parse(fs.readFileSync(path.join(__dirname, "p5-spelling-list.json"), "utf8")) as { lessons: RawLesson[] }).lessons;
  const p6 = (JSON.parse(fs.readFileSync(path.join(__dirname, "p6-spelling-list.json"), "utf8")) as { lessons: RawLesson[] }).lessons;
  const knownWords = new Set<string>();
  for (const rows of [p5, p6]) {
    for (const r of rows) {
      for (const w of [...r.recogniseWords, ...r.writeWords, ...r.collocations]) {
        const c = cjk(w);
        if (c.length === 2) knownWords.add(c);
      }
    }
  }

  // Pull Q3-Q4 questions
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
    where: {
      examPaperId: { in: papers.map(p => p.id) },
      syllabusTopic: "语文应用 MCQ",
    },
    select: { questionNum: true, transcribedStem: true, transcribedOptions: true, answer: true, examPaperId: true },
  });

  const q34 = questions.filter(q => {
    const n = parseInt(q.questionNum ?? "0");
    return n >= 3 && n <= 4;
  });

  console.log(`Processing ${q34.length} Q3-Q4 questions\n`);

  type Result = { year: string; qNum: string; stem: string; correctChar: string; options: string[]; compound: string; method: string };
  const results: Result[] = [];

  for (const q of q34) {
    const year = paperYear.get(q.examPaperId) ?? "?";
    const qNum = q.questionNum ?? "?";
    const stem = q.transcribedStem ?? "";
    const opts = (Array.isArray(q.transcribedOptions) ? q.transcribedOptions : []) as string[];
    const ansNum = parseInt((q.answer ?? "").replace(/[^0-9]/g, ""), 10);
    const correctIdx = (ansNum >= 1 && ansNum <= 4) ? ansNum - 1 : -1;
    const correctChar = cjk(opts[correctIdx] ?? "");

    // Find the blank position. Replace blank glyphs with a single
    // PLACEHOLDER token first.
    const PLACEHOLDER = "❑";
    const reconstructed = stem.replace(/_+|＿+|□+/g, PLACEHOLDER);
    const cjkArr: string[] = [];
    for (const ch of reconstructed) {
      if (ch === PLACEHOLDER) cjkArr.push(PLACEHOLDER);
      else if (/[一-鿿]/.test(ch)) cjkArr.push(ch);
    }
    const blankIdx = cjkArr.indexOf(PLACEHOLDER);
    if (blankIdx === -1) {
      console.log(`${year} Q${qNum}  ⚠️ no blank glyph found in stem`);
      results.push({ year, qNum, stem, correctChar, options: opts.map(o => cjk(o ?? "")), compound: correctChar, method: "no blank" });
      continue;
    }

    // Candidates: [prev + correct] and [correct + next]
    const prev = blankIdx > 0 ? cjkArr[blankIdx - 1] : "";
    const next = blankIdx + 1 < cjkArr.length ? cjkArr[blankIdx + 1] : "";
    const cand1 = prev ? prev + correctChar : "";
    const cand2 = next ? correctChar + next : "";

    let compound = "";
    let method = "";
    // Prefer the candidate that's in our known wordlist.
    if (cand2 && knownWords.has(cand2)) { compound = cand2; method = "right-adjacent ∈ wordlist"; }
    else if (cand1 && knownWords.has(cand1)) { compound = cand1; method = "left-adjacent ∈ wordlist"; }
    else if (cand2) { compound = cand2; method = "right-adjacent (default)"; }
    else if (cand1) { compound = cand1; method = "left-adjacent fallback"; }
    else { compound = correctChar; method = "no candidate"; }

    results.push({ year, qNum, stem, correctChar, options: opts.map(o => cjk(o ?? "")), compound, method });
  }

  // ─── For any that fell back to "right-adjacent (default)" without
  // dictionary confirmation, double-check with Gemini ───────────────
  const uncertain = results.filter(r => r.method === "right-adjacent (default)" || r.method === "left-adjacent fallback");
  console.log(`\n${uncertain.length} questions need Gemini double-check...\n`);
  for (const r of uncertain) {
    const prompt = `这是一道新加坡 PSLE 华文同音字题。原句子: "${r.stem.trim()}"
4 个选项: ${r.options.map((o, i) => `(${i + 1}) ${o}`).join(", ")}
正确答案: "${r.correctChar}"

把"${r.correctChar}"填入空格后，请告诉我这个 2-字词是什么。只回答词语本身 (2 个汉字)，不要其他文字。`;

    try {
      const res = await generateContentWithRetry({
        model: "gemini-3.1-pro-preview",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: { temperature: 0.1 },
      }, 1, 2000, `homophone-fix-${r.year}-Q${r.qNum}`);
      const text = (res.text ?? "").trim();
      const compound = cjk(text).slice(0, 4);
      if (compound.length === 2) {
        const old = r.compound;
        r.compound = compound;
        r.method = `Gemini (was: ${old})`;
      }
    } catch (err) {
      console.log(`  ${r.year} Q${r.qNum} Gemini failed: ${(err as Error).message}`);
    }
  }

  console.log(`\n=== Fixed compounds ===`);
  for (const r of results.sort((a, b) => a.year.localeCompare(b.year) || parseInt(a.qNum) - parseInt(b.qNum))) {
    console.log(`  ${r.year} Q${r.qNum}  → ${r.compound}  (${r.method})`);
  }

  // ─── Patch the curated markdown ───────────────────────────────────
  const mdPath = path.join(__dirname, "..", "..", "documents", "PSLE 华文高频词汇 — 真题归纳 (2019-2024).md");
  let md = fs.readFileSync(mdPath, "utf8");
  for (const r of results) {
    // Find the row in section 2: `| ${year} | Q${qNum} | **OLD** | ...`
    const rowRegex = new RegExp(`(\\| ${r.year} \\| Q${r.qNum} \\| \\*\\*)([^*]+)(\\*\\*)`);
    md = md.replace(rowRegex, `$1${r.compound}$3`);
  }
  fs.writeFileSync(mdPath, md, "utf8");
  console.log(`\nPatched ${mdPath}`);

  await prisma.$disconnect();
})();
