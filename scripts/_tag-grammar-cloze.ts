// Tag PSLE Grammar Cloze questions with sub-topics. Grammar Cloze
// is a word-bank cloze: each question's answer is a letter (A–Q,
// skipping I and O) referring to a word in the section's printed
// bank. We:
//   1. Pull the section's sectionOcrTexts (contains the bank +
//      passage) from paper.metadata.
//   2. Parse the bank: extract LETTER → WORD pairs. The bank is
//      typically printed as a markdown table or labelled list.
//   3. For each question, sub the answer letter for its bank word.
//   4. Classify the word against the 7-bucket Grammar MCQ taxonomy
//      (same one used for the MCQ format). Rule path uses the same
//      PREPS / PRONOUNS / CONNECTORS / SVA / QUANT vocab tables;
//      AI fallback for ambiguous cases.
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

// Vocab tables — same shape as classify-grammar.ts but used directly
// on single words from the bank rather than 4 options.
const PREPS = new Set([
  "in","on","at","of","to","for","with","by","into","onto","upon","over","under",
  "through","between","among","amid","around","about","across","along","against",
  "beyond","beside","besides","behind","below","above","after","before","during",
  "via","off","out","towards","toward","up","down","near","from",
]);
const CONNECTORS = new Set([
  "and","or","but","nor","yet","so","if","when","while","whereas","since","because",
  "although","though","unless","until","whether","once","as","than","whenever",
  "however","therefore","moreover","furthermore","nevertheless","besides","instead",
  "meanwhile","otherwise","also","still","then","whereby","thereby",
]);
const PRONOUNS = new Set([
  "he","she","it","we","they","you","i","him","her","his","hers","its","ours","theirs","mine","yours",
  "himself","herself","itself","themselves","ourselves","yourself","myself",
  "who","whom","whose","which","that","these","those","my","your","our","their",
]);
const SVA_VERBS = new Set(["is","are","was","were","has","have","am","do","does","did"]);
const QUANTIFIERS = new Set([
  "few","little","many","much","several","each","some","any","enough","none","all","most","fewer","less",
]);
const IDIOMATIC_PREP_PHRASES = new Set([
  "in spite of","by means of","on account of","with regard to","due to","because of",
  "in order to","so that","as soon as",
]);

function classifyWord(word: string): GrammarSubTopic | null {
  if (!word) return null;
  const w = word.toLowerCase().trim().replace(/[.,;:?!()"']/g, "");
  if (!w) return null;
  if (IDIOMATIC_PREP_PHRASES.has(w)) return "idiomatic-prepositions";
  if (PREPS.has(w)) return "idiomatic-prepositions";
  if (CONNECTORS.has(w)) return "connectors-tenses";
  if (PRONOUNS.has(w)) return "pronouns";
  if (SVA_VERBS.has(w)) return "subject-verb-agreement";
  if (QUANTIFIERS.has(w)) return "countable/uncountable";
  // Anything else (verb form, content word) — verb-forms catch-all.
  return "verb-forms";
}

// Parse the word bank from a section OCR blob. The bank usually
// appears at the TOP of the section as either:
//   · markdown table:    | A | the | B | very | C | of | …
//   · labelled list:     (A) the   (B) very   (C) of
//   · paired lines:      A. the    B. very    C. of
// Extract LETTER → WORD pairs (PSLE uses A–Q, skipping I and O).
const BANK_LETTERS = ["A","B","C","D","E","F","G","H","J","K","L","M","N","P","Q","R","S","T","U","V","W"];
function parseBank(ocrText: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!ocrText) return map;
  // Pull pairs like "(A) word" / "A. word" / "| A | word |" / "A) word"
  // Match a letter (single-cap) followed by . ) : or pipe, then the
  // word. Stop at the next letter or end-of-string.
  const re = /(?:[(\|]|\b)([A-W])(?:\s*[).:|\-—]\s*|\s+)([A-Za-z][A-Za-z'-]+(?:\s+[A-Za-z][A-Za-z'-]+){0,2}?)(?=\s*(?:[(\|]|\b[A-W]\s*[).:|\-—\s]|$|[\.\n]))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ocrText)) !== null) {
    const letter = m[1].toUpperCase();
    if (!BANK_LETTERS.includes(letter)) continue;
    const word = m[2].trim();
    if (!map.has(letter)) map.set(letter, word);
  }
  return map;
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
    select: { id: true, transcribedStem: true, answer: true, examPaperId: true },
  });
  console.log(`Candidates (PSLE master Grammar Cloze, untagged): ${candidates.length}\n`);

  // Cache bank-per-paper so we parse each paper's bank once.
  const bankByPaper = new Map<string, Map<string, string>>();
  async function bankFor(paperId: string): Promise<Map<string, string>> {
    const cached = bankByPaper.get(paperId);
    if (cached) return cached;
    const paper = await prisma.examPaper.findUnique({ where: { id: paperId }, select: { metadata: true } });
    // sectionOcrTexts is a map { sectionLabel: string }. We don't
    // know which section is the Grammar Cloze — concatenate all and
    // let the regex pull pairs. The PSLE format prints the bank
    // ONCE at the top of the Grammar Cloze section, so noise from
    // other sections is unlikely to collide.
    const meta = (paper?.metadata ?? {}) as { sectionOcrTexts?: Record<string, string> };
    const blob = Object.values(meta.sectionOcrTexts ?? {}).join("\n");
    const map = parseBank(blob);
    bankByPaper.set(paperId, map);
    return map;
  }

  const assignments = new Map<string, GrammarSubTopic | null>();
  let ruleHits = 0;
  let aiHits = 0;
  let bankMisses = 0;
  for (const q of candidates) {
    const bank = await bankFor(q.examPaperId);
    const letter = (q.answer ?? "").trim().replace(/[^A-Z]/g, "")[0]?.toUpperCase();
    const word = letter ? bank.get(letter) : undefined;
    if (!word) { bankMisses++; assignments.set(q.id, null); continue; }
    const r = classifyWord(word);
    if (r === null || r === "verb-forms") {
      // verb-forms is the catch-all → try AI for a more specific tag.
      const stem = (q.transcribedStem ?? "").replace(/\s+/g, " ").trim() || word;
      try {
        const ai = await aiClassifyWord(word, stem);
        assignments.set(q.id, ai ?? r);
        aiHits++;
      } catch {
        assignments.set(q.id, r);
      }
    } else {
      assignments.set(q.id, r);
      ruleHits++;
    }
  }
  console.log(`  Rule hits: ${ruleHits}  ·  AI fallbacks: ${aiHits}  ·  Bank-miss (no letter→word): ${bankMisses}\n`);

  const counts: Record<string, number> = {};
  for (const v of assignments.values()) counts[v ?? "(null)"] = (counts[v ?? "(null)"] ?? 0) + 1;
  console.log("Distribution:");
  for (const [k, c] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${(c + "").padStart(4)}  ${k}`);
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
