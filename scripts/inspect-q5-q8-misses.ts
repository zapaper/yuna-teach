// Inspect WHY Q5-6 (vocab) and Q7-8 (idiom meaning) have low drillable
// coverage. Show every miss with the question stem, correct answer,
// and whether the correct word is anywhere near in the wordlist.

import * as fs from "fs";
import * as path from "path";
import { prisma } from "../src/lib/db";

type RawLesson = { lessonNumber: string | null; recogniseWords: string[]; writeWords: string[]; collocations: string[] };

function cjk(s: string): string { return s.replace(/[^一-鿿]/g, ""); }

(async () => {
  const p5 = (JSON.parse(fs.readFileSync(path.join(__dirname, "p5-spelling-list.json"), "utf8")) as { lessons: RawLesson[] }).lessons;
  const p6 = (JSON.parse(fs.readFileSync(path.join(__dirname, "p6-spelling-list.json"), "utf8")) as { lessons: RawLesson[] }).lessons;

  const wordSet = new Set<string>();
  for (const rows of [p5, p6]) {
    for (const r of rows) {
      for (const w of [...r.recogniseWords, ...r.writeWords, ...r.collocations]) {
        if (cjk(w).length >= 2) wordSet.add(w);
      }
    }
  }

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

  const questions = await prisma.examQuestion.findMany({
    where: {
      examPaperId: { in: papers.map(p => p.id) },
      syllabusTopic: "语文应用 MCQ",
    },
    select: { questionNum: true, transcribedStem: true, transcribedOptions: true, answer: true, examPaperId: true },
  });

  console.log("=== Q5-6 Vocab questions (12 total) ===\n");
  const q56 = questions.filter(q => {
    const n = parseInt(q.questionNum ?? "0");
    return n >= 5 && n <= 6;
  }).sort((a, b) => (paperYear.get(a.examPaperId) ?? "").localeCompare(paperYear.get(b.examPaperId) ?? "") || parseInt(a.questionNum ?? "0") - parseInt(b.questionNum ?? "0"));

  for (const q of q56) {
    const opts = (Array.isArray(q.transcribedOptions) ? q.transcribedOptions : []) as string[];
    const ansNum = parseInt((q.answer ?? "").replace(/[^0-9]/g, ""), 10);
    const correctIdx = (ansNum >= 1 && ansNum <= 4) ? ansNum - 1 : -1;
    const correct = correctIdx >= 0 ? cjk(opts[correctIdx] ?? "") : "?";
    const allOpts = opts.map(o => cjk(o ?? ""));
    const correctInList = wordSet.has(correct);
    const optsInList = allOpts.map(o => `${o}${wordSet.has(o) ? "✓" : "✗"}`);
    const year = paperYear.get(q.examPaperId);
    console.log(`${year} Q${q.questionNum}  correct="${correct}" ${correctInList ? "✓ IN LIST" : "✗ NOT in list"}`);
    console.log(`         options: ${optsInList.join(" / ")}`);
    console.log(`         stem: ${(q.transcribedStem ?? "").trim().replace(/\s+/g, " ").slice(0, 90)}`);
    console.log();
  }

  console.log("\n=== Q7-8 Idiom-meaning questions (12 total) ===\n");
  const q78 = questions.filter(q => {
    const n = parseInt(q.questionNum ?? "0");
    return n >= 7 && n <= 8;
  }).sort((a, b) => (paperYear.get(a.examPaperId) ?? "").localeCompare(paperYear.get(b.examPaperId) ?? "") || parseInt(a.questionNum ?? "0") - parseInt(b.questionNum ?? "0"));

  for (const q of q78) {
    const stem = q.transcribedStem ?? "";
    const stemCjk = cjk(stem);
    // Find the idiom in the stem — usually the bold/underlined word.
    // OCR may use **...** or __...__ for emphasis; try both.
    const boldMatch = stem.match(/\*\*([^*]+)\*\*|__([^_]+)__/);
    const guessedIdiom = boldMatch ? cjk(boldMatch[1] ?? boldMatch[2] ?? "") : "(no bold/underline detected)";
    const idiomInList = wordSet.has(guessedIdiom);
    // Look for ANY wordlist word in stem.
    const candidates: string[] = [];
    for (let n = 2; n <= 5; n++) {
      for (let i = 0; i + n <= stemCjk.length; i++) {
        const sub = stemCjk.slice(i, i + n);
        if (wordSet.has(sub)) candidates.push(sub);
      }
    }
    const year = paperYear.get(q.examPaperId);
    console.log(`${year} Q${q.questionNum}  bold-marker idiom="${guessedIdiom}" ${idiomInList ? "✓ IN LIST" : "✗ NOT in list"}`);
    console.log(`         all wordlist words found in stem: ${candidates.length > 0 ? candidates.join(", ") : "(none)"}`);
    console.log(`         stem: ${stem.trim().replace(/\s+/g, " ").slice(0, 120)}`);
    console.log();
  }

  await prisma.$disconnect();
})();
