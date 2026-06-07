// Survey synthesis questions in the bank for the mid-sentence-keyword
// capitalisation bug. A keyword like "**Although**" at the START of an
// answer line should be capitalised; a keyword like "**whom**" in the
// MIDDLE should be lowercase (the sentence's leading word handles
// capitalisation).
//
// Detection rule: a keyword appears in MIDDLE position when its
// containing line in the stem starts with something OTHER than the
// keyword (e.g. begins with underscores). If a middle keyword starts
// with an uppercase letter AND isn't a proper noun, it's a candidate
// fix.

import { prisma } from "../src/lib/db";

// Proper-noun whitelist — keep capitalised even mid-sentence.
const PROPER = new Set(["I", "Mr", "Mrs", "Miss", "Ms"]);

type SynthRow = {
  id: string;
  questionNum: string;
  stem: string;
  answer: string | null;
  source: "exam" | "syntheticBank";
  paperTitle: string;
};

function* iterateKeywords(stem: string): Generator<{ raw: string; start: number; end: number; lineStart: number; lineEnd: number }> {
  const re = /\*\*([^*]{1,80})\*\*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stem)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    // Find line bounds.
    const before = stem.lastIndexOf("\n", start);
    const after = stem.indexOf("\n", start);
    const lineStart = before === -1 ? 0 : before + 1;
    const lineEnd = after === -1 ? stem.length : after;
    yield { raw: m[1], start, end, lineStart, lineEnd };
  }
}

function isMiddlePositionLine(line: string, kwStartInLine: number): boolean {
  // The keyword sits in MIDDLE when there's NON-whitespace content
  // before it on the same line (typically: underscores).
  const before = line.slice(0, kwStartInLine).replace(/\s/g, "");
  return before.length > 0;
}

function firstAlphaIsUpper(s: string): boolean {
  const first = s.match(/[A-Za-z]/);
  if (!first) return false;
  return first[0] >= "A" && first[0] <= "Z";
}

function tokenFirstWord(kw: string): string {
  return kw.trim().split(/[\s']+/)[0] ?? "";
}

async function main() {
  // 1. Pull all Synthesis & Transformation ExamQuestion rows from the
  //    [Synthetic Bank] paper (the AI-generated variants live there).
  const synthBankRows = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: { in: ["Synthesis / Transformation", "Synthesis & Transformation"] },
      examPaper: { OR: [{ examType: "Synthetic" }, { title: { startsWith: "[Synthetic Bank]" } }] },
    },
    select: { id: true, questionNum: true, transcribedStem: true, answer: true,
      examPaper: { select: { title: true } } },
  });

  // 2. Also include the human-authored master rows just to count — we
  //    won't auto-fix those (they're scanned, presumably correct).
  const masterRows = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: { in: ["Synthesis / Transformation", "Synthesis & Transformation"] },
      examPaper: {
        sourceExamId: null, paperType: null,
        NOT: [{ examType: "Synthetic" }, { title: { startsWith: "[Synthetic Bank]" } }],
      },
    },
    select: { id: true, questionNum: true, transcribedStem: true, answer: true,
      examPaper: { select: { title: true } } },
  });

  console.log(`Synth Bank rows: ${synthBankRows.length}`);
  console.log(`Master rows:     ${masterRows.length}`);
  console.log();

  type Hit = SynthRow & { hits: { rawKw: string; lineSnippet: string }[] };
  const synthHits: Hit[] = [];
  const masterHits: Hit[] = [];

  function scan(rows: typeof synthBankRows, source: "exam" | "syntheticBank", into: Hit[]) {
    for (const r of rows) {
      const stem = r.transcribedStem ?? "";
      if (!stem) continue;
      const offenders: { rawKw: string; lineSnippet: string }[] = [];
      for (const it of iterateKeywords(stem)) {
        const line = stem.slice(it.lineStart, it.lineEnd);
        const kwStartInLine = it.start - it.lineStart;
        if (!isMiddlePositionLine(line, kwStartInLine)) continue;
        const first = tokenFirstWord(it.raw);
        if (!firstAlphaIsUpper(first)) continue;
        if (PROPER.has(first)) continue;
        offenders.push({ rawKw: it.raw, lineSnippet: line.trim().slice(0, 100) });
      }
      if (offenders.length === 0) continue;
      into.push({
        id: r.id,
        questionNum: r.questionNum,
        stem,
        answer: r.answer,
        source,
        paperTitle: r.examPaper.title ?? "",
        hits: offenders,
      });
    }
  }

  scan(synthBankRows, "syntheticBank", synthHits);
  scan(masterRows, "exam", masterHits);

  console.log(`[Synthetic Bank] rows with mid-keyword caps issue: ${synthHits.length}`);
  console.log(`  Total offending keywords: ${synthHits.reduce((s, h) => s + h.hits.length, 0)}`);
  console.log();
  console.log(`Master (human-authored) rows with mid-keyword caps issue: ${masterHits.length}`);
  console.log(`  Total offending keywords: ${masterHits.reduce((s, h) => s + h.hits.length, 0)}`);
  console.log();

  console.log("=== Sample [Synthetic Bank] offenders (first 15) ===");
  for (const h of synthHits.slice(0, 15)) {
    console.log(`\n${h.paperTitle} Q${h.questionNum} (id=${h.id})`);
    for (const hit of h.hits) {
      console.log(`  KW: **${hit.rawKw}**`);
      console.log(`  LINE: ${hit.lineSnippet}`);
    }
    if (h.answer) console.log(`  ANS: ${h.answer.slice(0, 100)}`);
  }

  console.log("\n=== Sample master offenders (first 10) ===");
  for (const h of masterHits.slice(0, 10)) {
    console.log(`\n${h.paperTitle} Q${h.questionNum}`);
    for (const hit of h.hits) {
      console.log(`  KW: **${hit.rawKw}**`);
      console.log(`  LINE: ${hit.lineSnippet}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
