// How many P4-P6 (combined) wordlist entries appeared in PSLE Chinese
// Q1-15 across the last 10 years (2016-2025)? Q1-15 = Section 1 语文
// 应用 MCQ (vocab / idiom / collocation). The user remembered ~10%.

import { promises as fs } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";

type RawLesson = {
  lessonNumber: string | null;
  lessonTitle: string | null;
  recogniseWords?: string[];
  writeWords?: string[];
  collocations?: string[];
  sentencePatterns?: string[];
};
type RawList = { lessons: RawLesson[]; words?: string[] };

const SCRIPT_DIR = __dirname;

function cjk(s: string) { return s.replace(/[^一-鿿]/g, ""); }

async function loadEntries(level: "p4" | "p5" | "p6"): Promise<Set<string>> {
  const file = path.join(SCRIPT_DIR, `${level}-spelling-list.json`);
  const raw = JSON.parse(await fs.readFile(file, "utf8")) as RawList;
  const out = new Set<string>();
  for (const lesson of raw.lessons ?? []) {
    for (const w of lesson.recogniseWords ?? []) {
      const c = cjk(w); if (c.length >= 2) out.add(c);
    }
    for (const w of lesson.writeWords ?? []) {
      const c = cjk(w); if (c.length >= 2) out.add(c);
    }
    for (const w of lesson.collocations ?? []) {
      const c = cjk(w); if (c.length >= 2) out.add(c);
    }
  }
  // Some lists have a flat "words" array
  for (const w of raw.words ?? []) {
    const c = cjk(w); if (c.length >= 2) out.add(c);
  }
  return out;
}

async function main() {
  const p4 = await loadEntries("p4");
  const p5 = await loadEntries("p5");
  const p6 = await loadEntries("p6");
  const combined = new Set([...p4, ...p5, ...p6]);
  console.log(`P4 entries: ${p4.size}`);
  console.log(`P5 entries: ${p5.size}`);
  console.log(`P6 entries: ${p6.size}`);
  console.log(`Combined (deduped): ${combined.size}`);

  // Pull PSLE Chinese Q1-15 questions for 2016-2025.
  const papers = await prisma.examPaper.findMany({
    where: {
      sourceExamId: null, paperType: null,
      subject: { contains: "chinese", mode: "insensitive" },
      title: { contains: "PSLE", mode: "insensitive" },
    },
    select: {
      id: true, year: true,
      questions: {
        select: { questionNum: true, transcribedStem: true, transcribedOptions: true, answer: true },
      },
    },
    orderBy: { year: "asc" },
  });
  console.log(`PSLE Chinese master papers: ${papers.length} (years ${papers.map(p => p.year).join(", ")})`);

  // For each paper, gather text from Q1-Q15 (stem + options).
  // Includes options because vocab MCQ ANSWERS contain the tested word
  // (the correct option is often the word in question).
  type Hit = { word: string; year: string; questionNum: string };
  const hits: Hit[] = [];
  let totalQs = 0;
  for (const p of papers) {
    for (const q of p.questions) {
      const n = parseInt(q.questionNum, 10);
      const Q_MAX = parseInt(process.env.Q_MAX ?? "15", 10);
      if (!Number.isFinite(n) || n < 1 || n > Q_MAX) continue;
      totalQs++;
      const opts = Array.isArray(q.transcribedOptions) ? (q.transcribedOptions as string[]).join(" ") : "";
      const blob = `${q.transcribedStem ?? ""} ${opts} ${q.answer ?? ""}`;
      // We test each combined-list word as a substring of the blob.
      // O(N×M) — both sides are bounded so it's fine in practice.
      for (const w of combined) {
        if (blob.includes(w)) hits.push({ word: w, year: p.year ?? "?", questionNum: q.questionNum });
      }
    }
  }
  console.log(`Q1-15 questions scanned: ${totalQs}`);

  const tested = new Set(hits.map(h => h.word));
  console.log(`\n=== HEADLINE ===`);
  console.log(`P4-6 combined wordlist entries: ${combined.size}`);
  console.log(`Of these, tested at least once in PSLE Q1-15 (2016-2025): ${tested.size}`);
  console.log(`Coverage: ${((tested.size / combined.size) * 100).toFixed(1)}%`);

  // Top tested words by hit count
  const tally = new Map<string, number>();
  for (const h of hits) tally.set(h.word, (tally.get(h.word) ?? 0) + 1);
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
  console.log(`\nTop 30 most-tested entries (hits across 10 years):`);
  for (const [w, c] of top) console.log(`  ${w.padEnd(8)} ${c}`);

  // Per-year hit count (just for transparency — how many tested words showed up in each year)
  console.log(`\nPer-year distinct words from list:`);
  for (const p of papers) {
    const yearHits = hits.filter(h => h.year === p.year);
    const distinctInYear = new Set(yearHits.map(h => h.word));
    console.log(`  ${p.year}: ${distinctInYear.size} distinct (from ${yearHits.length} hits)`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
