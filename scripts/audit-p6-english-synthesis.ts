// Pull English P6 synthesis questions + answers from the DB and cluster
// them by the grammar rule being tested. Classification is heuristic
// (looks for trigger words/phrases in the prompt keyword).
//
// Run: npx tsx scripts/audit-p6-english-synthesis.ts

import { prisma } from "@/lib/db";

type Rule = {
  key: string;
  label: string;
  // Match on the original stem / keyword / answer when any of these regexes fire.
  match: RegExp[];
};

// Singapore PSLE Synthesis & Transformation common grammar points.
const RULES: Rule[] = [
  { key: "reported-speech", label: "Reported / Indirect speech", match: [
    /\breported speech\b/i, /\bindirect speech\b/i,
    /\basked (?:her|him|me|them)\b/i, /\btold (?:her|him|me|them)\b/i,
    /\bsaid that\b/i, /\b(?:denied|admitted|suggested|warned|promised|threatened) (?:that|to)\b/i,
  ]},
  { key: "passive", label: "Active ↔ Passive voice", match: [
    /\bpassive\b/i, /\b(?:was|were|is|are|been|being) [a-z]+(?:ed|en) by\b/i,
  ]},
  { key: "if-unless", label: "If / Unless conditional", match: [
    /\bunless\b/i, /^If /i, /\bprovided that\b/i, /\bas long as\b/i,
  ]},
  { key: "although-despite", label: "Although / Despite (concession)", match: [
    /\balthough\b/i, /\beven though\b/i, /\bdespite\b/i, /\bin spite of\b/i,
  ]},
  { key: "so-that-such-that", label: "So … that / Such … that", match: [
    /\bso [a-z]+ that\b/i, /\bsuch [a-z]+ (?:a|an)? ?[a-z]* that\b/i,
  ]},
  { key: "too-to", label: "Too … to / Not … enough to", match: [
    /\btoo [a-z]+ to\b/i, /\bnot [a-z]+ enough to\b/i, /\benough to\b/i,
  ]},
  { key: "relative-clause", label: "Relative clause (who / which / whose / that)", match: [
    /\brelative (?:clause|pronoun)\b/i,
    /,? which\b/i, /,? who(?:se|m)?\b/i,
  ]},
  { key: "inversion-neither-nor", label: "Neither / Nor / Either (inversion)", match: [
    /\bneither\b/i, /\bnor\b/i, /\beither\b/i,
  ]},
  { key: "not-only", label: "Not only … but also", match: [
    /\bnot only\b/i, /\bbut also\b/i,
  ]},
  { key: "comparative-superlative", label: "Comparative / Superlative", match: [
    /\b(?:more|less) [a-z]+ than\b/i, /\bas [a-z]+ as\b/i,
    /\bthe (?:most|least|[a-z]+est) [a-z]+\b/i,
  ]},
  { key: "because-so", label: "Because / So (cause & effect)", match: [
    /^Because\b/i, /, so\b/i, /\bas a result\b/i, /\bconsequently\b/i,
  ]},
  { key: "when-while-before-after", label: "Time conjunction (when / while / before / after)", match: [
    /\bwhile\b/i, /\bwhen\b/i, /\bbefore\b/i, /\bafter\b/i, /\bas soon as\b/i,
  ]},
  { key: "gerund-infinitive", label: "Gerund / Infinitive (verb + ing / to + verb)", match: [
    /\b(?:stopped|started|enjoyed|avoided|finished|considered) [a-z]+ing\b/i,
    /\b(?:wanted|decided|hoped|planned|promised|refused) to [a-z]+\b/i,
  ]},
  { key: "question-tag", label: "Question tags", match: [
    /, (?:is|are|was|were|do|does|did|have|has|had|will|would|can|could|should) (?:not )?(?:it|he|she|they|we|you|I)\?/i,
  ]},
  { key: "despite-noun", label: "Despite / In spite of + noun phrase", match: [
    /\bdespite the\b/i, /\bin spite of the\b/i,
  ]},
];

function classify(text: string): string[] {
  const hits: string[] = [];
  for (const r of RULES) {
    if (r.match.some((re) => re.test(text))) hits.push(r.key);
  }
  return hits;
}

async function main() {
  // English P6 master papers.
  const papers = await prisma.examPaper.findMany({
    where: {
      subject: { contains: "English", mode: "insensitive" },
      level: { in: ["Primary 6", "P6"] },
      paperType: null,
      sourceExamId: null,
      NOT: { title: { startsWith: "[Synthetic Bank]" } },
    },
    select: { id: true, title: true, school: true, examType: true },
  });
  console.log(`P6 English master papers: ${papers.length}`);

  const paperIds = papers.map((p) => p.id);
  const all = await prisma.examQuestion.findMany({
    where: {
      examPaperId: { in: paperIds },
      transcribedStem: { not: null },
    },
    select: {
      id: true,
      questionNum: true,
      transcribedStem: true,
      answer: true,
      syllabusTopic: true,
      examPaperId: true,
    },
  });
  console.log(`Total transcribed questions in P6 English: ${all.length}`);

  // Heuristic: synthesis questions usually have a **keyword** in the stem
  // AND a non-MCQ answer (full sentence). Grammar/Vocab MCQ don't have
  // **markers**. So filter for stems containing a bold-wrapped keyword.
  const synthesis = all.filter((q) => /\*\*[^*]+\*\*/.test(q.transcribedStem ?? ""));
  console.log(`Likely synthesis questions: ${synthesis.length}`);

  // Classify each.
  const byRule = new Map<string, typeof synthesis>();
  for (const q of synthesis) {
    const hay = `${q.transcribedStem ?? ""}\n${q.answer ?? ""}`;
    const hits = classify(hay);
    const labels = hits.length > 0 ? hits : ["other"];
    for (const k of labels) {
      if (!byRule.has(k)) byRule.set(k, []);
      byRule.get(k)!.push(q);
    }
  }

  // Print summary sorted by frequency.
  console.log("\n=== Common grammar rules tested ===");
  const ruleLookup = new Map(RULES.map((r) => [r.key, r.label] as const));
  const sorted = [...byRule.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [key, qs] of sorted) {
    const label = ruleLookup.get(key) ?? "Other / unclassified";
    console.log(`\n— ${label} (${key})  ·  ${qs.length} question(s)`);
    for (const q of qs.slice(0, 3)) {
      console.log(`    Q${q.questionNum}  ${q.transcribedStem?.slice(0, 130).replace(/\s+/g, " ")}`);
      if (q.answer) console.log(`      → ${q.answer.slice(0, 130).replace(/\s+/g, " ")}`);
    }
  }

  // Dump ALL unclassified synthesis stems + keywords for manual review.
  const unclassified = byRule.get("other") ?? [];
  if (unclassified.length > 0) {
    console.log(`\n\n=== ALL unclassified (${unclassified.length}) — keyword + full stem ===`);
    for (const q of unclassified) {
      const kw = q.transcribedStem?.match(/\*\*([^*]+)\*\*/)?.[1] ?? "?";
      console.log(`\n[kw: "${kw}"]  Q${q.questionNum}`);
      console.log(`  stem: ${q.transcribedStem?.slice(0, 220).replace(/\s+/g, " ")}`);
      if (q.answer) console.log(`  ans:  ${q.answer.slice(0, 220).replace(/\s+/g, " ")}`);
    }
  }
}

main().finally(() => prisma.$disconnect());
