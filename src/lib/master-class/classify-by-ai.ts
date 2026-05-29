// Generic AI-based sub-topic classifier for master-class question
// banks. Given a master class (with its declared subTopics taxonomy)
// and a batch of candidate questions, asks Gemini Flash to assign
// each question to ONE of the master class's sub-topic IDs (or null
// when nothing fits).
//
// Used by:
//   - scripts/backfill-subtopics.ts  (one-off backfill of existing papers)
//   - post-extraction hook           (fire-and-forget after a new paper
//                                     is extracted)
//
// Why generic + AI (not per-master-class hand-coded rules): the 21
// master classes that need admin-tagged subTopics cover wildly different
// taxonomies (Chinese 短文填空 traps, Math hidden-constant-total variants,
// Science Forces sub-mechanisms, etc.). Hand-coding 21 classifiers and
// maintaining them as the YAML evolves is not the right shape. The
// YAML's `description` field is already a natural-language definition
// of each bucket — feed that to the model and let it pattern-match.

import { GoogleGenAI } from "@google/genai";
import type { MasterClassContent } from "@/data/master-class";

export type QuestionForClassification = {
  id: string;
  questionNum: string;
  transcribedStem: string | null;
  answer: string | null;
};

export type ClassifyOptions = {
  batchSize?: number;          // default 15 — keep batches small so the JSON stays parseable
  maxConcurrency?: number;     // default 3 — parallel batches, polite to the API
  model?: string;              // default "gemini-2.5-flash"
  logLabel?: string;           // prefix for console logs
};

let _ai: GoogleGenAI | null = null;
function getAI(): GoogleGenAI {
  if (_ai) return _ai;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");
  _ai = new GoogleGenAI({ apiKey });
  return _ai;
}

function buildPrompt(content: MasterClassContent, batch: QuestionForClassification[]): string {
  const subTopicLines = content.subTopics
    .map(st => `  - id: "${st.id}"\n    label: ${st.label}\n    description: ${st.description}`)
    .join("\n");
  const questionLines = batch
    .map(q => {
      const stem = (q.transcribedStem ?? "").trim().slice(0, 500).replace(/\s+/g, " ");
      const answer = (q.answer ?? "").trim().slice(0, 120).replace(/\s+/g, " ");
      return `  [${q.id}] (Q${q.questionNum}) ${stem}${answer ? `  ||answer: ${answer}` : ""}`;
    })
    .join("\n");

  return `You are tagging Primary-school exam questions for the "${content.title}" master class (subject: ${content.subject}, topic: ${content.topicLabel}).

Assign EACH question below to exactly ONE of the sub-topic IDs listed, OR return null if the question genuinely doesn't fit any sub-topic. Read each sub-topic's description carefully — the bucket boundaries matter. If a question matches more than one, pick the BEST fit; only use null when none of the descriptions cover the question's actual focus.

SUB-TOPICS (use the EXACT id string):
${subTopicLines}

QUESTIONS:
${questionLines}

Return ONLY a JSON object mapping each question's bracket-id (the cuid string) to either a sub-topic id or null. No prose, no markdown, no comments. Example shape:
{"cmABCDEF...": "sub-topic-a", "cmGHIJKL...": null, ...}`;
}

function parseResponse(text: string, batch: QuestionForClassification[], validIds: Set<string>): Map<string, string | null> {
  const out = new Map<string, string | null>();
  // Tolerate fenced or prose-prefixed responses.
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return out;
  let parsed: unknown;
  try { parsed = JSON.parse(m[0]); } catch { return out; }
  if (!parsed || typeof parsed !== "object") return out;
  const obj = parsed as Record<string, unknown>;
  for (const q of batch) {
    const raw = obj[q.id];
    if (raw == null) {
      out.set(q.id, null);
      continue;
    }
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.toLowerCase() === "null") {
      out.set(q.id, null);
      continue;
    }
    if (!validIds.has(trimmed)) {
      // Model returned an id not in the taxonomy — drop. Logged by caller.
      continue;
    }
    out.set(q.id, trimmed);
  }
  return out;
}

async function classifyBatch(
  content: MasterClassContent,
  batch: QuestionForClassification[],
  validIds: Set<string>,
  model: string,
  logLabel: string,
): Promise<Map<string, string | null>> {
  const ai = getAI();
  const prompt = buildPrompt(content, batch);
  try {
    const resp = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { temperature: 0, responseMimeType: "application/json" },
    });
    const text = (resp.text ?? "").trim();
    const result = parseResponse(text, batch, validIds);
    if (result.size < batch.length) {
      console.warn(`${logLabel} batch of ${batch.length} → parsed ${result.size} (the rest will stay untagged this run)`);
    }
    return result;
  } catch (err) {
    console.error(`${logLabel} batch of ${batch.length} failed:`, (err as Error).message);
    return new Map();
  }
}

// Slugs that have hand-coded classifiers in
// src/app/api/master-class/[slug]/start-quiz/route.ts. We MUST NOT
// AI-tag these — the picker re-tags them at clone time, so any tag we
// write would either silently disagree or be overwritten. Kept in sync
// with STEM_CLASSIFIERS in the start-quiz route.
const SLUGS_WITH_CODE_CLASSIFIER = new Set<string>([
  "patterns",
  "electrical-circuits",
]);

export async function classifyQuestionsForMasterClass(
  content: MasterClassContent,
  questions: QuestionForClassification[],
  options: ClassifyOptions = {},
): Promise<Map<string, string | null>> {
  const batchSize = options.batchSize ?? 15;
  const concurrency = Math.max(1, options.maxConcurrency ?? 3);
  const model = options.model ?? "gemini-2.5-flash";
  const logLabel = options.logLabel ?? `[classify-ai ${content.slug}]`;

  if (questions.length === 0) return new Map();
  if (content.subTopics.length === 0) {
    console.warn(`${logLabel} no subTopics defined — nothing to classify into`);
    return new Map();
  }

  // Drop questions without a usable stem — there's nothing for the
  // model to read. These get returned as untagged (caller can decide
  // what to do; backfill leaves them as null in the DB).
  const usable = questions.filter(q => (q.transcribedStem ?? "").trim().length > 0);
  if (usable.length === 0) {
    console.warn(`${logLabel} all ${questions.length} candidates have empty stems — skipping`);
    return new Map();
  }
  if (usable.length < questions.length) {
    console.log(`${logLabel} skipping ${questions.length - usable.length} stem-less candidates`);
  }

  const validIds = new Set(content.subTopics.map(st => st.id));
  const batches: QuestionForClassification[][] = [];
  for (let i = 0; i < usable.length; i += batchSize) {
    batches.push(usable.slice(i, i + batchSize));
  }
  console.log(`${logLabel} ${usable.length} questions in ${batches.length} batches (size ${batchSize}, concurrency ${concurrency}, model ${model})`);

  const merged = new Map<string, string | null>();
  // Sliding-window concurrency: launch `concurrency` batches at a time.
  let cursor = 0;
  async function worker(wid: number): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= batches.length) return;
      const batch = batches[idx];
      const result = await classifyBatch(content, batch, validIds, model, `${logLabel} w${wid} b${idx + 1}/${batches.length}`);
      for (const [k, v] of result) merged.set(k, v);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i + 1)));

  return merged;
}

// Post-extraction hook: classify every question on a freshly-extracted
// paper against every master class that needs admin-tagged subTopics.
// Fire-and-forget — caller (extraction.ts) does not await this.
//
// Skips:
//   - master classes that use practiceStemRegex (regex pickers don't need subTopic)
//   - master classes with a hand-coded classifier (re-tag at clone time)
//   - questions that already have subTopic set (preserve manual edits)
//   - questions whose syllabusTopic doesn't match the master class's
//     topicLabel
export async function classifyPaperSubtopics(paperId: string): Promise<void> {
  // Lazy import the prisma client + master-class list to keep this
  // module importable from places (eval, scripts) that don't need a
  // DB connection eagerly.
  const { prisma } = await import("@/lib/db");
  const { listMasterClasses } = await import("@/data/master-class");

  const allQs = await prisma.examQuestion.findMany({
    where: {
      examPaperId: paperId,
      subTopic: null,
      transcribedStem: { not: null },
    },
    select: {
      id: true,
      questionNum: true,
      syllabusTopic: true,
      transcribedStem: true,
      answer: true,
    },
  });
  if (allQs.length === 0) {
    console.log(`[classify-subtopics] paper ${paperId}: no untagged stem-bearing questions, skipping`);
    return;
  }

  const targets = listMasterClasses().filter(c =>
    c.subTopics.length > 0 &&
    !c.practiceStemRegex &&
    !SLUGS_WITH_CODE_CLASSIFIER.has(c.slug),
  );

  let totalTagged = 0;
  for (const content of targets) {
    const candidates = allQs.filter(q =>
      (q.syllabusTopic ?? "").toLowerCase() === content.topicLabel.toLowerCase(),
    );
    if (candidates.length === 0) continue;
    const assignments = await classifyQuestionsForMasterClass(content, candidates, {
      logLabel: `[classify-subtopics paper=${paperId} ${content.slug}]`,
    });
    for (const [qid, sub] of assignments) {
      if (sub == null) continue;
      try {
        await prisma.examQuestion.update({ where: { id: qid }, data: { subTopic: sub } });
        totalTagged++;
      } catch (err) {
        console.error(`[classify-subtopics] write failed paper=${paperId} q=${qid}: ${(err as Error).message}`);
      }
    }
  }
  console.log(`[classify-subtopics] paper ${paperId}: tagged ${totalTagged} question(s) across ${targets.length} master class(es)`);
}
