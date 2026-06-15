// Bucket every P6 math wrong record on a ratio/fraction-flavour
// question into one of the 6 master-class trap categories. Uses
// Gemini Flash in batches of 20 — cheap + fast enough for the whole
// cohort.
//
// Output: per-bucket tally across all kids + per-kid breakdown for
// the kids with the most marks lost.

import { prisma } from "../src/lib/db";
import { GoogleGenAI } from "@google/genai";

const TOPIC_HINTS = /ratio|fraction|proportion|percentage|whole|share|part/i;
const STEM_HINTS = /ratio|fraction|proportion|percentage|what fraction of|of the (total|original|whole)|how many times/i;

const BUCKETS = [
  "internal-transfer",       // constant total — A gave $N to B
  "equal-removal",           // constant difference — both lost equally
  "one-unchanged",           // only ONE quantity changed
  "equalise-ratios",         // ratio became X':Y' — equalise totals
  "nested-fractions",        // fraction of the remainder
  "percentage-traps",        // base-shift, % of % etc.
  "other-ratio-fraction",    // ratio/fraction question but doesn't fit
] as const;

type Bucket = typeof BUCKETS[number];

type WrongItem = {
  kid: string;
  stem: string;
  topic: string;
  marksLost: number;
};

(async () => {
  const kids = await prisma.user.findMany({
    where: { role: "STUDENT", level: 6, NOT: { name: { in: ["admin", "student555", "student666"], mode: "insensitive" } } },
    select: { id: true, name: true },
  });
  console.log(`Loading wrongs from ${kids.length} P6 students...`);

  const items: WrongItem[] = [];
  for (const k of kids) {
    const papers = await prisma.examPaper.findMany({
      where: {
        assignedToId: k.id,
        markingStatus: { in: ["complete", "released"] },
        OR: [
          { subject: { contains: "math", mode: "insensitive" } },
          { subject: { contains: "mathematics", mode: "insensitive" } },
        ],
      },
      select: { metadata: true, questions: { select: { syllabusTopic: true, transcribedStem: true, marksAwarded: true, marksAvailable: true, studentAnswer: true } } },
    });
    const nonRev = papers.filter(p => !(p.metadata as { revisionMode?: unknown } | null)?.revisionMode);
    for (const p of nonRev) {
      for (const q of p.questions) {
        const av = q.marksAvailable ?? 0, aw = q.marksAwarded ?? 0;
        if (av === 0 || aw >= av) continue;
        if (q.studentAnswer === "__SKIPPED__") continue;
        const t = q.syllabusTopic ?? "";
        const stem = q.transcribedStem ?? "";
        if (!TOPIC_HINTS.test(t) && !STEM_HINTS.test(stem)) continue;
        if (stem.length < 20) continue; // too short to classify
        items.push({ kid: k.name, stem: stem.slice(0, 500).replace(/\s+/g, " "), topic: t, marksLost: av - aw });
      }
    }
  }
  console.log(`Total wrong records to classify: ${items.length}\n`);

  // ─── Classify in batches via Gemini Flash ───
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { timeout: 90_000 } });
  const BATCH = 20;
  const results: Bucket[] = [];

  const prompt = (records: WrongItem[]) => `You are tagging primary school Math word problems with which "tricky ratio/fraction trap" they require, taken from this strict taxonomy of 6 buckets:

1. internal-transfer — Two named parties; one gives some of their quantity to the other. The TOTAL between the two stays constant. Example: "Andy gave $5 to Betty. Now Andy has $4 less than Betty. Find Andy's original amount."

2. equal-removal — The SAME amount is added to or removed from both quantities. The DIFFERENCE stays constant. Example: "Sam and Tim each spent $12 of their money. Tim has 1/3 as much left as Sam."

3. one-unchanged — Only ONE of the two quantities is changed; the OTHER stays untouched. Example: "Mei Ling spent 1/4 of her money on a book. She did not touch her savings."

4. equalise-ratios — TWO situations have an equal total but DIFFERENT ratios. Solve by equalising the totals. Example: "Box A: red:blue = 1:5. Box B: red:blue = 1:2. Both boxes have the same total of marbles."

5. nested-fractions — A fraction is taken, then a fraction of the REMAINDER, then optionally another of THAT remainder. Example: "She spent 1/4 of her money on a book and then 2/5 of the remainder on snacks."

6. percentage-traps — Reference for "%" shifts mid-problem; % of one base differs from % of another. Example: "The price dropped 20% then rose 20%."

If a ratio/fraction question genuinely doesn't fit any of the 6, return "other-ratio-fraction".

Return JSON ONLY: { "tags": ["internal-transfer", "equalise-ratios", ...] } in same order as input.

Records:
${records.map((r, i) => `[${i}] ${r.stem}`).join("\n\n")}`;

  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    process.stdout.write(`  Batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(items.length / BATCH)} (${batch.length} records)... `);
    try {
      const resp = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [{ role: "user", parts: [{ text: prompt(batch) }] }],
        config: { temperature: 0, responseMimeType: "application/json" },
      });
      const parsed = JSON.parse(resp.text ?? "{}") as { tags?: string[] };
      const tags = parsed.tags ?? [];
      for (let j = 0; j < batch.length; j++) {
        const t = (tags[j] ?? "other-ratio-fraction") as Bucket;
        results.push(BUCKETS.includes(t) ? t : "other-ratio-fraction");
      }
      console.log("ok");
    } catch (err) {
      console.log(`failed: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
      for (let j = 0; j < batch.length; j++) results.push("other-ratio-fraction");
    }
  }

  // ─── Tally ───
  const tally: Record<Bucket, { count: number; marks: number; kids: Set<string> }> = Object.fromEntries(
    BUCKETS.map(b => [b, { count: 0, marks: 0, kids: new Set<string>() }]),
  ) as Record<Bucket, { count: number; marks: number; kids: Set<string> }>;
  for (let i = 0; i < items.length; i++) {
    const b = results[i] ?? "other-ratio-fraction";
    tally[b].count++;
    tally[b].marks += items[i].marksLost;
    tally[b].kids.add(items[i].kid);
  }
  console.log("\n═══ Cohort-wide trap distribution ═══\n");
  console.log("  Bucket                     Records   MarksLost   KidsAffected");
  for (const b of BUCKETS) {
    const t = tally[b];
    console.log(`  ${b.padEnd(25)} ${String(t.count).padStart(7)}   ${t.marks.toFixed(0).padStart(9)}   ${t.kids.size}`);
  }
  console.log(`\n  TOTAL                     ${String(items.length).padStart(7)}   ${items.reduce((s, x) => s + x.marksLost, 0).toFixed(0).padStart(9)}`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
