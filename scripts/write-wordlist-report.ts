// Produce two human-readable markdown reports from the merged data:
//   1. p6-wordlist-repository.md — for visual verification (every
//      lesson with its 识读/识写/搭配 lists). User can sanity-check
//      OCR against the original PDF here.
//   2. p6-wordlist-vs-psle-report.md — per-lesson and per-PSLE-section
//      coverage analysis with concrete examples.

import * as fs from "fs";
import * as path from "path";

type Report = {
  source: string;
  wordlist: Array<{
    lessonNumber: string;
    lessonTitle: string;
    pages: number[];
    recogniseWords: string[];
    writeWords: string[];
    collocations: string[];
    sentencePatterns: string[];
  }>;
  repository: {
    uniqueWords: number;
    byType: { 识读: number; 识写: number; 搭配: number };
  };
  psleCoverage: {
    papersScanned: number;
    questionsScanned: number;
    wordsThatAppeared: number;
    coveragePctOfDictionary: number;
    bySection: Array<{ section: string; distinctWords: number }>;
    byLesson: Array<{
      lesson: string;
      title: string;
      totalWords: number;
      testedWords: number;
      coveragePct: number;
      testedExamples: string[];
    }>;
    topWordsByFrequency: Array<{
      word: string;
      hits: number;
      years: number;
      lessons: string[];
      sections: string[];
      example: { year: string; qNum: string; section: string };
    }>;
    fullHitList: Array<{
      word: string;
      lessons: string[];
      hits: string[];
    }>;
  };
};

(async () => {
  const r = JSON.parse(fs.readFileSync(path.join(__dirname, "p6-wordlist-vs-psle.json"), "utf8")) as Report;

  // ─── 1. Repository view for visual verification ───────────────────
  const lines1: string[] = [];
  lines1.push("# P6 高级华文 词语单 — Repository (for visual verification)\n");
  lines1.push(`Source: ${r.source}`);
  lines1.push(`Unique words: ${r.repository.uniqueWords} (识读 ${r.repository.byType["识读"]} + 识写 ${r.repository.byType["识写"]} + 搭配 ${r.repository.byType["搭配"]})\n`);
  lines1.push(`> **Verify against the original PDF.** Each lesson below shows what Gemini OCR extracted. Flag any missing or wrong characters and I'll re-OCR that page.\n`);
  for (const m of r.wordlist) {
    lines1.push(`\n## ${m.lessonNumber} ${m.lessonTitle}  (pages ${m.pages.join(", ")})\n`);
    lines1.push(`**识读词语 (${m.recogniseWords.length})**`);
    lines1.push(m.recogniseWords.join("、"));
    lines1.push(`\n**识写字词 (${m.writeWords.length})**`);
    lines1.push(m.writeWords.join("、"));
    lines1.push(`\n**词语搭配 (${m.collocations.length})**`);
    lines1.push(m.collocations.join("、"));
    if (m.sentencePatterns.length > 0) {
      lines1.push(`\n**句式 (${m.sentencePatterns.length})**`);
      for (const s of m.sentencePatterns) lines1.push(`- ${s}`);
    }
  }
  fs.writeFileSync(path.join(__dirname, "p6-wordlist-repository.md"), lines1.join("\n"), "utf8");

  // ─── 2. PSLE coverage report ──────────────────────────────────────
  const lines2: string[] = [];
  const cov = r.psleCoverage;
  lines2.push("# P6 高级华文 词语单 → PSLE Chinese 2019-2024 coverage\n");
  lines2.push(`Scanned **${cov.questionsScanned} questions** across **${cov.papersScanned} PSLE Chinese papers** (full papers, all sections).\n`);
  lines2.push(`**Headline:** ${cov.wordsThatAppeared} of ${r.repository.uniqueWords} wordlist entries (${cov.coveragePctOfDictionary}%) appear at least once in PSLE 2019-2024.\n`);
  lines2.push(`That 18% number is unsurprising: the wordlist is the textbook's full P6 vocabulary, including narrative-specific words like 三国 / 龙王 / 张飞 that PSLE would never test. The interesting question is **which** words got tested and **where**.\n`);

  lines2.push(`\n## Coverage by PSLE section\n`);
  lines2.push(`How many distinct wordlist entries showed up in each section type:\n`);
  lines2.push(`| Section | Distinct wordlist hits |`);
  lines2.push(`|---------|------------------------|`);
  for (const s of cov.bySection) {
    lines2.push(`| ${s.section} | ${s.distinctWords} |`);
  }

  lines2.push(`\n## Coverage by lesson (% of textbook lesson tested by PSLE)\n`);
  lines2.push(`| Lesson | Title | Total | Tested | % | Tested examples |`);
  lines2.push(`|--------|-------|-------|--------|---|----------------|`);
  for (const l of cov.byLesson) {
    lines2.push(`| ${l.lesson} | ${l.title} | ${l.totalWords} | ${l.testedWords} | ${l.coveragePct}% | ${l.testedExamples.slice(0, 6).join("、") || "—"} |`);
  }

  lines2.push(`\n## Top 50 most-tested wordlist entries\n`);
  lines2.push(`| Word | PSLE hits | Years | Lesson(s) | Sections |`);
  lines2.push(`|------|-----------|-------|-----------|----------|`);
  for (const t of cov.topWordsByFrequency.slice(0, 50)) {
    lines2.push(`| **${t.word}** | ${t.hits} | ${t.years} | ${t.lessons.join("/")} | ${t.sections.join(", ")} |`);
  }

  lines2.push(`\n## What this tells us\n`);
  lines2.push(`1. **High-frequency words (10+ hits)** are mostly common function words — they appear in EVERY passage regardless of topic. Drilling these specifically gives little marginal value; students already see them everywhere.\n`);
  lines2.push(`2. **Medium-frequency words (3-9 hits)** are the sweet spot — concrete vocabulary that PSLE actually tests in 语文应用 MCQ Q5-Q6 (vocabulary choice) and 短文填空. Examples: **保护、合理、鼓励、健康、制作、介绍、感受、反应、选择、其他**.\n`);
  lines2.push(`3. **Single-hit words** suggest one-shot appearances — useful as exposure but not drill priorities.\n`);
  lines2.push(`4. **High-coverage lessons** (those with the most tested words) likely contain the highest-density "general PSLE vocabulary" — those lessons matter more for PSLE prep than narrative-specific ones.\n`);

  lines2.push(`\n## Words used in multiple PSLE sections (more "versatile")\n`);
  const versatile = cov.topWordsByFrequency
    .filter(t => t.sections.length >= 2)
    .slice(0, 30);
  lines2.push(`| Word | Sections it appeared in | Hits | Lesson |`);
  lines2.push(`|------|--------------------------|------|--------|`);
  for (const t of versatile) {
    lines2.push(`| ${t.word} | ${t.sections.join(" / ")} | ${t.hits} | ${t.lessons.join(",")} |`);
  }

  fs.writeFileSync(path.join(__dirname, "p6-wordlist-vs-psle-report.md"), lines2.join("\n"), "utf8");

  console.log("Wrote:");
  console.log("  scripts/p6-wordlist-repository.md  (for visual verification)");
  console.log("  scripts/p6-wordlist-vs-psle-report.md  (coverage analysis)");
})();
