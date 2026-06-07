// "Hard word" coverage analysis — focus on the wordlist entries that
// matter for PSLE prep, not the trivial words that show up in every
// passage anyway.
//
// Filters applied:
//   1. Restrict to vocabulary-testing sections only:
//      - 语文应用 MCQ (Booklet A first section)
//      - 短文填空 (passage cloze)
//      Skip 阅读理解 / 完成对话 because they pull whole passages — any
//      common word matches there.
//   2. Drop common P3-P4 stopwords (老师, 知道, 文章, 因为, 但是, etc.)
//   3. Show whether the word was a CORRECT answer or just appeared
//      in the stem/options — correct answers are the real signal.
//   4. Group by lesson and surface 成语 + 3-char+ phrases separately.

import * as fs from "fs";
import * as path from "path";
import { prisma } from "../src/lib/db";

const VOCAB_SECTIONS = new Set(["语文应用 MCQ", "短文填空"]);

// Common P3-P4 words we want to filter out — they appear in every
// passage and tell us nothing about PSLE difficulty. Hand-curated from
// the top-frequency list we already produced.
const STOPWORDS = new Set([
  "老师", "为什么", "知道", "作者", "文章", "告诉", "目的", "方法", "鼓励",
  "健康", "制作", "合理", "保护", "但是", "介绍", "感受", "除了", "选择",
  "其他", "反应", "图书馆", "充满", "面对", "一系列", "才能", "帮忙", "拒绝",
  "毕业", "很多", "放弃", "吸引", "方便", "热心", "材料", "模仿", "当时",
  "打扰", "因为", "所以", "如果", "可以", "应该", "什么", "今天", "明天",
  "我们", "他们", "你们", "孩子", "学校", "同学", "朋友", "妈妈", "爸爸",
  "事情", "时候", "地方", "想象", "认真", "经常", "时常", "总是", "一定",
  "一样", "一起", "一直", "一个", "一些", "已经", "以为", "可能", "其实",
  "他们", "她们", "自己", "别人", "大家", "全班", "全家", "全国",
  "弟弟", "妹妹", "姐姐", "哥哥", "外公", "外婆", "爷爷", "奶奶",
  "公园", "电视", "电脑", "现在", "刚才", "上次", "下次",
  "工作", "学习", "活动", "比赛", "表演",
]);

function cjkOnly(s: string): string {
  return s.replace(/[^一-鿿]/g, "");
}

type WordRow = { word: string; lesson: string; type: string };
type RawLesson = {
  lessonNumber: string;
  lessonTitle: string;
  recogniseWords: string[];
  writeWords: string[];
  collocations: string[];
};

(async () => {
  const merged = (JSON.parse(fs.readFileSync(path.join(__dirname, "p6-wordlist-vs-psle.json"), "utf8")) as { wordlist: RawLesson[] }).wordlist;

  // Index every word with its lesson + section type
  const wordToRows = new Map<string, WordRow[]>();
  for (const m of merged) {
    const push = (word: string, type: string) => {
      const arr = wordToRows.get(word) ?? [];
      arr.push({ word, lesson: m.lessonNumber, type });
      wordToRows.set(word, arr);
    };
    for (const w of m.recogniseWords) push(w, "识读");
    for (const w of m.writeWords) push(w, "识写");
    for (const w of m.collocations) push(w, "搭配");
  }

  // ─── Pull PSLE questions for vocab sections only ──────────────────
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
    where: {
      examPaperId: { in: papers.map(p => p.id) },
      syllabusTopic: { in: [...VOCAB_SECTIONS] },
    },
    select: {
      questionNum: true,
      transcribedStem: true,
      transcribedOptions: true,
      answer: true,
      syllabusTopic: true,
      examPaperId: true,
    },
  });

  type Hit = {
    year: string; qNum: string; section: string;
    role: "correct" | "distractor" | "stem";
    optionsCsv: string;
    stem: string;
  };
  const hits = new Map<string, Hit[]>();

  for (const q of questions) {
    const opts = (Array.isArray(q.transcribedOptions) ? q.transcribedOptions : []) as string[];
    const ansNum = parseInt((q.answer ?? "").replace(/[^0-9]/g, ""), 10);
    const correctIdx = (ansNum >= 1 && ansNum <= 4) ? ansNum - 1 : -1;
    const year = paperYear.get(q.examPaperId) ?? "?";
    const qNum = q.questionNum ?? "?";
    const section = q.syllabusTopic ?? "?";
    const stem = (q.transcribedStem ?? "").trim();

    for (const word of wordToRows.keys()) {
      if (cjkOnly(word).length < 2) continue;
      // Where did this word appear?
      let role: Hit["role"] | null = null;
      if (correctIdx >= 0 && opts[correctIdx]?.includes(word)) role = "correct";
      else if (opts.some(o => (o ?? "").includes(word))) role = "distractor";
      else if (stem.includes(word)) role = "stem";
      if (!role) continue;
      const arr = hits.get(word) ?? [];
      arr.push({ year, qNum, section, role, optionsCsv: opts.join(" | "), stem: stem.slice(0, 80) });
      hits.set(word, arr);
    }
  }

  type WordReport = {
    word: string;
    lessons: string[];
    types: string[];
    chars: number;
    correctCount: number;
    distractorCount: number;
    stemCount: number;
    totalHits: number;
    yearCount: number;
    examples: Array<{ year: string; qNum: string; section: string; role: string }>;
  };

  const report: WordReport[] = [];
  for (const [word, arr] of hits.entries()) {
    if (STOPWORDS.has(word)) continue;
    const rows = wordToRows.get(word) ?? [];
    const distinctYears = new Set(arr.map(h => h.year));
    report.push({
      word,
      lessons: [...new Set(rows.map(r => r.lesson))],
      types: [...new Set(rows.map(r => r.type))],
      chars: cjkOnly(word).length,
      correctCount: arr.filter(h => h.role === "correct").length,
      distractorCount: arr.filter(h => h.role === "distractor").length,
      stemCount: arr.filter(h => h.role === "stem").length,
      totalHits: arr.length,
      yearCount: distinctYears.size,
      examples: arr.slice(0, 4).map(h => ({ year: h.year, qNum: h.qNum, section: h.section, role: h.role })),
    });
  }

  // Sort by "PSLE testable signal":
  //   correctCount × 3 + distractorCount × 1 + stemCount × 0.5
  // because being the correct answer is the strongest indicator that
  // this word is in PSLE's hot-list.
  report.sort((a, b) => {
    const sa = a.correctCount * 3 + a.distractorCount + a.stemCount * 0.5;
    const sb = b.correctCount * 3 + b.distractorCount + b.stemCount * 0.5;
    return sb - sa;
  });

  // ─── Buckets ──────────────────────────────────────────────────────
  // 1. Words that have been a CORRECT answer in 语文应用 MCQ — these
  //    are the "this word is PSLE-Q5-Q6 worthy" gold list.
  const correctAnswerHits = report.filter(r => r.correctCount > 0);

  // 2. 成语 (4-char idioms) that appeared — almost always Q7-Q8 or
  //    Q13-Q15 material.
  const idioms4char = report.filter(r => r.chars === 4);

  // 3. 3-char compounds — uncommon in everyday speech, often tested
  //    in 短文填空.
  const threeChar = report.filter(r => r.chars === 3);

  // 4. The "hidden gems" — words that appeared multiple times in the
  //    vocabulary sections (语文应用 or 短文填空) but aren't on most
  //    students' radar.
  const hiddenGems = report.filter(r =>
    r.totalHits >= 2 && r.correctCount + r.distractorCount >= 1
  );

  // ─── Markdown report ──────────────────────────────────────────────
  const lines: string[] = [];
  lines.push("# P6 词语单 — \"hard word\" PSLE coverage\n");
  lines.push(`Scope: only 语文应用 MCQ + 短文填空 sections (the vocabulary-testing slots), stopwords removed.\n`);
  lines.push(`Across 6 PSLE years (2019-2024), **${report.length} wordlist entries** appeared in these vocab sections.\n`);

  lines.push(`## 1. Words that have been a CORRECT answer in PSLE vocab questions (gold list)\n`);
  lines.push(`These are the words PSLE has explicitly tested. If a student doesn't know these, they'll lose marks directly.\n`);
  lines.push(`| Word | Chars | Lesson | Type | Correct-ans count | Section/Year examples |`);
  lines.push(`|------|-------|--------|------|------|----------------------|`);
  for (const r of correctAnswerHits.slice(0, 50)) {
    const ex = r.examples.filter(e => e.role === "correct").slice(0, 3).map(e => `${e.year}/${e.section.replace(" MCQ", "")}/Q${e.qNum}`).join(", ");
    lines.push(`| **${r.word}** | ${r.chars} | ${r.lessons.join(",")} | ${r.types.join("/")} | ${r.correctCount} | ${ex} |`);
  }

  lines.push(`\n## 2. 成语 from the wordlist that appeared in PSLE\n`);
  lines.push(`| Idiom | Lesson | Total hits | Roles | Years tested |`);
  lines.push(`|-------|--------|------------|-------|--------------|`);
  for (const r of idioms4char.slice(0, 40)) {
    const roles: string[] = [];
    if (r.correctCount) roles.push(`correct×${r.correctCount}`);
    if (r.distractorCount) roles.push(`distractor×${r.distractorCount}`);
    if (r.stemCount) roles.push(`stem×${r.stemCount}`);
    lines.push(`| **${r.word}** | ${r.lessons.join(",")} | ${r.totalHits} | ${roles.join(", ")} | ${r.yearCount} |`);
  }

  lines.push(`\n## 3. 3-character words from the wordlist that appeared\n`);
  lines.push(`These tend to be harder vocabulary — full noun phrases or less common compounds.\n`);
  lines.push(`| Word | Lesson | Total hits | Roles |`);
  lines.push(`|------|--------|------------|-------|`);
  for (const r of threeChar.slice(0, 40)) {
    const roles: string[] = [];
    if (r.correctCount) roles.push(`correct×${r.correctCount}`);
    if (r.distractorCount) roles.push(`distractor×${r.distractorCount}`);
    if (r.stemCount) roles.push(`stem×${r.stemCount}`);
    lines.push(`| **${r.word}** | ${r.lessons.join(",")} | ${r.totalHits} | ${roles.join(", ")} |`);
  }

  lines.push(`\n## 4. \"Hidden gems\" — multi-hit vocab tests from the wordlist\n`);
  lines.push(`Words that have been actively tested in vocab sections at least 2× and have shown up as a correct answer or distractor at least once. These are the highest-leverage drill targets.\n`);
  lines.push(`| Word | Chars | Lesson | Total hits | Roles | Years |`);
  lines.push(`|------|-------|--------|------------|-------|-------|`);
  for (const r of hiddenGems.slice(0, 50)) {
    const roles: string[] = [];
    if (r.correctCount) roles.push(`correct×${r.correctCount}`);
    if (r.distractorCount) roles.push(`distractor×${r.distractorCount}`);
    if (r.stemCount) roles.push(`stem×${r.stemCount}`);
    lines.push(`| **${r.word}** | ${r.chars} | ${r.lessons.join(",")} | ${r.totalHits} | ${roles.join(", ")} | ${r.yearCount} |`);
  }

  lines.push(`\n## 5. Wordlist entries that NEVER appeared (untested but in the textbook)\n`);
  // These are textbook words PSLE has not tested in 6 years — could be
  // either too narrative-specific OR genuinely lower priority for PSLE.
  const allTested = new Set(report.map(r => r.word));
  const untested = new Set<string>();
  for (const m of merged) {
    for (const w of [...m.recogniseWords, ...m.writeWords, ...m.collocations]) {
      if (cjkOnly(w).length < 2) continue;
      if (!allTested.has(w) && !STOPWORDS.has(w)) untested.add(w);
    }
  }
  lines.push(`**${untested.size} wordlist entries** have not surfaced in PSLE 2019-2024 vocab sections (mostly narrative-specific words). Sample by lesson:\n`);
  for (const m of merged) {
    const lessonUntested = [...m.recogniseWords, ...m.writeWords, ...m.collocations]
      .filter(w => untested.has(w))
      .slice(0, 12);
    if (lessonUntested.length > 0) {
      lines.push(`- **${m.lessonNumber} ${m.lessonTitle}**: ${lessonUntested.join("、")}${lessonUntested.length >= 12 ? "..." : ""}`);
    }
  }

  fs.writeFileSync(path.join(__dirname, "p6-hard-words-vs-psle.md"), lines.join("\n"), "utf8");
  console.log(`Wrote scripts/p6-hard-words-vs-psle.md`);
  console.log(`\nSummary:`);
  console.log(`  Wordlist entries appearing in vocab sections: ${report.length}`);
  console.log(`  Words that have been CORRECT answers: ${correctAnswerHits.length}`);
  console.log(`  4-char 成语 from list that PSLE used: ${idioms4char.length}`);
  console.log(`  3-char compounds from list that PSLE used: ${threeChar.length}`);
  console.log(`  "Hidden gem" multi-hit drillable words: ${hiddenGems.length}`);
  console.log(`  Untested wordlist entries: ${untested.size}`);

  await prisma.$disconnect();
})();
