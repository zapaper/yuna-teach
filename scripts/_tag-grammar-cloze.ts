// Tag PSLE Grammar Cloze questions with sub-topics by substituting
// the answer letter (A–Q, skipping I and O) for its word from the
// section's printed bank.
//
// PSLE master papers store the bank inside
// metadata.englishSections[i].passage as a 6-row markdown table at
// the TOP of the passage:
//   | A | B | C | D | E |
//   | across | after | also | and | around |
//   | F | G | H | J | K |
//   | as | before | each | for | in |
//   | L | M | N | P | Q |
//   | into | our | the | these | under |
//
// We map each question's orderIndex into the matching section
// (startIndex..endIndex), parse the bank from that section's passage,
// look up the answer letter, and classify the word against the
// 7-bucket Grammar MCQ taxonomy.
//
// Dry-run by default. Pass --apply to commit.

import { prisma } from "@/lib/db";
import { GoogleGenAI } from "@google/genai";
import type { GrammarSubTopic } from "@/lib/master-class/classify-grammar";

const VALID: GrammarSubTopic[] = [
  "tag-questions",
  "subject-verb-agreement",
  "countable/uncountable",
  "pronouns",
  "verb-forms",
  "connectors-tenses",
  "idiomatic-prepositions",
];

const PREPS = new Set([
  "in","on","at","of","to","for","with","by","into","onto","upon","over","under",
  "through","between","among","amid","around","about","across","along","against",
  "beyond","beside","besides","behind","below","above","after","before","during",
  "via","off","out","towards","toward","up","down","near","from","like",
]);
const CONNECTORS = new Set([
  "and","or","but","nor","yet","so","if","when","while","whereas","since","because",
  "although","though","unless","until","whether","once","as","than","whenever","where",
  "however","therefore","moreover","furthermore","nevertheless","besides","instead",
  "meanwhile","otherwise","also","still","then","whereby","thereby","that","not","only",
]);
const PRONOUNS = new Set([
  "he","she","it","we","they","you","i","him","her","his","hers","its","ours","theirs","mine","yours",
  "himself","herself","itself","themselves","ourselves","yourself","myself",
  "who","whom","whose","which","these","those","my","your","our","their","each",
]);
const SVA_VERBS = new Set(["is","are","was","were","has","have","am","do","does","did","be","been","being","had"]);
const QUANTIFIERS = new Set([
  "few","little","many","much","several","each","some","any","enough","none","all","most","fewer","less",
]);
const TENSE_AUX = new Set(["will","would","shall","should","can","could","may","might","must"]);
const IDIOMATIC_PREP_PHRASES = new Set([
  "in spite of","by means of","on account of","with regard to","due to","because of",
  "in order to","so that","as soon as",
]);

function classifyWord(word: string): GrammarSubTopic | null {
  if (!word) return null;
  const w = word.toLowerCase().trim().replace(/[.,;:?!()"']/g, "");
  if (!w) return null;
  if (IDIOMATIC_PREP_PHRASES.has(w)) return "idiomatic-prepositions";
  if (PRONOUNS.has(w)) return "pronouns";
  if (SVA_VERBS.has(w)) return "subject-verb-agreement";
  if (QUANTIFIERS.has(w)) return "countable/uncountable";
  if (CONNECTORS.has(w)) return "connectors-tenses";
  if (TENSE_AUX.has(w)) return "connectors-tenses";
  if (PREPS.has(w)) return "idiomatic-prepositions";
  // Anything else is likely a content word (verb form, noun, adj).
  return "verb-forms";
}

// Parse the bank from a passage. Two table shapes occur:
//   Shape 1 — letters row + words row, repeated 3 times for A–Q:
//     | A | B | C | D | E |
//     | across | after | also | and | around |
//   Shape 2 — interleaved (LETTER) word cells in 3 rows × 10 cells:
//     | (A) | are | (D) | but | (G) | most | (K) | was | (N) | where |
//     | (B) | as | (E) | however | (H) | off | (L) | were | (P) | which |
// Also Shape 2 sometimes drops the parens (just "A | are | D | but").
const BANK_LETTERS = new Set(["A","B","C","D","E","F","G","H","J","K","L","M","N","P","Q","R","S","T","U","V","W"]);
function parseBank(passage: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!passage) return out;
  const lines = passage.split(/\r?\n/);
  const tableRows: string[][] = [];
  let inTable = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || !line.startsWith("|")) {
      if (inTable && tableRows.length >= 2) break; // bank is always at top
      continue;
    }
    if (/^\|\s*-+/.test(line)) { inTable = true; continue; }
    const parts = line.split("|").map(s => s.trim()).filter(s => s.length > 0);
    if (parts.length === 0) continue;
    tableRows.push(parts);
    inTable = true;
  }
  // Strip parens from any cell.
  const stripParen = (c: string) => c.replace(/^\(([A-Z])\)$/, "$1");
  const isLetter = (c: string) => {
    const s = stripParen(c).toUpperCase();
    return s.length === 1 && BANK_LETTERS.has(s);
  };
  // Shape 2: interleaved letter, word, letter, word, ... in each row.
  // For each row, check if even-index cells are all letters.
  let interleavedHits = 0;
  for (const row of tableRows) {
    if (row.length < 4 || row.length % 2 !== 0) continue;
    const lettersAtEven = row.every((c, i) => i % 2 === 1 || isLetter(c));
    if (!lettersAtEven) continue;
    for (let i = 0; i + 1 < row.length; i += 2) {
      const L = stripParen(row[i]).toUpperCase();
      const w = row[i + 1];
      if (!BANK_LETTERS.has(L)) continue;
      if (!/^[A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]+)*$/.test(w)) continue;
      if (!out.has(L)) out.set(L, w);
    }
    interleavedHits++;
  }
  if (interleavedHits > 0 && out.size >= 10) return out;
  // Shape 1 fallback: alternating letter-row / word-row.
  for (let r = 0; r + 1 < tableRows.length; r++) {
    const letters = tableRows[r];
    if (letters.length < 4 || !letters.every(isLetter)) continue;
    const words = tableRows[r + 1];
    if (words.length !== letters.length) continue;
    if (!words.every(w => /^[A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]+)*$/.test(w))) continue;
    for (let k = 0; k < letters.length; k++) {
      const L = stripParen(letters[k]).toUpperCase();
      if (!BANK_LETTERS.has(L)) continue;
      if (!out.has(L)) out.set(L, words[k]);
    }
  }
  return out;
}

let _ai: GoogleGenAI | null = null;
function getAI() { if (_ai) return _ai; _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! }); return _ai; }

async function aiClassifyWord(word: string, contextSentence: string): Promise<GrammarSubTopic | null> {
  const ai = getAI();
  const prompt = `Tag the function of the word "${word}" in this PSLE Grammar Cloze passage sentence.

Sentence: ${contextSentence}

Pick exactly ONE sub-topic:
- subject-verb-agreement: is/are/has/have where the form is forced by the subject's number.
- countable/uncountable: much/many/few/little/fewer/less for countable vs uncountable nouns.
- pronouns: he/she/it/his/her/whom/which etc. — referring back to an antecedent.
- verb-forms: gerund / infinitive / participle / causative.
- connectors-tenses: when/because/while/before/after/although/since/until and tense-marker contexts.
- tag-questions: rarely in cloze format — tag-question structure (isn't he? shall we?).
- idiomatic-prepositions: verb+prep or noun+prep collocations.

Return ONLY the sub-topic id on a single line.`;
  const resp = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: prompt, config: { temperature: 0.1 } });
  const text = (resp.text ?? "").trim().replace(/[`"]/g, "").split(/\s/)[0] as GrammarSubTopic;
  if (VALID.includes(text)) return text;
  return null;
}

type Section = { label?: string; passage?: string; startIndex?: number; endIndex?: number };
type PaperBanks = {
  // For full-paper masters: a single bank (from sectionOcrTexts["Grammar Cloze"].ocrText).
  fullPaperBank?: Map<string, string>;
  // For compiled revisions: a list of per-section banks keyed by section index.
  sections?: { startIndex: number; endIndex: number; bank: Map<string, string> }[];
};

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "── APPLY mode ──\n" : "── DRY RUN (pass --apply to commit) ──\n");

  const candidates = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: "Grammar Cloze",
      subTopic: null,
      answer: { not: null },
      examPaper: {
        subject: { equals: "English", mode: "insensitive" },
        sourceExamId: null,
        OR: [{ title: { contains: "PSLE", mode: "insensitive" } }, { level: { contains: "6", mode: "insensitive" } }],
      },
    },
    select: { id: true, transcribedStem: true, answer: true, examPaperId: true, orderIndex: true },
  });
  console.log(`Candidates (PSLE master Grammar Cloze, untagged): ${candidates.length}\n`);

  const paperBanks = new Map<string, PaperBanks>();
  async function loadPaper(paperId: string): Promise<PaperBanks> {
    const cached = paperBanks.get(paperId);
    if (cached) return cached;
    const paper = await prisma.examPaper.findUnique({ where: { id: paperId }, select: { metadata: true } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (paper?.metadata ?? {}) as any;
    const out: PaperBanks = {};
    // Path 1: full paper (PSLE 2014–2025, prelim) → sectionOcrTexts["Grammar Cloze"].ocrText
    const gc = meta?.sectionOcrTexts?.["Grammar Cloze"];
    const ocrText: string | undefined = typeof gc === "string" ? gc : gc?.ocrText;
    if (typeof ocrText === "string" && ocrText.length > 0) {
      const bank = parseBank(ocrText);
      if (bank.size > 0) out.fullPaperBank = bank;
    }
    // Path 2: compiled revision → englishSections[i].passage scoped by startIndex/endIndex
    const secs: Section[] = Array.isArray(meta?.englishSections) ? meta.englishSections : [];
    const sectionBanks: PaperBanks["sections"] = [];
    for (const s of secs) {
      if (s.startIndex === undefined || s.endIndex === undefined) continue;
      const bank = parseBank(s.passage);
      if (bank.size > 0) sectionBanks.push({ startIndex: s.startIndex, endIndex: s.endIndex, bank });
    }
    if (sectionBanks.length > 0) out.sections = sectionBanks;
    paperBanks.set(paperId, out);
    return out;
  }

  function bankForQ(banks: PaperBanks, orderIndex: number): Map<string, string> | null {
    if (banks.sections) {
      for (const s of banks.sections) {
        if (orderIndex >= s.startIndex && orderIndex <= s.endIndex) return s.bank;
      }
    }
    if (banks.fullPaperBank) return banks.fullPaperBank;
    return null;
  }

  const assignments = new Map<string, GrammarSubTopic | null>();
  let ruleHits = 0;
  let aiHits = 0;
  let bankMisses = 0;
  let letterMisses = 0;
  const sampleByBucket: Record<string, string[]> = {};
  const noBankByPaper = new Map<string, number>();
  const letterMissByPaper = new Map<string, { letter: string | undefined; qNum: number }[]>();

  // Also need the questionNum for diagnostics
  const qNumById = new Map<string, number>();
  {
    const qs = await prisma.examQuestion.findMany({
      where: { id: { in: candidates.map(c => c.id) } },
      select: { id: true, questionNum: true },
    });
    for (const q of qs) qNumById.set(q.id, q.questionNum);
  }

  for (const q of candidates) {
    const banks = await loadPaper(q.examPaperId);
    const bank = bankForQ(banks, q.orderIndex);
    if (!bank) {
      bankMisses++;
      noBankByPaper.set(q.examPaperId, (noBankByPaper.get(q.examPaperId) ?? 0) + 1);
      assignments.set(q.id, null);
      continue;
    }
    const letter = (q.answer ?? "").trim().replace(/[^A-Za-z]/g, "")[0]?.toUpperCase();
    const word = letter ? bank.get(letter) : undefined;
    if (!word) {
      letterMisses++;
      const arr = letterMissByPaper.get(q.examPaperId) ?? [];
      arr.push({ letter, qNum: qNumById.get(q.id) ?? -1 });
      letterMissByPaper.set(q.examPaperId, arr);
      assignments.set(q.id, null);
      continue;
    }

    let r = classifyWord(word);
    if (r === "verb-forms") {
      const stem = (q.transcribedStem ?? "").replace(/\s+/g, " ").trim() || word;
      try {
        const ai = await aiClassifyWord(word, stem);
        if (ai) { r = ai; aiHits++; }
      } catch { /* keep verb-forms */ }
    } else {
      ruleHits++;
    }
    assignments.set(q.id, r);
    const k = r ?? "(null)";
    (sampleByBucket[k] ??= []);
    if (sampleByBucket[k].length < 5) sampleByBucket[k].push(`${letter}=${word}`);
  }
  console.log(`  Rule hits: ${ruleHits}  ·  AI fallbacks: ${aiHits}  ·  No bank: ${bankMisses}  ·  Letter not in bank: ${letterMisses}\n`);

  const counts: Record<string, number> = {};
  for (const v of assignments.values()) counts[v ?? "(null)"] = (counts[v ?? "(null)"] ?? 0) + 1;
  console.log("Distribution:");
  for (const [k, c] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    const samples = (sampleByBucket[k] ?? []).join(", ");
    console.log(`  ${(c + "").padStart(4)}  ${k.padEnd(28)}  e.g. ${samples}`);
  }

  // Detail listing of papers contributing to the misses.
  if (noBankByPaper.size > 0 || letterMissByPaper.size > 0) {
    const allMissPaperIds = new Set([...noBankByPaper.keys(), ...letterMissByPaper.keys()]);
    const papers = await prisma.examPaper.findMany({
      where: { id: { in: [...allMissPaperIds] } },
      select: { id: true, title: true, level: true },
    });
    const pById = new Map(papers.map(p => [p.id, p]));
    console.log("\nPapers needing review (untagged Grammar Cloze Qs):");
    const rows = [...allMissPaperIds].map(id => ({
      id,
      title: pById.get(id)?.title ?? "?",
      level: pById.get(id)?.level ?? "?",
      noBank: noBankByPaper.get(id) ?? 0,
      letterMiss: letterMissByPaper.get(id)?.length ?? 0,
    }));
    rows.sort((a, b) => (b.noBank + b.letterMiss) - (a.noBank + a.letterMiss));
    for (const r of rows) {
      console.log(`  ${(r.noBank + r.letterMiss).toString().padStart(2)} Qs · level=${r.level} · ${r.title}`);
      console.log(`        id=${r.id}  noBank=${r.noBank}  letterMissing=${r.letterMiss}`);
    }
  }

  if (apply) {
    let written = 0;
    for (const [id, v] of assignments) {
      if (!v) continue;
      await prisma.examQuestion.update({ where: { id }, data: { subTopic: v } });
      written++;
    }
    console.log(`\nWrote ${written} subTopic assignments.`);
  } else {
    console.log("\nPass --apply to write the assignments.");
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
