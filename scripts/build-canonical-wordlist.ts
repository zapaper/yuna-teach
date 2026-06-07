// Canonical P6 Chinese wordlist — built ONLY from the three segments
// that actually represent vocabulary the student must learn:
//   1. 识读词语  (recognition words — read & understand in context)
//   2. 识写字词  (writing words — must be able to write)
//   3. 词语搭配  (collocations — verb-noun / adj-noun pairs)
//
// 句式 / 佳句 / 默写 segments are excluded — they're sentence-pattern
// examples and dictation passages, not vocabulary entries.
//
// Output:
//   p6-wordlist-canonical.json   — flat list of every entry
//   p6-wordlist-canonical.md     — human-readable by lesson
//   p6-wordlist-psle-crosscheck.md  — per-word PSLE 2019-2024 appearances

import * as fs from "fs";
import * as path from "path";
import { prisma } from "../src/lib/db";

type RawLesson = {
  lessonNumber: string;
  lessonTitle: string;
  pages: number[];
  recogniseWords: string[];
  writeWords: string[];
  collocations: string[];
};

type Entry = {
  word: string;
  chars: number;          // CJK length
  lessonNumber: string;
  lessonTitle: string;
  type: "识读" | "识写" | "搭配";
};

type Hit = {
  year: string;
  qNum: string;
  section: string;
  role: "correct" | "distractor" | "stem-or-passage";
};

(async () => {
  // ─── 1. Load the OCR'd merged lessons ─────────────────────────────
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "p6-wordlist-vs-psle.json"), "utf8")) as { wordlist: RawLesson[] };

  // ─── 2. Build the canonical entry list from EXACTLY 3 segments ────
  const entries: Entry[] = [];
  for (const m of raw.wordlist) {
    for (const w of m.recogniseWords) entries.push({ word: w, chars: w.replace(/[^一-鿿]/g, "").length, lessonNumber: m.lessonNumber, lessonTitle: m.lessonTitle, type: "识读" });
    for (const w of m.writeWords)     entries.push({ word: w, chars: w.replace(/[^一-鿿]/g, "").length, lessonNumber: m.lessonNumber, lessonTitle: m.lessonTitle, type: "识写" });
    for (const w of m.collocations)   entries.push({ word: w, chars: w.replace(/[^一-鿿]/g, "").length, lessonNumber: m.lessonNumber, lessonTitle: m.lessonTitle, type: "搭配" });
  }
  // Drop sub-character noise (any entry that's not at least 1 CJK char).
  const cleaned = entries.filter(e => e.chars >= 1);

  // Group entries that have the SAME word across multiple lessons or
  // types (e.g. 吩咐 appears in both L6 and L8). Each unique word has
  // one or more (lesson, type) appearances.
  type UniqueWord = {
    word: string;
    chars: number;
    appearances: Array<{ lesson: string; lessonTitle: string; type: Entry["type"] }>;
  };
  const byWord = new Map<string, UniqueWord>();
  for (const e of cleaned) {
    const existing = byWord.get(e.word) ?? { word: e.word, chars: e.chars, appearances: [] };
    existing.appearances.push({ lesson: e.lessonNumber, lessonTitle: e.lessonTitle, type: e.type });
    byWord.set(e.word, existing);
  }
  const uniqueWords = [...byWord.values()];
  console.log(`Canonical wordlist: ${cleaned.length} entries (${uniqueWords.length} unique words)`);

  // ─── 3. Pull every PSLE Chinese question (all 5 sections) ─────────
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
  console.log(`PSLE corpus: ${questions.length} questions across ${papers.length} papers`);

  // For role-resolution: only MCQ-style sections have a meaningful
  // (correct vs distractor) distinction. For 阅读理解 OEQ the "answer"
  // is free text, not an option index, so we just record the appearance.
  function questionFullText(q: typeof questions[number]): string {
    const parts: string[] = [];
    if (q.transcribedStem) parts.push(q.transcribedStem);
    if (Array.isArray(q.transcribedOptions)) parts.push((q.transcribedOptions as unknown[]).map(o => String(o ?? "")).join(" | "));
    if (Array.isArray(q.transcribedSubparts)) {
      for (const s of q.transcribedSubparts as Array<{ text?: string; label?: string }>) {
        if (s?.text) parts.push(String(s.text));
        if (s?.label) parts.push(String(s.label));
      }
    }
    if (q.answer) parts.push(`[ans: ${q.answer}]`);
    return parts.join(" ");
  }

  // ─── 4. Match every unique word against every question ────────────
  const wordHits = new Map<string, Hit[]>();
  for (const uw of uniqueWords) {
    if (uw.chars < 2) continue;  // skip 1-char to avoid noise
    const hits: Hit[] = [];
    for (const q of questions) {
      const opts = (Array.isArray(q.transcribedOptions) ? q.transcribedOptions : []) as string[];
      const ansNum = parseInt((q.answer ?? "").replace(/[^0-9]/g, ""), 10);
      const correctIdx = (ansNum >= 1 && ansNum <= 4) ? ansNum - 1 : -1;
      const fullText = questionFullText(q);
      if (!fullText.includes(uw.word)) continue;

      // Determine role for MCQ sections.
      let role: Hit["role"] = "stem-or-passage";
      if (opts.length === 4) {
        if (correctIdx >= 0 && (opts[correctIdx] ?? "").includes(uw.word)) role = "correct";
        else if (opts.some(o => (o ?? "").includes(uw.word))) role = "distractor";
      }
      hits.push({
        year: paperYear.get(q.examPaperId) ?? "?",
        qNum: q.questionNum ?? "?",
        section: q.syllabusTopic ?? "?",
        role,
      });
    }
    if (hits.length > 0) wordHits.set(uw.word, hits);
  }
  console.log(`Words with PSLE hits: ${wordHits.size} of ${uniqueWords.length}`);

  // ─── 5. Write canonical JSON ──────────────────────────────────────
  const canonical = {
    generatedAt: new Date().toISOString(),
    source: "P6 高级华文 词语单 — Maris Stella Primary",
    segments: ["识读词语", "识写字词", "词语搭配"],
    totals: {
      lessons: raw.wordlist.length,
      totalEntries: cleaned.length,
      uniqueWords: uniqueWords.length,
      byType: {
        识读: cleaned.filter(e => e.type === "识读").length,
        识写: cleaned.filter(e => e.type === "识写").length,
        搭配: cleaned.filter(e => e.type === "搭配").length,
      },
    },
    perLesson: raw.wordlist.map(m => ({
      lessonNumber: m.lessonNumber,
      lessonTitle: m.lessonTitle,
      识读词语: m.recogniseWords,
      识写字词: m.writeWords,
      词语搭配: m.collocations,
    })),
    words: uniqueWords
      .sort((a, b) => a.word.localeCompare(b.word))
      .map(uw => {
        const hits = wordHits.get(uw.word) ?? [];
        const correctCount = hits.filter(h => h.role === "correct").length;
        const distractorCount = hits.filter(h => h.role === "distractor").length;
        const otherCount = hits.filter(h => h.role === "stem-or-passage").length;
        return {
          word: uw.word,
          chars: uw.chars,
          appearances: uw.appearances,
          pslePsleSections: [...new Set(hits.map(h => h.section))].sort(),
          psleYears: [...new Set(hits.map(h => h.year))].sort(),
          totalHits: hits.length,
          correctCount,
          distractorCount,
          stemOrPassageCount: otherCount,
          hits,
        };
      }),
  };
  fs.writeFileSync(path.join(__dirname, "p6-wordlist-canonical.json"), JSON.stringify(canonical, null, 2), "utf8");

  // ─── 6. Canonical markdown — for visual verification ──────────────
  const md1: string[] = [];
  md1.push("# P6 Chinese Canonical Wordlist (3 segments)\n");
  md1.push(`**Segments included:** 识读词语 · 识写字词 · 词语搭配`);
  md1.push(`**Total entries:** ${canonical.totals.totalEntries} (识读 ${canonical.totals.byType["识读"]} + 识写 ${canonical.totals.byType["识写"]} + 搭配 ${canonical.totals.byType["搭配"]})`);
  md1.push(`**Unique words:** ${canonical.totals.uniqueWords}\n`);
  for (const m of canonical.perLesson) {
    md1.push(`\n## ${m.lessonNumber} ${m.lessonTitle}\n`);
    md1.push(`**识读词语 (${m["识读词语"].length})**`);
    md1.push(m["识读词语"].join("、") || "—");
    md1.push(`\n**识写字词 (${m["识写字词"].length})**`);
    md1.push(m["识写字词"].join("、") || "—");
    md1.push(`\n**词语搭配 (${m["词语搭配"].length})**`);
    md1.push(m["词语搭配"].join("、") || "—");
  }
  fs.writeFileSync(path.join(__dirname, "p6-wordlist-canonical.md"), md1.join("\n"), "utf8");

  // ─── 7. PSLE cross-check report ───────────────────────────────────
  // For each lesson, show every word that has PSLE hits with its
  // section/year/role breakdown.
  const md2: string[] = [];
  md2.push("# P6 Wordlist × PSLE Chinese 2019-2024 — cross-check\n");
  md2.push(`Every wordlist entry that appears in ANY PSLE question (all 5 sections), with role & frequency.\n`);
  md2.push(`**Role legend:**`);
  md2.push(`- **correct** — the word is part of the OPTION marked as the correct answer (MCQ)`);
  md2.push(`- **distractor** — the word is part of a wrong MCQ option`);
  md2.push(`- **stem-or-passage** — the word appears in the question stem, passage text, or OEQ answer; no "right/wrong" framing\n`);

  // Top-level summary table
  md2.push(`\n## Coverage summary by lesson\n`);
  md2.push(`| Lesson | Title | Total words | Tested | Correct-ans hits | Total PSLE hits |`);
  md2.push(`|--------|-------|-------------|--------|------------------|----------------|`);
  for (const m of canonical.perLesson) {
    const all = [...new Set([...m["识读词语"], ...m["识写字词"], ...m["词语搭配"]])].filter(w => w.replace(/[^一-鿿]/g, "").length >= 2);
    const tested = all.filter(w => wordHits.has(w));
    const correctHits = tested.reduce((sum, w) => sum + (wordHits.get(w)?.filter(h => h.role === "correct").length ?? 0), 0);
    const totalHits = tested.reduce((sum, w) => sum + (wordHits.get(w)?.length ?? 0), 0);
    md2.push(`| ${m.lessonNumber} | ${m.lessonTitle} | ${all.length} | ${tested.length} (${Math.round(100 * tested.length / all.length)}%) | ${correctHits} | ${totalHits} |`);
  }

  // Per-lesson detail with WORD-level breakdown
  for (const m of canonical.perLesson) {
    const allInLesson = [...new Set([...m["识读词语"], ...m["识写字词"], ...m["词语搭配"]])]
      .filter(w => w.replace(/[^一-鿿]/g, "").length >= 2);
    const lessonWithHits = allInLesson
      .filter(w => wordHits.has(w))
      .map(w => {
        const hits = wordHits.get(w)!;
        const types: string[] = [];
        if (m["识读词语"].includes(w)) types.push("识读");
        if (m["识写字词"].includes(w)) types.push("识写");
        if (m["词语搭配"].includes(w)) types.push("搭配");
        return { word: w, types, hits };
      })
      .sort((a, b) => {
        // Correct-answer hits first, then by total hits.
        const ac = a.hits.filter(h => h.role === "correct").length;
        const bc = b.hits.filter(h => h.role === "correct").length;
        if (ac !== bc) return bc - ac;
        return b.hits.length - a.hits.length;
      });
    if (lessonWithHits.length === 0) continue;
    md2.push(`\n## ${m.lessonNumber} ${m.lessonTitle}\n`);
    md2.push(`${lessonWithHits.length} of ${allInLesson.length} words appeared in PSLE 2019-2024.\n`);
    md2.push(`| Word | Type | PSLE appearances |`);
    md2.push(`|------|------|--------------------|`);
    for (const w of lessonWithHits) {
      const apps = w.hits.map(h => {
        const tag = h.role === "correct" ? "✓correct" : h.role === "distractor" ? "✗distractor" : "stem/passage";
        return `${h.year}/${h.section}/Q${h.qNum} (${tag})`;
      }).join("; ");
      md2.push(`| **${w.word}** | ${w.types.join("/")} | ${apps} |`);
    }
  }

  // Final list: words that NEVER appeared (the "untested" tail)
  md2.push(`\n## Words in the canonical list that NEVER appeared in PSLE 2019-2024\n`);
  const untestedByLesson = canonical.perLesson.map(m => {
    const all = [...new Set([...m["识读词语"], ...m["识写字词"], ...m["词语搭配"]])].filter(w => w.replace(/[^一-鿿]/g, "").length >= 2);
    return { lesson: m.lessonNumber, title: m.lessonTitle, words: all.filter(w => !wordHits.has(w)) };
  });
  for (const u of untestedByLesson) {
    if (u.words.length === 0) continue;
    md2.push(`- **${u.lesson} ${u.title}** (${u.words.length}): ${u.words.join("、")}`);
  }

  fs.writeFileSync(path.join(__dirname, "p6-wordlist-psle-crosscheck.md"), md2.join("\n"), "utf8");

  console.log(`\nWrote:`);
  console.log(`  scripts/p6-wordlist-canonical.json`);
  console.log(`  scripts/p6-wordlist-canonical.md  (for visual verification)`);
  console.log(`  scripts/p6-wordlist-psle-crosscheck.md  (per-word PSLE appearances)`);

  await prisma.$disconnect();
})();
