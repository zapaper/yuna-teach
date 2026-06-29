// Tag PSLE Comprehension Cloze questions with their sub-topic.
// Two-stage classification:
//   1. Rule classifier (classify-comp-cloze.ts) — instant; handles
//      function-word answers via vocab tables (prepositions, pronouns,
//      connectors, SVA verbs).
//   2. AI fallback (Gemini 2.5 Flash) — for the residue where the rule
//      classifier returned null OR returned "content-word" but the
//      stem might warrant a more specific bucket.
//
// Writes examQuestion.subTopic. Dry-run by default; pass --apply to
// commit.

import { prisma } from "@/lib/db";
import { GoogleGenAI } from "@google/genai";
import { classifyCompCloze, type CompClozeSubTopic } from "@/lib/master-class/classify-comp-cloze";

const VALID_SUBTOPICS: CompClozeSubTopic[] = [
  "connector",
  "preposition",
  "pronoun-reference",
  "subject-verb-agreement",
  "content-word",
];

const SUBTOPIC_DESCRIPTIONS: Record<CompClozeSubTopic, string> = {
  connector: "Clause / sentence linking words. Answers like when, because, although, however, so, or, but, while, until, as soon as.",
  preposition: "Verb-preposition or noun-preposition collocations. Answers like in, on, at, of, to, for, with, by, from, against.",
  "pronoun-reference": "A pronoun referring back to an antecedent. Answers like he, she, it, our, their, his, hers, whom, which.",
  "subject-verb-agreement": "Singular/plural verb forms whose form depends on the subject's number. Answers like is, are, has, have, was, were AND the stem has a quantifier subject (each / one of / both / neither, etc.) or existential there.",
  "content-word": "The meaningful word (verb, noun, adjective, adverb) in the blank where meaning has to fit the passage context. Default bucket for anything that isn't a function-word category above.",
};

let _ai: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
  if (_ai) return _ai;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  _ai = new GoogleGenAI({ apiKey });
  return _ai;
}

type QInput = { id: string; stem: string | null; answer: string | null };

async function aiClassifyBatch(batch: QInput[]): Promise<Map<string, CompClozeSubTopic | null>> {
  const ai = getAI();
  const subTopicLines = VALID_SUBTOPICS
    .map(id => `  - id: "${id}"\n    description: ${SUBTOPIC_DESCRIPTIONS[id]}`)
    .join("\n");
  const questionLines = batch
    .map(q => {
      const stem = (q.stem ?? "").trim().slice(0, 600).replace(/\s+/g, " ");
      const ans = (q.answer ?? "").trim().slice(0, 60);
      return `  [${q.id}] stem: ${stem}\n             answer: "${ans}"`;
    })
    .join("\n");
  const prompt = `You are tagging Singapore PSLE English Comprehension Cloze questions with one of 5 sub-topics.

SUB-TOPICS:
${subTopicLines}

QUESTIONS:
${questionLines}

Return ONLY a JSON object mapping each bracket-id (the cuid string) to the chosen sub-topic id, or null if the question doesn't fit any sub-topic. No prose, no markdown. Shape:
{"cmABCDEF": "preposition", "cmGHIJKL": "content-word", ...}`;
  const resp = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: { temperature: 0.1, responseMimeType: "application/json" },
  });
  const text = (resp.text ?? "").trim();
  const out = new Map<string, CompClozeSubTopic | null>();
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    for (const q of batch) {
      const v = obj[q.id];
      if (v === null) out.set(q.id, null);
      else if (typeof v === "string" && VALID_SUBTOPICS.includes(v as CompClozeSubTopic)) {
        out.set(q.id, v as CompClozeSubTopic);
      }
    }
  } catch (e) {
    console.warn(`  AI parse failed: ${(e as Error).message}`);
  }
  return out;
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "── APPLY mode ──\n" : "── DRY RUN (pass --apply to commit) ──\n");

  // PSLE master questions for Comp Cloze, no subTopic yet.
  const candidates = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: "Comprehension Cloze",
      subTopic: null,
      answer: { not: null },
      examPaper: {
        subject: { equals: "English", mode: "insensitive" },
        sourceExamId: null,
        OR: [
          { title: { contains: "PSLE", mode: "insensitive" } },
          { level: { contains: "6", mode: "insensitive" } },
        ],
      },
    },
    select: { id: true, transcribedStem: true, answer: true },
  });
  console.log(`Candidate Comp Cloze questions (PSLE master, untagged): ${candidates.length}`);

  // Stage 1: rule classifier.
  const ruleAssignments = new Map<string, CompClozeSubTopic>();
  const fallbackQueue: QInput[] = [];
  let ruleHits = 0;
  for (const q of candidates) {
    const r = classifyCompCloze(q.transcribedStem, q.answer);
    if (r === null) {
      fallbackQueue.push({ id: q.id, stem: q.transcribedStem, answer: q.answer });
    } else if (r === "content-word") {
      // Content-word is the catch-all bucket — pass to AI for a chance
      // at a more specific assignment, since the rule path picks
      // content-word for any single-word answer not in the vocab
      // tables.
      fallbackQueue.push({ id: q.id, stem: q.transcribedStem, answer: q.answer });
    } else {
      ruleAssignments.set(q.id, r);
      ruleHits++;
    }
  }
  console.log(`  Stage 1 (rules): ${ruleHits} confident hits  ·  ${fallbackQueue.length} for AI fallback`);

  // Stage 2: AI classifier in batches.
  const aiAssignments = new Map<string, CompClozeSubTopic | null>();
  const BATCH = 15;
  for (let i = 0; i < fallbackQueue.length; i += BATCH) {
    const slice = fallbackQueue.slice(i, i + BATCH);
    console.log(`  Stage 2 (AI): batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(fallbackQueue.length / BATCH)} (${slice.length} Qs)`);
    try {
      const part = await aiClassifyBatch(slice);
      for (const [k, v] of part) aiAssignments.set(k, v);
    } catch (e) {
      console.warn(`  AI batch failed, skipping: ${(e as Error).message}`);
    }
  }

  // Histogram + write.
  const counts: Record<string, number> = {};
  const allAssigned = new Map<string, CompClozeSubTopic | null>();
  for (const [k, v] of ruleAssignments) allAssigned.set(k, v);
  for (const [k, v] of aiAssignments) allAssigned.set(k, v);
  for (const [, v] of allAssigned) counts[v ?? "(null)"] = (counts[v ?? "(null)"] ?? 0) + 1;

  console.log("\nDistribution:");
  for (const [k, c] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${(c + "").padStart(5)}  ${k}`);
  }
  console.log(`\nTotal classified: ${[...allAssigned.values()].filter(v => v !== null).length} / ${candidates.length}`);

  if (apply) {
    let written = 0;
    for (const [id, v] of allAssigned) {
      if (v === null) continue;
      await prisma.examQuestion.update({ where: { id }, data: { subTopic: v } });
      written++;
    }
    console.log(`Wrote ${written} subTopic assignments.`);
  } else {
    console.log("\nPass --apply to write the assignments.");
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
