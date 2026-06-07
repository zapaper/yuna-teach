// PSLE Chinese 2016-2025 — repeats + wordlist coverage analysis (v2).
//
// v2 fix: previously only counted (a) the correct-option text, and (b) words
// surrounded by __underline__ markup in the stem. That MISSED Q7-Q8 idiom-
// meaning questions where the idiom sits inline in the stem and the 4 options
// are short DEFINITIONS. Now: scan every stem AND every option for known
// words from the bank (2/3/4+ char dictionary lookup), plus pull explicit
// correct-option text + underlined stem markup as before. Each "tested
// word" is tagged with WHERE it came from so we can sanity-check.

import * as fs from "fs";
import * as path from "path";
import { prisma } from "../src/lib/db";

type BankEntry = {
  word: string;
  chars: number;
  category: string;
  source: "PSLE" | "P4" | "P5" | "P6" | "P4+P5" | "P5+P6" | string;
};

const PAPER_IDS: Array<{ year: number; id: string }> = [
  { year: 2016, id: "cmphqli6g002b98jke0olegzj" },
  { year: 2017, id: "cmphphlfd0001ivva0cvmq0du" },
  { year: 2018, id: "cmphqacp9000198jkrd6ambui" },
  { year: 2019, id: "cmparuwvl0001e4lryp826f9w" },
  { year: 2020, id: "cmpexr14i0001zmvgavm7u3k5" },
  { year: 2021, id: "cmp9tqp7r004p11pg1emv5dty" },
  { year: 2022, id: "cmp9muf3q00038gvnb269c3ht" },
  { year: 2023, id: "cmp9msmx800018gvnz0suifzq" },
  { year: 2024, id: "cmp9e8vzc0001ug93w4cq50y1" },
  { year: 2025, id: "cmphn6npc000112g1sdstau5j" },
];

const clean = (s: string): string => s.replace(/\*+|_+/g, "").trim();

(async () => {
  const bankPath = path.join(__dirname, "psle-chinese-study-bank.json");
  const bank = JSON.parse(fs.readFileSync(bankPath, "utf8")) as BankEntry[];

  const wordlistP4P6 = new Set<string>();
  const allBankWords = new Set<string>();
  for (const e of bank) {
    allBankWords.add(e.word);
    if (e.source !== "PSLE") wordlistP4P6.add(e.word);
  }

  // Dictionary by length — 1-char excluded (too noisy)
  const dict2 = [...allBankWords].filter(w => w.length === 2);
  const dict3 = [...allBankWords].filter(w => w.length === 3);
  const dict4plus = [...allBankWords].filter(w => w.length >= 4);
  console.log(`Bank: ${allBankWords.size} entries (${dict2.length} 2-char, ${dict3.length} 3-char, ${dict4plus.length} 4+char)`);
  console.log(`P4-P6 wordlist (excludes PSLE-source): ${wordlistP4P6.size} entries\n`);

  // Scan a text for ANY known dict word, return the hits.
  // Word-length priority high→low so a 4-char idiom isn't shadowed
  // by its constituent 2-char substring.
  function scanForKnownWords(text: string): Set<string> {
    const hits = new Set<string>();
    if (!text) return hits;
    const t = clean(text);
    for (const w of dict4plus) if (t.includes(w)) hits.add(w);
    for (const w of dict3) if (t.includes(w)) hits.add(w);
    for (const w of dict2) if (t.includes(w)) hits.add(w);
    return hits;
  }

  // wordSources[word] = Map<year, Set<role>>
  // role: "correctOpt" | "stem" | "option" | "stemUnderline"
  type Role = "correctOpt" | "stem" | "option" | "stemUnderline";
  const wordYearRoles = new Map<string, Map<number, Set<Role>>>();
  const note = (word: string, year: number, role: Role) => {
    let years = wordYearRoles.get(word);
    if (!years) { years = new Map(); wordYearRoles.set(word, years); }
    let roles = years.get(year);
    if (!roles) { roles = new Set(); years.set(year, roles); }
    roles.add(role);
  };

  let totalQs = 0;
  for (const { year, id } of PAPER_IDS) {
    const paper = await prisma.examPaper.findUnique({
      where: { id },
      select: {
        questions: {
          select: { questionNum: true, syllabusTopic: true, answer: true, transcribedStem: true, transcribedOptions: true },
          orderBy: { orderIndex: "asc" },
        },
      },
    });
    if (!paper) continue;

    for (const q of paper.questions) {
      const topic = q.syllabusTopic ?? "";
      if (!topic.includes("语文应用") && !topic.includes("短文填空")) continue;
      const opts = q.transcribedOptions as string[] | null;
      if (!Array.isArray(opts) || opts.length !== 4) continue;
      totalQs++;

      // a. Correct option text — if it's a SHORT word (≤6 chars), it's the tested vocab
      const ansMatch = q.answer?.match(/[1-4]/);
      const idx = ansMatch ? parseInt(ansMatch[0], 10) - 1 : -1;
      const correct = idx >= 0 ? clean(opts[idx]) : "";
      if (correct && correct.length <= 6) note(correct, year, "correctOpt");

      // b. Underlined stem markup
      const stem = q.transcribedStem ?? "";
      const undMatches = stem.matchAll(/_+([^_]+)_+/g);
      for (const m of undMatches) {
        const w = clean(m[1]);
        if (w && w.length <= 6) note(w, year, "stemUnderline");
      }

      // c. Scan stem AND options for any known dict word (NEW — catches
      //    Q7-Q8 idiom-meaning questions where idiom is in the stem but
      //    not underlined, and where the 4 options are definitions).
      for (const hit of scanForKnownWords(stem)) note(hit, year, "stem");
      for (const opt of opts) {
        for (const hit of scanForKnownWords(opt)) note(hit, year, "option");
      }
    }
  }

  console.log(`Processed ${totalQs} vocab MCQ questions across ${PAPER_IDS.length} papers.\n`);

  // ───────────────────────────────────────────────────────────────
  // (a) How much PSLE vocab is in our wordlist?
  // ───────────────────────────────────────────────────────────────
  const allPsleWords = [...wordYearRoles.keys()];
  const inWordlist = allPsleWords.filter(w => wordlistP4P6.has(w));
  const inBank = allPsleWords.filter(w => allBankWords.has(w));
  // Words that came from CORRECT option / underlined stem (these are
  // the "tested word" with high confidence). Words that only came from
  // scanForKnownWords might be passing distractor mentions.
  const highConfWords = allPsleWords.filter(w => {
    for (const roles of wordYearRoles.get(w)!.values()) {
      if (roles.has("correctOpt") || roles.has("stemUnderline")) return true;
    }
    return false;
  });
  const highConfInList = highConfWords.filter(w => wordlistP4P6.has(w));

  console.log(`=== Vocab coverage ===`);
  console.log(`Total distinct words seen in PSLE 2016-2025 (any role): ${allPsleWords.size}`);
  console.log(`  → in our P4-P6 wordlist (944): ${inWordlist.length} (${(inWordlist.length / allPsleWords.size * 100).toFixed(1)}%)`);
  console.log(`  → in our bank (1067 incl. PSLE-source entries): ${inBank.length} (${(inBank.length / allPsleWords.size * 100).toFixed(1)}%)`);
  console.log(``);
  console.log(`High-confidence tested words (correct option or underlined stem): ${highConfWords.length}`);
  console.log(`  → in P4-P6 wordlist: ${highConfInList.length} (${(highConfInList.length / highConfWords.length * 100).toFixed(1)}%)`);

  // ───────────────────────────────────────────────────────────────
  // (b) Repeats across years
  // ───────────────────────────────────────────────────────────────
  const repeatedAny = allPsleWords
    .filter(w => wordYearRoles.get(w)!.size > 1)
    .map(w => ({ word: w, years: [...wordYearRoles.get(w)!.keys()].sort() }))
    .sort((a, b) => b.years.length - a.years.length);

  // Repeats among high-confidence tested words only
  const highConfYearMap = new Map<string, Set<number>>();
  for (const w of highConfWords) {
    const years = new Set<number>();
    for (const [year, roles] of wordYearRoles.get(w)!.entries()) {
      if (roles.has("correctOpt") || roles.has("stemUnderline")) years.add(year);
    }
    highConfYearMap.set(w, years);
  }
  const highConfRepeats = highConfWords
    .filter(w => highConfYearMap.get(w)!.size > 1)
    .map(w => ({ word: w, years: [...highConfYearMap.get(w)!].sort() }))
    .sort((a, b) => b.years.length - a.years.length);

  console.log(``);
  console.log(`=== Repeats across years ===`);
  console.log(`Words appearing in 2+ years (ANY role, incl. distractor mention): ${repeatedAny.length} of ${allPsleWords.length} (${(repeatedAny.length / allPsleWords.length * 100).toFixed(1)}%)`);
  console.log(`Words tested-as-correct or stem-underlined in 2+ years: ${highConfRepeats.length} of ${highConfWords.length} (${(highConfRepeats.length / highConfWords.length * 100).toFixed(1)}%)`);
  console.log(``);
  console.log(`Top ANY-role repeats (incl. distractor):`);
  for (const { word, years } of repeatedAny.slice(0, 25)) {
    console.log(`  ${word}  (${years.length} years: ${years.join(", ")})`);
  }
  console.log(``);
  console.log(`Top high-confidence repeats (correct answer or underlined tested word):`);
  for (const { word, years } of highConfRepeats.slice(0, 25)) {
    console.log(`  ${word}  (${years.length} years: ${years.join(", ")})`);
  }

  // Per-year counts
  console.log(``);
  console.log(`=== Per-year vocab activity ===`);
  for (const { year } of PAPER_IDS) {
    let nWords = 0, nInList = 0;
    for (const [w, years] of wordYearRoles) {
      if (years.has(year)) { nWords++; if (wordlistP4P6.has(w)) nInList++; }
    }
    console.log(`  ${year}: ${nWords} distinct words seen, ${nInList} in wordlist (${(nInList / Math.max(nWords, 1) * 100).toFixed(0)}%)`);
  }

  // Write markdown report
  const outPath = path.join(__dirname, "..", "..", "documents", "PSLE Chinese 2016-2025 vocab analysis.md");
  const out: string[] = [];
  out.push(`# PSLE Chinese 2016-2025 — Vocab Analysis (v2)\n`);
  out.push(`Methodology v2: scans stems AND options against our dictionary (1067 words), not just the correct-option text. Catches Q7-Q8 idiom-meaning questions where the idiom is in the stem and the options are definitions.\n`);

  out.push(`## 1. How much PSLE vocab is in our wordlist?\n`);
  out.push(`| | Count | % of seen |`);
  out.push(`| --- | ---: | ---: |`);
  out.push(`| Distinct words PSLE 2016-2025 touched | **${allPsleWords.size}** | 100% |`);
  out.push(`| Of those, in P4-P6 wordlist (944 entries) | **${inWordlist.length}** | ${(inWordlist.length / allPsleWords.size * 100).toFixed(1)}% |`);
  out.push(`| Of those, in full bank (1067 incl. PSLE-only) | ${inBank.length} | ${(inBank.length / allPsleWords.size * 100).toFixed(1)}% |\n`);
  out.push(`Restricted to high-confidence tested words (correct answer or underlined in stem):\n`);
  out.push(`- Total: **${highConfWords.length}**`);
  out.push(`- In P4-P6 wordlist: **${highConfInList.length}** (${(highConfInList.length / highConfWords.length * 100).toFixed(1)}%)\n`);

  out.push(`## 2. How much vocab repeats across years?\n`);
  out.push(`| | Repeated (2+ yrs) | Total seen | Rate |`);
  out.push(`| --- | ---: | ---: | ---: |`);
  out.push(`| Any role (incl. distractor mentions) | **${repeatedAny.length}** | ${allPsleWords.length} | ${(repeatedAny.length / allPsleWords.length * 100).toFixed(1)}% |`);
  out.push(`| Correct answer or underlined tested | **${highConfRepeats.length}** | ${highConfWords.length} | ${(highConfRepeats.length / highConfWords.length * 100).toFixed(1)}% |\n`);

  out.push(`### All repeats (any role)\n`);
  out.push(`| Word | # years | Years |`);
  out.push(`| --- | ---: | --- |`);
  for (const { word, years } of repeatedAny) {
    out.push(`| ${word} | ${years.length} | ${years.join(", ")} |`);
  }
  out.push(``);

  out.push(`### High-confidence repeats (correct answer or underlined stem)\n`);
  out.push(`| Word | # years | Years |`);
  out.push(`| --- | ---: | --- |`);
  for (const { word, years } of highConfRepeats) {
    out.push(`| ${word} | ${years.length} | ${years.join(", ")} |`);
  }

  fs.writeFileSync(outPath, out.join("\n"), "utf8");
  console.log(`\nReport → ${outPath}`);
  await prisma.$disconnect();
})();
