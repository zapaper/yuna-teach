// Re-classify the 127 PSLE Grammar MCQ questions currently tagged
// "noun-number-rules" into the new split: subject-verb-agreement or
// countable/uncountable. Uses the updated classifyGrammarMcq rule
// path; rows that come back with the OLD bucket name (shouldn't
// happen after the lib edit, but defensive) fall through to AI.
//
// Dry-run by default; pass --apply to write.

import { prisma } from "@/lib/db";
import { classifyGrammarMcq, type GrammarSubTopic } from "@/lib/master-class/classify-grammar";
import { GoogleGenAI } from "@google/genai";

const VALID = new Set<GrammarSubTopic>([
  "tag-questions",
  "subject-verb-agreement",
  "countable/uncountable",
  "pronouns",
  "verb-forms",
  "connectors-tenses",
  "idiomatic-prepositions",
]);

let _ai: GoogleGenAI | null = null;
function getAI() { if (_ai) return _ai; _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! }); return _ai; }

async function aiClassify(q: { id: string; stem: string | null; options: string[] | null; answer: string | null }): Promise<GrammarSubTopic | null> {
  const ai = getAI();
  const opts = (q.options ?? []).map((o, i) => `(${i + 1}) ${o}`).join("  ");
  const prompt = `Tag this PSLE Grammar MCQ question as exactly ONE of these sub-topics:
- subject-verb-agreement: singular vs plural verb form (is/are, has/have, was/were) picked to match the subject. Includes interrupters (X, together with Y, IS…), each of / one of / neither / nobody + verb.
- countable/uncountable: quantifier choice (much/many, few/little, fewer/less, a number of / the number of, a great deal of, plenty of).
- pronouns: reflexive (himself), possessive (his/hers), relative (who/whom/whose/which).
- verb-forms: gerund vs infinitive, causative bare-infinitive, participial constructions.
- connectors-tenses: cause/concession connectors + tense markers (if, by the time, no sooner, had it not been).
- tag-questions: tag question structure (..., isn't he? / ..., shall we?).
- idiomatic-prepositions: prep collocations (congratulate ON, robbed OF, under the impression).

Question: ${q.stem}
Options: ${opts}
Answer: ${q.answer}

Return ONLY one of those sub-topic ids on a single line, no prose.`;
  const resp = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: prompt, config: { temperature: 0.1 } });
  const text = (resp.text ?? "").trim().replace(/[`"]/g, "");
  if (VALID.has(text as GrammarSubTopic)) return text as GrammarSubTopic;
  return null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log(apply ? "── APPLY mode ──\n" : "── DRY RUN (pass --apply to commit) ──\n");

  const candidates = await prisma.examQuestion.findMany({
    where: { syllabusTopic: "Grammar MCQ", subTopic: "noun-number-rules" },
    select: { id: true, transcribedStem: true, transcribedOptions: true, answer: true },
  });
  console.log(`Candidates (currently tagged noun-number-rules): ${candidates.length}\n`);

  const remap = new Map<string, GrammarSubTopic | null>();
  let aiFallbacks = 0;
  for (const q of candidates) {
    const opts = (q.transcribedOptions as string[] | null) ?? [];
    const r = classifyGrammarMcq(q.transcribedStem, opts);
    if (r === "subject-verb-agreement" || r === "countable/uncountable") {
      remap.set(q.id, r);
    } else {
      // Rule path didn't split cleanly → AI tie-break (rare path).
      const ai = await aiClassify({ id: q.id, stem: q.transcribedStem, options: opts, answer: q.answer });
      remap.set(q.id, ai);
      aiFallbacks++;
    }
  }
  const counts: Record<string, number> = {};
  for (const v of remap.values()) counts[v ?? "(null)"] = (counts[v ?? "(null)"] ?? 0) + 1;
  console.log("Distribution:");
  for (const [k, c] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${(c + "").padStart(4)}  ${k}`);
  }
  console.log(`\nAI fallbacks: ${aiFallbacks}`);

  if (apply) {
    let written = 0;
    for (const [id, v] of remap) {
      if (!v) continue;
      await prisma.examQuestion.update({ where: { id }, data: { subTopic: v } });
      written++;
    }
    console.log(`\nWrote ${written} subTopic updates.`);
  } else {
    console.log("\nPass --apply to write the updates.");
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
