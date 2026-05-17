// Surface every P6 English synthesis question where the answer uses a
// noun-form transformation of an adjective/verb from the source, usually
// introduced by "Due to / On account of / Because of / In + noun / X's …".
//
// Run: npx tsx scripts/list-p6-noun-form-synthesis.ts

import { prisma } from "@/lib/db";

const NOUN_FORM_PATTERNS = [
  /\bOn account of\b/i,
  /\bDue to\b/i,
  /\bBecause of\b/i,
  /\bOwing to\b/i,
  /\bAs a result of\b/i,
  /\bIn (?:dis)?[a-z]+(?:ness|ment|ity|ance|ence|tion|sion|hood|ship|age|cy|ry)\b/i,
  /\b[A-Z][a-z]+'s (?:dis|in|un)?[a-z]+(?:ness|ment|ity|ance|ence|tion|sion|hood|age|cy|ry)\b/,
  /\bhave a preference for\b/i,
];

const NOMINAL_SUFFIX = /\b\w+(?:ness|ment|ity|ance|ence|tion|sion|hood|ship|age|cy|ry|al)\b/;

async function main() {
  const papers = await prisma.examPaper.findMany({
    where: {
      subject: { contains: "English", mode: "insensitive" },
      level: { in: ["Primary 6", "P6"] },
      paperType: null,
      sourceExamId: null,
      NOT: { title: { startsWith: "[Synthetic Bank]" } },
    },
    select: { id: true, title: true, school: true, year: true, examType: true },
  });

  const paperById = new Map(papers.map((p) => [p.id, p]));
  const qs = await prisma.examQuestion.findMany({
    where: {
      examPaperId: { in: papers.map((p) => p.id) },
      transcribedStem: { not: null },
    },
    select: {
      id: true,
      questionNum: true,
      transcribedStem: true,
      answer: true,
      examPaperId: true,
    },
  });

  // Keep only synthesis questions (stem has a **keyword**).
  const synthesis = qs.filter((q) => /\*\*[^*]+\*\*/.test(q.transcribedStem ?? ""));

  // Match on the answer rather than the stem — the noun form shows up in the
  // transformed answer, not the source sentence.
  const nounForm = synthesis.filter((q) => {
    const a = q.answer ?? "";
    if (NOUN_FORM_PATTERNS.some((re) => re.test(a))) return true;
    const keyword = q.transcribedStem?.match(/\*\*([^*]+)\*\*/)?.[1] ?? "";
    if (/'s\s/.test(keyword) && NOMINAL_SUFFIX.test(a)) return true;
    return false;
  });

  // Reported speech: the source contains a quoted sentence in "..." AND the
  // answer uses reporting verbs (asked / told / said) + "that" / "if".
  const REPORTED_STEM = /"[^"]+\?"|"[^"]+\."/;
  const REPORTED_ANS = /\b(?:asked|told|said|wanted to know|wondered)\b[^.]*\b(?:that|if|whether)\b/i;
  const reported = synthesis.filter((q) => {
    const stem = q.transcribedStem ?? "";
    const ans = q.answer ?? "";
    return REPORTED_STEM.test(stem) && REPORTED_ANS.test(ans);
  });

  function printCategory(label: string, items: typeof synthesis) {
    console.log(`\n============================================================`);
    console.log(`${label} — ${items.length} question(s)`);
    console.log(`============================================================`);
    for (const q of items) {
      const p = paperById.get(q.examPaperId);
      const keyword = q.transcribedStem?.match(/\*\*([^*]+)\*\*/)?.[1] ?? "";
      console.log("──────────────────────────────────────────────");
      console.log(`Paper:   ${p?.title ?? "?"}  ·  ${p?.school ?? "?"}  ·  ${p?.year ?? ""}  ·  ${p?.examType ?? ""}`);
      console.log(`Q${q.questionNum}   keyword: **${keyword}**`);
      console.log(`Source:  ${q.transcribedStem?.replace(/\s+/g, " ").trim()}`);
      console.log(`Answer:  ${q.answer?.replace(/\s+/g, " ").trim()}`);
    }
  }

  printCategory("NOUN-FORM TRANSFORMATION", nounForm);
  printCategory("REPORTED / INDIRECT SPEECH", reported);
}

main().finally(() => prisma.$disconnect());
