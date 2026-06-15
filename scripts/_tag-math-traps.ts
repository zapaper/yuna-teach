// Tags every math question that any P6 kid has gotten wrong with
// one of the 6 master-class trap categories (or null). Result is
// written to src/lib/math-traps.json, bundled into the deploy so
// tutor.ts can look up traps at render time without further AI calls.
//
// Run cost: ~$0.10 in Gemini Flash for the current cohort. Re-run
// when new wrong attempts come in — the script is idempotent and
// preserves prior tags for question IDs that haven't changed.

import { prisma } from "../src/lib/db";
import { GoogleGenAI } from "@google/genai";
import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";

const TRAPS = [
  "internal-transfer",
  "equal-removal",
  "one-unchanged",
  "equalise-ratios",
  "nested-fractions",
  "percentage-traps",
] as const;
type Trap = typeof TRAPS[number] | null;

const TOPIC_HINTS = /ratio|fraction|proportion|percentage|whole|share|part/i;
const STEM_HINTS = /ratio|fraction|proportion|percentage|what fraction of|of the (total|original|whole)|how many times/i;

const OUT = path.join(__dirname, "..", "src", "lib", "math-traps.json");

(async () => {
  // Pre-existing tags so we don't re-classify questions we've already
  // tagged. Loaded as a plain map of questionId → trap | null.
  const existing: Record<string, Trap> = existsSync(OUT)
    ? JSON.parse(readFileSync(OUT, "utf8"))
    : {};
  console.log(`Loaded ${Object.keys(existing).length} pre-existing tags from ${OUT}`);

  // Pull every wrong-attempt question. We tag by question ID, NOT by
  // sourceQuestionId, so the same master question gets classified once
  // and its many clones reuse via that key. Tagging clones directly
  // (when they have no transcribedStem on the source) gives us
  // coverage for in-app quizzes too.
  const rows = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        markingStatus: { in: ["complete", "released"] },
        OR: [
          { subject: { contains: "math", mode: "insensitive" } },
          { subject: { contains: "mathematics", mode: "insensitive" } },
        ],
      },
      // Wrong (marksAwarded < marksAvailable) but not skipped.
      NOT: [
        { studentAnswer: "__SKIPPED__" },
        { studentAnswer: null },
      ],
      marksAvailable: { gt: 0 },
    },
    select: {
      id: true,
      syllabusTopic: true,
      transcribedStem: true,
      marksAwarded: true,
      marksAvailable: true,
      sourceQuestionId: true,
    },
  });

  const candidates = rows
    .filter(r => (r.marksAwarded ?? 0) < (r.marksAvailable ?? 0))
    .filter(r => {
      const t = r.syllabusTopic ?? "";
      const stem = r.transcribedStem ?? "";
      return stem.length >= 20 && (TOPIC_HINTS.test(t) || STEM_HINTS.test(stem));
    });
  // Tag by the source question if there is one, otherwise by the
  // clone's own id. Same key the lookup will use at runtime.
  const keyOf = (r: typeof candidates[number]) => r.sourceQuestionId ?? r.id;

  // Dedup — many clones share the same source. We only need to
  // classify each unique source/orphan once.
  const byKey = new Map<string, typeof candidates[number]>();
  for (const r of candidates) {
    const k = keyOf(r);
    if (!byKey.has(k)) byKey.set(k, r);
  }
  const todo = [...byKey.values()].filter(r => !(keyOf(r) in existing));
  console.log(`Math wrong-question candidates: ${candidates.length}`);
  console.log(`Unique keys: ${byKey.size}, already tagged: ${byKey.size - todo.length}, to classify: ${todo.length}\n`);

  if (todo.length === 0) {
    console.log("Nothing to do.");
    await prisma.$disconnect();
    return;
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { timeout: 90_000 } });
  const BATCH = 25;
  const prompt = (records: typeof todo) => `You are tagging primary-school Math word problems with which "tricky ratio/fraction trap" they require. Pick AT MOST ONE bucket from this strict taxonomy, or return null if the question genuinely fits none.

1. internal-transfer — Two named parties; one gives a quantity to the other. TOTAL between the two stays constant. "Andy gave $5 to Betty; now Andy has $4 less than Betty."

2. equal-removal — SAME amount added to or removed from BOTH quantities. DIFFERENCE stays constant. "Sam and Tim each spent $12 of their money."

3. one-unchanged — Only ONE of the two quantities is changed; the OTHER stays untouched. "Mei Ling spent 1/4 of her money on a book. She did not touch her savings."

4. equalise-ratios — TWO situations with EQUAL TOTAL but DIFFERENT ratios. "Box A: red:blue = 1:5. Box B: red:blue = 1:2. Both boxes have the same total."

5. nested-fractions — Fraction of REMAINDER after a previous fraction was taken. "Spent 1/4 of money on book, then 2/5 of the REMAINDER on snacks."

6. percentage-traps — Base for "%" shifts mid-problem; % of one base differs from % of another. "Price dropped 20% then rose 20%."

Return JSON: { "tags": ["internal-transfer", null, "nested-fractions", ...] } same order + length as input.

Records:
${records.map((r, i) => `[${i}] ${(r.transcribedStem ?? "").slice(0, 500).replace(/\s+/g, " ")}`).join("\n\n")}`;

  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    process.stdout.write(`  Batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(todo.length / BATCH)} (${batch.length}) ... `);
    try {
      const resp = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt(batch) }] }],
        config: { temperature: 0, responseMimeType: "application/json" },
      });
      const parsed = JSON.parse(resp.text ?? "{}") as { tags?: Array<string | null> };
      const tags = parsed.tags ?? [];
      for (let j = 0; j < batch.length; j++) {
        const tag = tags[j];
        const k = keyOf(batch[j]);
        existing[k] = tag && (TRAPS as readonly string[]).includes(tag) ? (tag as Trap) : null;
      }
      // Persist after each batch so a transient failure doesn't lose work.
      writeFileSync(OUT, JSON.stringify(existing, null, 0));
      console.log(`ok (cumulative ${Object.keys(existing).length})`);
    } catch (err) {
      console.log(`failed: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
    }
  }

  // Summary
  const total = Object.values(existing).filter(v => v !== null).length;
  const tally: Record<string, number> = {};
  for (const v of Object.values(existing)) if (v) tally[v] = (tally[v] ?? 0) + 1;
  console.log(`\nDone. ${Object.keys(existing).length} keys tagged total, ${total} with a non-null trap:\n`);
  for (const t of TRAPS) console.log(`  ${t.padEnd(25)} ${tally[t] ?? 0}`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
