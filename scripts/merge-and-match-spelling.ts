// Merge odd+even pages (each lesson spans 2 PDF pages — the back of
// a page often continues 识读 / 识写 / 搭配 lists), then match every
// merged word against ALL PSLE Chinese 2019-2024 questions to produce
// the coverage / frequency analysis.

import * as fs from "fs";
import * as path from "path";
import { prisma } from "../src/lib/db";

type RawLesson = {
  page: number;
  lessonNumber: string | null;
  lessonTitle: string | null;
  recogniseWords: string[];
  writeWords: string[];
  collocations: string[];
  sentencePatterns: string[];
};

type MergedLesson = {
  lessonNumber: string;
  lessonTitle: string;
  pages: number[];
  recogniseWords: string[];
  writeWords: string[];
  collocations: string[];
  sentencePatterns: string[];
};

(async () => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "p6-spelling-list.json"), "utf8")) as {
    lessons: RawLesson[];
  };

  // ─── Merge pages by lesson (walk in order, carry current lesson) ──
  const merged: MergedLesson[] = [];
  let current: MergedLesson | null = null;
  for (const r of raw.lessons.sort((a, b) => a.page - b.page)) {
    if (r.lessonNumber) {
      // New lesson starts here. Flush previous.
      if (current) merged.push(current);
      current = {
        lessonNumber: r.lessonNumber,
        lessonTitle: r.lessonTitle ?? "",
        pages: [r.page],
        recogniseWords: [...r.recogniseWords],
        writeWords: [...r.writeWords],
        collocations: [...r.collocations],
        sentencePatterns: [...r.sentencePatterns],
      };
    } else if (current) {
      // Continuation page — extend current lesson.
      current.pages.push(r.page);
      current.recogniseWords.push(...r.recogniseWords);
      current.writeWords.push(...r.writeWords);
      current.collocations.push(...r.collocations);
      current.sentencePatterns.push(...r.sentencePatterns);
    }
  }
  if (current) merged.push(current);

  // Dedupe each lesson's lists (in case OCR repeated a word across pages).
  for (const m of merged) {
    m.recogniseWords = [...new Set(m.recogniseWords)];
    m.writeWords = [...new Set(m.writeWords)];
    m.collocations = [...new Set(m.collocations)];
  }

  console.log(`Merged into ${merged.length} lessons:`);
  for (const m of merged) {
    console.log(`  ${m.lessonNumber} ${m.lessonTitle}: ${m.recogniseWords.length} 识读, ${m.writeWords.length} 识写, ${m.collocations.length} 搭配  (pages ${m.pages.join("+")})`);
  }

  // ─── Build the global word repository ─────────────────────────────
  // Each word knows its lesson, type (识读/识写/搭配), and its index
  // within the lesson (for stable ordering when displayed).
  type WordRow = {
    word: string;
    lesson: string;
    lessonTitle: string;
    type: "识读" | "识写" | "搭配";
  };
  const allWords: WordRow[] = [];
  for (const m of merged) {
    for (const w of m.recogniseWords) allWords.push({ word: w, lesson: m.lessonNumber, lessonTitle: m.lessonTitle, type: "识读" });
    for (const w of m.writeWords) allWords.push({ word: w, lesson: m.lessonNumber, lessonTitle: m.lessonTitle, type: "识写" });
    for (const w of m.collocations) allWords.push({ word: w, lesson: m.lessonNumber, lessonTitle: m.lessonTitle, type: "搭配" });
  }
  // Per-unique-word index. If a word appears in multiple lessons (rare
  // but possible), we keep ALL appearances.
  const wordToRows = new Map<string, WordRow[]>();
  for (const r of allWords) {
    const arr = wordToRows.get(r.word) ?? [];
    arr.push(r);
    wordToRows.set(r.word, arr);
  }
  console.log(`\nTotal unique words: ${wordToRows.size}`);

  // ─── Pull EVERY PSLE Chinese 2019-2024 question (ALL sections) ────
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
  console.log(`\nPulled ${questions.length} questions from ${papers.length} PSLE Chinese papers.`);

  // Concat every text field of a question into a single searchable blob
  // (stem + options + subparts + answer). Strip non-Chinese to make
  // substring matching cleaner.
  function questionBlob(q: typeof questions[number]): string {
    const parts: string[] = [];
    if (q.transcribedStem) parts.push(q.transcribedStem);
    if (Array.isArray(q.transcribedOptions)) parts.push((q.transcribedOptions as unknown[]).map(o => String(o ?? "")).join(" "));
    if (Array.isArray(q.transcribedSubparts)) {
      for (const s of q.transcribedSubparts as Array<{ text?: string; label?: string }>) {
        if (s?.text) parts.push(String(s.text));
        if (s?.label) parts.push(String(s.label));
      }
    }
    if (q.answer) parts.push(q.answer);
    return parts.join(" ");
  }

  // ─── Match every wordlist word against every question ─────────────
  type Hit = { year: string; qNum: string; section: string };
  const wordHits = new Map<string, Hit[]>();

  for (const word of wordToRows.keys()) {
    // Only count words >= 2 CJK chars to avoid noise from single-char
    // words like 不 / 的 / 了 which would match everywhere.
    const cjk = word.replace(/[^一-鿿]/g, "");
    if (cjk.length < 2) continue;
    const hits: Hit[] = [];
    for (const q of questions) {
      const blob = questionBlob(q);
      if (blob.includes(word) || (cjk !== word && blob.includes(cjk))) {
        hits.push({
          year: paperYear.get(q.examPaperId) ?? "?",
          qNum: q.questionNum ?? "?",
          section: q.syllabusTopic ?? "?",
        });
      }
    }
    if (hits.length > 0) wordHits.set(word, hits);
  }

  // ─── Aggregate stats ──────────────────────────────────────────────
  const tested = [...wordHits.entries()].map(([word, hits]) => {
    const rows = wordToRows.get(word) ?? [];
    const distinctYears = new Set(hits.map(h => h.year));
    const distinctSections = new Set(hits.map(h => h.section));
    return {
      word,
      lessons: rows.map(r => r.lesson),
      types: [...new Set(rows.map(r => r.type))],
      hitCount: hits.length,
      yearCount: distinctYears.size,
      sections: [...distinctSections].sort(),
      hits,
    };
  }).sort((a, b) => b.hitCount - a.hitCount);

  // Per-section coverage breakdown.
  const sectionCounts = new Map<string, Set<string>>();
  for (const t of tested) {
    for (const h of t.hits) {
      const set = sectionCounts.get(h.section) ?? new Set<string>();
      set.add(t.word);
      sectionCounts.set(h.section, set);
    }
  }

  // Per-lesson coverage breakdown.
  const lessonCoverage = merged.map(m => {
    const all = [...m.recogniseWords, ...m.writeWords, ...m.collocations].filter(w =>
      w.replace(/[^一-鿿]/g, "").length >= 2,
    );
    const tested = all.filter(w => wordHits.has(w));
    return {
      lesson: m.lessonNumber,
      title: m.lessonTitle,
      totalWords: all.length,
      testedWords: tested.length,
      coveragePct: all.length === 0 ? 0 : Math.round(100 * tested.length / all.length),
      testedExamples: tested.slice(0, 10),
    };
  });

  // ─── Write final output ───────────────────────────────────────────
  const out = {
    generatedAt: new Date().toISOString(),
    source: "P6 高级华文 词语单 (12 lessons) — Maris Stella Primary",
    wordlist: merged,
    repository: {
      uniqueWords: wordToRows.size,
      byType: {
        识读: [...new Set(merged.flatMap(m => m.recogniseWords))].length,
        识写: [...new Set(merged.flatMap(m => m.writeWords))].length,
        搭配: [...new Set(merged.flatMap(m => m.collocations))].length,
      },
    },
    psleCoverage: {
      papersScanned: papers.length,
      questionsScanned: questions.length,
      wordsThatAppeared: tested.length,
      coveragePctOfDictionary: Math.round(100 * tested.length / wordToRows.size),
      bySection: [...sectionCounts.entries()].map(([section, set]) => ({
        section,
        distinctWords: set.size,
      })).sort((a, b) => b.distinctWords - a.distinctWords),
      byLesson: lessonCoverage,
      topWordsByFrequency: tested.slice(0, 80).map(t => ({
        word: t.word,
        hits: t.hitCount,
        years: t.yearCount,
        lessons: t.lessons,
        sections: t.sections,
        example: t.hits[0],
      })),
      fullHitList: tested.map(t => ({
        word: t.word,
        lessons: t.lessons,
        hits: t.hits.map(h => `${h.year}/${h.section}/Q${h.qNum}`),
      })),
    },
  };

  const outPath = path.join(__dirname, "p6-wordlist-vs-psle.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
  console.log(`\nWrote ${outPath}`);
  console.log(`\nCoverage: ${tested.length}/${wordToRows.size} (${Math.round(100 * tested.length / wordToRows.size)}%) wordlist words appeared in PSLE 2019-2024`);
  console.log(`\nTop 20 most-tested words:`);
  for (const t of tested.slice(0, 20)) {
    console.log(`  ${String(t.hitCount).padStart(3)}×  ${t.word.padEnd(8)}  (${t.lessons.join(",")}) — sections: ${t.sections.slice(0, 3).join(", ")}`);
  }

  await prisma.$disconnect();
})();
