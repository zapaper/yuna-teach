// Build the combined P5+P6 canonical wordlist and re-run the
// "kinds of words" coverage analysis against ALL PSLE Chinese
// 2019-2024 questions.
//
// Specifically answers: does adding P5 close the gap on the
// 16 distinct 成语 that PSLE actually tested in Section 1?
//
// Output: documents/P5+P6 Chinese wordlist — PSLE coverage.md

import * as fs from "fs";
import * as path from "path";
import { prisma } from "../src/lib/db";

type RawLesson = {
  lessonNumber: string | null;
  lessonTitle: string | null;
  recogniseWords: string[];
  writeWords: string[];
  collocations: string[];
  sentencePatterns: string[];
};

// ─── Helpers ──────────────────────────────────────────────────────
function cjk(s: string): number { return s.replace(/[^一-鿿]/g, "").length; }

const CONNECTORS = new Set([
  "因为", "所以", "如果", "虽然", "但是", "可是", "不过", "然而", "尽管", "即使",
  "由于", "只要", "只有", "除非", "假如", "假使", "倘若", "无论", "不管",
  "不仅", "不但", "而且", "并且", "况且", "甚至", "反而", "却是", "于是",
  "然后", "接着", "首先", "其次", "再者", "最后", "终于",
  "除了", "自从", "原来", "其实", "竟然", "果然",
]);
function classify(word: string, isColloc: boolean): string {
  const n = cjk(word);
  if (isColloc) return "collocation";
  if (n >= 5) return "saying";
  if (n === 4) return "idiom";
  if (n === 3) return "3-char compound";
  if (n === 2) return CONNECTORS.has(word) ? "connector" : "2-char compound";
  return "single char";
}

// The 16 成语 we noted from PSLE Section 1 analysis across 2019-2024.
const PSLE_TESTED_IDIOMS_16 = [
  "目不转睛", "一言为定", "神机妙算", "异口同声", "恍然大悟",
  "垂头丧气", "左思右想", "不慌不忙", "五彩缤纷", "津津有味",
  "眉开眼笑", "手舞足蹈", "齐心协力", "获益不浅", "加油打气", "反败为胜",
];

(async () => {
  const p5 = (JSON.parse(fs.readFileSync(path.join(__dirname, "p5-spelling-list.json"), "utf8")) as { lessons: RawLesson[] }).lessons;
  const p6 = (JSON.parse(fs.readFileSync(path.join(__dirname, "p6-spelling-list.json"), "utf8")) as { lessons: RawLesson[] }).lessons;

  // Merge consecutive pages within each grade (back-of-page may be empty).
  function mergePages(rows: RawLesson[]): Array<{ lessonNumber: string; lessonTitle: string; recogniseWords: string[]; writeWords: string[]; collocations: string[]; sentencePatterns: string[] }> {
    const out: Array<ReturnType<typeof mergePages>[number]> = [];
    let cur: ReturnType<typeof mergePages>[number] | null = null;
    for (const r of rows) {
      if (r.lessonNumber) {
        if (cur) out.push(cur);
        cur = {
          lessonNumber: r.lessonNumber,
          lessonTitle: r.lessonTitle ?? "",
          recogniseWords: [...r.recogniseWords],
          writeWords: [...r.writeWords],
          collocations: [...r.collocations],
          sentencePatterns: [...r.sentencePatterns],
        };
      } else if (cur) {
        cur.recogniseWords.push(...r.recogniseWords);
        cur.writeWords.push(...r.writeWords);
        cur.collocations.push(...r.collocations);
        cur.sentencePatterns.push(...r.sentencePatterns);
      }
    }
    if (cur) out.push(cur);
    for (const m of out) {
      m.recogniseWords = [...new Set(m.recogniseWords)];
      m.writeWords = [...new Set(m.writeWords)];
      m.collocations = [...new Set(m.collocations)];
    }
    return out;
  }
  const p5Merged = mergePages(p5);
  const p6Merged = mergePages(p6);

  // ─── Build combined entry list with level tag ─────────────────────
  type Appearance = { level: "P5" | "P6"; lesson: string; lessonTitle: string; type: "识读" | "识写" | "搭配" };
  const byWord = new Map<string, { word: string; appearances: Appearance[] }>();
  function ingest(level: "P5" | "P6", merged: ReturnType<typeof mergePages>) {
    for (const m of merged) {
      const push = (w: string, type: Appearance["type"]) => {
        const ex = byWord.get(w) ?? { word: w, appearances: [] };
        ex.appearances.push({ level, lesson: m.lessonNumber, lessonTitle: m.lessonTitle, type });
        byWord.set(w, ex);
      };
      for (const w of m.recogniseWords) push(w, "识读");
      for (const w of m.writeWords) push(w, "识写");
      for (const w of m.collocations) push(w, "搭配");
    }
  }
  ingest("P5", p5Merged);
  ingest("P6", p6Merged);

  const allWords = [...byWord.values()];
  // Stats per source.
  const p5Words = new Set<string>();
  const p6Words = new Set<string>();
  const overlapWords = new Set<string>();
  for (const w of allWords) {
    const lvls = new Set(w.appearances.map(a => a.level));
    if (lvls.has("P5")) p5Words.add(w.word);
    if (lvls.has("P6")) p6Words.add(w.word);
    if (lvls.has("P5") && lvls.has("P6")) overlapWords.add(w.word);
  }
  console.log(`P5: ${p5Words.size} unique words   P6: ${p6Words.size} unique words   Overlap: ${overlapWords.size}`);
  console.log(`Combined unique: ${allWords.length}`);

  // Build collocation set for classify()
  const collocSet = new Set<string>();
  for (const m of p5Merged) for (const c of m.collocations) collocSet.add(c);
  for (const m of p6Merged) for (const c of m.collocations) collocSet.add(c);

  // ─── Pull PSLE Chinese corpus ─────────────────────────────────────
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
  });
  const paperYear = new Map(papers.map(p => [p.id, p.year]));
  const questions = await prisma.examQuestion.findMany({
    where: { examPaperId: { in: papers.map(p => p.id) } },
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

  // ─── Match every wordlist word against every question ─────────────
  type Hit = { year: string; qNum: string; section: string; role: "correct" | "distractor" | "stem-or-passage" };
  const hits = new Map<string, Hit[]>();
  for (const w of allWords) {
    if (cjk(w.word) < 2) continue;
    const matches: Hit[] = [];
    for (const q of questions) {
      const opts = (Array.isArray(q.transcribedOptions) ? q.transcribedOptions : []) as string[];
      const ansNum = parseInt((q.answer ?? "").replace(/[^0-9]/g, ""), 10);
      const correctIdx = (ansNum >= 1 && ansNum <= 4) ? ansNum - 1 : -1;
      let fullText = q.transcribedStem ?? "";
      fullText += " " + opts.join(" | ");
      if (Array.isArray(q.transcribedSubparts)) {
        for (const s of q.transcribedSubparts as Array<{ text?: string }>) if (s?.text) fullText += " " + String(s.text);
      }
      if (q.answer) fullText += " " + q.answer;
      if (!fullText.includes(w.word)) continue;
      let role: Hit["role"] = "stem-or-passage";
      if (opts.length === 4) {
        if (correctIdx >= 0 && (opts[correctIdx] ?? "").includes(w.word)) role = "correct";
        else if (opts.some(o => (o ?? "").includes(w.word))) role = "distractor";
      }
      matches.push({
        year: paperYear.get(q.examPaperId) ?? "?",
        qNum: q.questionNum ?? "?",
        section: q.syllabusTopic ?? "?",
        role,
      });
    }
    if (matches.length > 0) hits.set(w.word, matches);
  }

  // ─── Per-category aggregate ───────────────────────────────────────
  type Annotated = (typeof allWords)[number] & { kind: string; hits: Hit[] };
  const annotated: Annotated[] = allWords.map(w => ({ ...w, kind: classify(w.word, collocSet.has(w.word)), hits: hits.get(w.word) ?? [] }));

  type CatStat = {
    kind: string;
    totalInList: number;
    p5Only: number;
    p6Only: number;
    bothLevels: number;
    testedInPsle: number;
    correctAnswerWords: number;
    correctHits: number;
    totalHits: number;
    correctWords: Annotated[];
  };
  const KINDS = ["idiom", "2-char compound", "connector", "3-char compound", "saying", "collocation", "single char"];
  const stats: CatStat[] = KINDS.map(kind => {
    const all = annotated.filter(a => a.kind === kind);
    const tested = all.filter(a => a.hits.length > 0);
    const correctWords = tested.filter(a => a.hits.some(h => h.role === "correct")).sort((a, b) =>
      b.hits.filter(h => h.role === "correct").length - a.hits.filter(h => h.role === "correct").length
    );
    const correctHits = tested.reduce((s, a) => s + a.hits.filter(h => h.role === "correct").length, 0);
    const totalHits = tested.reduce((s, a) => s + a.hits.length, 0);
    const p5Only = all.filter(a => a.appearances.every(p => p.level === "P5")).length;
    const p6Only = all.filter(a => a.appearances.every(p => p.level === "P6")).length;
    const bothLevels = all.filter(a => {
      const lvls = new Set(a.appearances.map(p => p.level));
      return lvls.has("P5") && lvls.has("P6");
    }).length;
    return { kind, totalInList: all.length, p5Only, p6Only, bothLevels, testedInPsle: tested.length, correctAnswerWords: correctWords.length, correctHits, totalHits, correctWords };
  });

  // ─── Specifically: 16-成语 coverage check ─────────────────────────
  const idiomReport = PSLE_TESTED_IDIOMS_16.map(idiom => {
    const word = byWord.get(idiom);
    return {
      idiom,
      inWordlist: !!word,
      levels: word ? [...new Set(word.appearances.map(a => a.level))] : [],
      lessons: word ? word.appearances.map(a => `${a.level}-${a.lesson}`).join(", ") : "",
    };
  });
  const inP6Only = idiomReport.filter(r => r.levels.includes("P6") && !r.levels.includes("P5"));
  const inP5Only = idiomReport.filter(r => r.levels.includes("P5") && !r.levels.includes("P6"));
  const inBoth = idiomReport.filter(r => r.levels.includes("P5") && r.levels.includes("P6"));
  const missing = idiomReport.filter(r => !r.inWordlist);

  // ─── Build the report ─────────────────────────────────────────────
  const md: string[] = [];
  md.push("# P5 + P6 Chinese Wordlist — combined PSLE coverage\n");
  md.push(`OCR'd with **gemini-3.1-pro-preview**.`);
  md.push(`- **P5 wordlist**: ${p5Words.size} unique words (17 lessons)`);
  md.push(`- **P6 wordlist**: ${p6Words.size} unique words (12 lessons)`);
  md.push(`- **Overlap (in both)**: ${overlapWords.size} unique words`);
  md.push(`- **Combined unique**: ${allWords.length} words\n`);
  md.push(`Cross-checked against **${questions.length} PSLE Chinese questions** across ${papers.length} papers (2019-2024).\n`);

  // ─── 16-idiom focus ──────────────────────────────────────────────
  md.push(`## 🎯 The 16 成语 PSLE actually tested in Section 1 (2019-2024)\n`);
  md.push(`These are the idioms that appeared in Q7-Q8 (meaning) or Q13-Q15 (usage) across 6 years.\n`);
  md.push(`| Idiom | In P5? | In P6? | Lessons |`);
  md.push(`|-------|--------|--------|----------|`);
  for (const r of idiomReport) {
    const inP5 = r.levels.includes("P5") ? "✓" : "—";
    const inP6 = r.levels.includes("P6") ? "✓" : "—";
    md.push(`| **${r.idiom}** | ${inP5} | ${inP6} | ${r.lessons || "_(not in either list)_"} |`);
  }
  md.push(``);
  md.push(`**Coverage:**`);
  md.push(`- In **P6 only**: ${inP6Only.length} (${inP6Only.map(r => r.idiom).join("、") || "—"})`);
  md.push(`- In **P5 only**: ${inP5Only.length} (${inP5Only.map(r => r.idiom).join("、") || "—"})`);
  md.push(`- In **both P5 and P6**: ${inBoth.length} (${inBoth.map(r => r.idiom).join("、") || "—"})`);
  md.push(`- **Still missing**: ${missing.length} (${missing.map(r => r.idiom).join("、") || "—"})`);
  md.push(`- **Combined P5+P6 coverage**: ${PSLE_TESTED_IDIOMS_16.length - missing.length} of ${PSLE_TESTED_IDIOMS_16.length} = ${Math.round(100 * (PSLE_TESTED_IDIOMS_16.length - missing.length) / PSLE_TESTED_IDIOMS_16.length)}%`);

  // ─── Coverage by word kind (combined list) ───────────────────────
  md.push(`\n## 📊 Coverage by word kind (combined P5+P6 wordlist)\n`);
  md.push(`| Kind | Total in list | P5 only / P6 only / Both | Tested in PSLE | Correct-answer words | Correct hits | Total hits |`);
  md.push(`|------|---------------|---------------------------|---------------|----------------------|--------------|------------|`);
  for (const s of [...stats].sort((a, b) => b.correctHits - a.correctHits)) {
    md.push(`| **${s.kind}** | ${s.totalInList} | ${s.p5Only} / ${s.p6Only} / ${s.bothLevels} | ${s.testedInPsle} (${Math.round(100 * s.testedInPsle / Math.max(s.totalInList, 1))}%) | ${s.correctAnswerWords} | ${s.correctHits} | ${s.totalHits} |`);
  }

  md.push(`\n## 🏛️ All 4-char 成语 in combined wordlist that PSLE has touched\n`);
  const allIdiomHits = annotated.filter(a => a.kind === "idiom" && a.hits.length > 0).sort((a, b) => {
    const ac = a.hits.filter(h => h.role === "correct").length;
    const bc = b.hits.filter(h => h.role === "correct").length;
    if (ac !== bc) return bc - ac;
    return b.hits.length - a.hits.length;
  });
  md.push(`| Idiom | Levels | Lessons | Correct hits | Other hits | Most recent appearance |`);
  md.push(`|-------|--------|---------|--------------|-----------|------------------------|`);
  for (const a of allIdiomHits) {
    const lvls = [...new Set(a.appearances.map(p => p.level))].join("+");
    const lessons = a.appearances.map(p => `${p.level}${p.lesson}`).join(", ");
    const correctH = a.hits.filter(h => h.role === "correct").length;
    const otherH = a.hits.length - correctH;
    const recent = a.hits[0];
    md.push(`| **${a.word}** | ${lvls} | ${lessons} | ${correctH} | ${otherH} | ${recent.year}/${recent.section}/Q${recent.qNum} |`);
  }

  md.push(`\n## 🎯 All 2-char compounds that have been a CORRECT answer (combined list)\n`);
  const compoundCorrect = annotated.filter(a => a.kind === "2-char compound" && a.hits.some(h => h.role === "correct"))
    .sort((a, b) => {
      const ac = a.hits.filter(h => h.role === "correct").length;
      const bc = b.hits.filter(h => h.role === "correct").length;
      if (ac !== bc) return bc - ac;
      return b.hits.length - a.hits.length;
    });
  md.push(`| Word | Levels | Lessons | Correct hits | Other hits | Most recent |`);
  md.push(`|------|--------|---------|--------------|-----------|-------------|`);
  for (const a of compoundCorrect) {
    const lvls = [...new Set(a.appearances.map(p => p.level))].join("+");
    const lessons = a.appearances.map(p => `${p.level}${p.lesson}`).join(", ");
    const correctH = a.hits.filter(h => h.role === "correct").length;
    const otherH = a.hits.length - correctH;
    const recent = a.hits.find(h => h.role === "correct")!;
    md.push(`| **${a.word}** | ${lvls} | ${lessons} | ${correctH} | ${otherH} | ${recent.year}/${recent.section}/Q${recent.qNum} |`);
  }

  // ─── Final summary ───────────────────────────────────────────────
  md.push(`\n## 🧭 Summary\n`);
  const totalTested = annotated.filter(a => a.hits.length > 0).length;
  const totalCorrect = annotated.filter(a => a.hits.some(h => h.role === "correct")).length;
  md.push(`- **Combined wordlist coverage**: ${totalTested} of ${allWords.length} words (${Math.round(100 * totalTested / allWords.length)}%) appeared in PSLE 2019-2024.`);
  md.push(`- **Correct-answer words**: ${totalCorrect} words have been a CORRECT MCQ answer in PSLE — the gold-list drill targets.`);
  md.push(`- **Adding P5 closes the 成语 gap**: P6 alone covered ${inP6Only.length + inBoth.length} of 16 PSLE-tested idioms; adding P5 brings this to ${PSLE_TESTED_IDIOMS_16.length - missing.length} (+${(PSLE_TESTED_IDIOMS_16.length - missing.length) - (inP6Only.length + inBoth.length)}).`);
  if (missing.length > 0) {
    md.push(`- **Still missing**: ${missing.map(r => r.idiom).join("、")} — these are tested by PSLE but neither textbook list has them. Likely came from earlier years (P3/P4) or are general high-frequency 成语 PSLE assumes students know.`);
  }

  const outDir = path.join(__dirname, "..", "..", "documents");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "P5+P6 Chinese wordlist — PSLE coverage.md");
  fs.writeFileSync(outPath, md.join("\n"), "utf8");
  console.log(`\nWrote ${outPath}`);

  // Console summary
  console.log(`\n=== 16-成语 coverage ===`);
  console.log(`  In P6 only:  ${inP6Only.length} → ${inP6Only.map(r => r.idiom).join("、")}`);
  console.log(`  In P5 only:  ${inP5Only.length} → ${inP5Only.map(r => r.idiom).join("、")}`);
  console.log(`  In both:     ${inBoth.length} → ${inBoth.map(r => r.idiom).join("、")}`);
  console.log(`  Missing:     ${missing.length} → ${missing.map(r => r.idiom).join("、")}`);
  console.log(`  Combined P5+P6 covers ${PSLE_TESTED_IDIOMS_16.length - missing.length}/${PSLE_TESTED_IDIOMS_16.length} (${Math.round(100 * (PSLE_TESTED_IDIOMS_16.length - missing.length) / PSLE_TESTED_IDIOMS_16.length)}%)`);

  await prisma.$disconnect();
})();
