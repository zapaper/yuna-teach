// Re-run the full Comp Cloze classifier pipeline AND capture what
// the AI fallback decided so we can sanity-check the SVA bucket.
// Caches results in memory only — no writes.

import { prisma } from "@/lib/db";
import { GoogleGenAI } from "@google/genai";
import { classifyCompCloze, type CompClozeSubTopic } from "@/lib/master-class/classify-comp-cloze";

const VALID: CompClozeSubTopic[] = ["connector", "preposition", "pronoun-reference", "subject-verb-agreement", "content-word"];
const DESC: Record<CompClozeSubTopic, string> = {
  connector: "Clause / sentence linking words. Answers like when, because, although, however, so, or, but.",
  preposition: "Verb-preposition or noun-preposition collocations. Answers like in, on, at, of, to, for, with, by, from.",
  "pronoun-reference": "A pronoun referring back to an antecedent. Answers like he, she, it, our, their, his, hers, whom.",
  "subject-verb-agreement": "Singular/plural verb forms (is/are/has/have/was/were) that depend on the subject's number.",
  "content-word": "The meaningful word (verb/noun/adj/adv) in the blank where meaning fits the passage context.",
};

let _ai: GoogleGenAI | null = null;
function getAI() { if (_ai) return _ai; _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! }); return _ai; }

async function aiBatch(batch: Array<{ id: string; stem: string | null; answer: string | null }>) {
  const ai = getAI();
  const lines = batch.map(q => `  [${q.id}] stem: ${(q.stem ?? "").slice(0, 600).replace(/\s+/g, " ")}\n             answer: "${(q.answer ?? "").slice(0, 60)}"`).join("\n");
  const sub = VALID.map(id => `  - "${id}": ${DESC[id]}`).join("\n");
  const prompt = `Tag each PSLE Comp Cloze question with ONE sub-topic id.\n\nSUB-TOPICS:\n${sub}\n\nQUESTIONS:\n${lines}\n\nReturn JSON {id: sub-topic-id or null}.`;
  const resp = await ai.models.generateContent({ model: "gemini-2.5-flash", contents: prompt, config: { temperature: 0.1, responseMimeType: "application/json" } });
  return JSON.parse((resp.text ?? "{}").trim()) as Record<string, string | null>;
}

async function main() {
  const cs = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: "Comprehension Cloze",
      answer: { not: null },
      examPaper: { subject: { equals: "English", mode: "insensitive" }, sourceExamId: null, OR: [{ title: { contains: "PSLE", mode: "insensitive" } }, { level: { contains: "6", mode: "insensitive" } }] },
    },
    select: { id: true, transcribedStem: true, answer: true, examPaperId: true },
  });

  const queue: Array<{ id: string; stem: string | null; answer: string | null }> = [];
  for (const q of cs) {
    const r = classifyCompCloze(q.transcribedStem, q.answer);
    if (r === null || r === "content-word") queue.push({ id: q.id, stem: q.transcribedStem, answer: q.answer });
  }
  const final = new Map<string, CompClozeSubTopic | null>();
  const BATCH = 15;
  for (let i = 0; i < queue.length; i += BATCH) {
    const part = await aiBatch(queue.slice(i, i + BATCH));
    for (const [k, v] of Object.entries(part)) {
      if (v === null) final.set(k, null);
      else if (VALID.includes(v as CompClozeSubTopic)) final.set(k, v as CompClozeSubTopic);
    }
  }

  // Collect AI-tagged SVA Qs + their actual answers + paper IDs for inspection.
  const svaIds = [...final.entries()].filter(([, v]) => v === "subject-verb-agreement").map(([k]) => k);
  console.log(`AI-tagged SVA: ${svaIds.length} questions\n`);
  const svaQs = cs.filter(q => svaIds.includes(q.id));
  for (const q of svaQs) {
    console.log(`  [${q.id.slice(-6)}] paper=${q.examPaperId.slice(-6)}  answer="${q.answer}"  stem: ${(q.transcribedStem ?? "(empty)").slice(0, 120).replace(/\s+/g, " ")}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
