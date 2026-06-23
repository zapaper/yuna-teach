// Classify Science master OEQs (>=2 marks) with cross-cutting skill
// tags using Gemini 2.5-flash. Outputs to JSON for vetting before any
// DB write — the skillTags column migration is applied separately.
//
// Usage:
//   npx tsx scripts/classify-science-skills.ts --limit=20
//     → runs on 20 random Qs, writes eval/science-skill-tags.json
//   npx tsx scripts/classify-science-skills.ts
//     → runs on every eligible Q (~1500), writes the same file
//   npx tsx scripts/classify-science-skills.ts --topic="Heat energy and uses"
//     → restricts to one topic
//
// Cost: ~$0.0002 per Q at Gemini 2.5-flash pricing. Full pass ~$0.30.

import { promises as fs } from "fs";
import path from "path";
import { generateContentWithRetry } from "../src/lib/gemini";
import { prisma } from "../src/lib/db";
import { SCIENCE_SKILL_TAGS, skillTagsPromptBlock, type ScienceSkillTag } from "../src/lib/science-skills";

const OUTPUT = path.join(__dirname, "..", "eval", "science-skill-tags.json");

type ClassifyArgs = {
  limit?: number;
  topic?: string;
  level?: "P6" | "P5" | "P4";  // includes PSLE when P6
  shuffle?: boolean;
};
function parseArgs(): ClassifyArgs {
  const out: ClassifyArgs = { shuffle: true };
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--(\w+)=(.+)$/);
    if (!m) continue;
    if (m[1] === "limit") out.limit = parseInt(m[2]);
    if (m[1] === "topic") out.topic = m[2];
    if (m[1] === "level") out.level = m[2] as ClassifyArgs["level"];
    if (m[1] === "shuffle") out.shuffle = m[2] !== "false";
  }
  return out;
}

// Filter master papers by level. P6 catches "P6 ...", "Primary 6 ...",
// and PSLE papers (they're P6-equivalent). Same shape for P5 and P4.
function paperMatchesLevel(title: string, level: "P6" | "P5" | "P4"): boolean {
  const t = title.toLowerCase();
  if (level === "P6") {
    return /\b(p6|primary 6|psle)\b/i.test(t);
  }
  if (level === "P5") {
    return /\b(p5|primary 5)\b/i.test(t);
  }
  return /\b(p4|primary 4)\b/i.test(t);
}

function buildPrompt(stem: string, answer: string, marksAvailable: number): string {
  return `You are tagging a PSLE Science master question with cross-cutting SKILL tags.

Skills (zero, one, or several may apply — only tag a skill that is ACTUALLY required to score the marks):

${skillTagsPromptBlock()}

QUESTION (${marksAvailable} marks):
${stem || "(no stem text — likely a diagram-only question)"}

EXPECTED ANSWER:
${answer || "(no answer key on file)"}

Rules:
- Tag ONLY skills that the mark scheme actually demands to score full marks. If the question is pure content recall, return an empty array.
- "graph-trend-describe" needs a graph/table AND a "describe the trend" instruction (NOT an MCQ that picks the right graph).
- "evidence-then-conclusion" applies only when the answer has TWO parts — observation/evidence AND a WHY. A single-line factual answer doesn't count.
- "fair-test-explain" needs an experimental design discussion — variables, controls, or "why was X kept constant".

Respond with a strict JSON object:
{ "skillTags": ["..."], "reason": "one short sentence" }

Where skillTags is a subset of: ${SCIENCE_SKILL_TAGS.map(t => `"${t}"`).join(", ")}.`;
}

function parseClassifierResponse(text: string): { skillTags: ScienceSkillTag[]; reason: string } | null {
  // Gemini sometimes wraps in ```json fences
  const cleaned = text.replace(/```json\s*|\s*```/g, "").trim();
  // grab first { ... } block
  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
    const tags: string[] = Array.isArray(parsed.skillTags) ? parsed.skillTags : [];
    const valid = tags.filter((t): t is ScienceSkillTag => (SCIENCE_SKILL_TAGS as readonly string[]).includes(t));
    return { skillTags: valid, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
  } catch {
    return null;
  }
}

async function classifyOne(
  q: { id: string; transcribedStem: string | null; answer: string | null; marksAvailable: number | null }
): Promise<{ skillTags: ScienceSkillTag[]; reason: string } | null> {
  const stem = (q.transcribedStem ?? "").trim();
  const answer = (q.answer ?? "").trim();
  const marks = Number(q.marksAvailable) || 2;
  const prompt = buildPrompt(stem, answer, marks);
  try {
    const res = await generateContentWithRetry(
      {
        model: "gemini-2.5-flash",
        contents: prompt,
        config: { temperature: 0, responseMimeType: "application/json" },
      },
      1,
      3000,
      `skill-tag:${q.id.slice(-6)}`,
    );
    const text = res.text ?? "";
    return parseClassifierResponse(text);
  } catch (err) {
    console.warn(`[skill-tag] ${q.id} failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

(async () => {
  const args = parseArgs();
  console.log("Args:", args);

  // Eligible: Science master, >=2 marks. We filter MCQs in JS because
  // Prisma's JSON-equals comparison against an empty array doesn't
  // round-trip cleanly through Postgres' JSONB type ('[]'::jsonb vs
  // 'null'::jsonb — neither matches the literal `[]` argument).
  const fetched = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        sourceExamId: null, paperType: null, extractionStatus: "ready",
        subject: { contains: "science", mode: "insensitive" },
      },
      marksAvailable: { gte: 2 },
      ...(args.topic ? { syllabusTopic: args.topic } : {}),
    },
    select: {
      id: true,
      questionNum: true,
      syllabusTopic: true,
      transcribedStem: true,
      transcribedOptions: true,
      answer: true,
      marksAvailable: true,
      examPaper: { select: { title: true, year: true } },
    },
    orderBy: { id: "asc" },
  });
  const isOEQ = (q: { transcribedOptions: unknown }) => {
    const o = q.transcribedOptions;
    if (o == null) return true;
    if (Array.isArray(o) && o.length === 0) return true;
    if (Array.isArray(o) && o.length === 4) return false;  // 4-option MCQ
    return true;  // table-format / 2-option / other — still OEQ-like
  };
  let pool = fetched.filter(isOEQ);
  if (args.level) {
    const beforeLevel = pool.length;
    pool = pool.filter(q => paperMatchesLevel(q.examPaper.title, args.level!));
    console.log(`Level filter ${args.level}: ${beforeLevel} → ${pool.length}`);
  }
  if (args.shuffle) {
    // Fisher-Yates for an unbiased sample (avoids the "first 20 are all
    // from one school" trap we hit on the first run)
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
  }
  const candidates = typeof args.limit === "number" ? pool.slice(0, args.limit) : pool;
  console.log(`Fetched ${fetched.length} Science Qs with marks >= 2`);
  console.log(`Of those, ${pool.length} are OEQ-shaped${args.level ? ` (and ${args.level})` : ""}.`);
  console.log(`Classifying ${candidates.length}${args.shuffle ? " (shuffled)" : ""}.\n`);
  if (candidates.length === 0) {
    await prisma.$disconnect();
    return;
  }

  type ResultRow = {
    id: string;
    questionNum: string;
    topic: string;
    paper: string;
    year: string | null;
    marks: number;
    skillTags: ScienceSkillTag[];
    reason: string;
    stemSnippet: string;
    answerSnippet: string;
  };
  const results: ResultRow[] = [];
  const counts: Record<string, number> = { none: 0 };
  for (const tag of SCIENCE_SKILL_TAGS) counts[tag] = 0;

  let i = 0;
  for (const q of candidates) {
    i++;
    const verdict = await classifyOne(q);
    const skillTags = verdict?.skillTags ?? [];
    const reason = verdict?.reason ?? "(no response)";
    const stem = (q.transcribedStem ?? "").replace(/\s+/g, " ").trim();
    const ans = (q.answer ?? "").replace(/\s+/g, " ").trim();
    results.push({
      id: q.id,
      questionNum: q.questionNum,
      topic: q.syllabusTopic ?? "(none)",
      paper: q.examPaper.title,
      year: q.examPaper.year,
      marks: Number(q.marksAvailable),
      skillTags,
      reason,
      stemSnippet: stem.slice(0, 220),
      answerSnippet: ans.slice(0, 220),
    });
    if (skillTags.length === 0) counts.none++;
    for (const t of skillTags) counts[t]++;
    if (i % 20 === 0 || i === candidates.length) {
      console.log(`  ${i}/${candidates.length} done`);
    }
  }

  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, JSON.stringify({ generatedAt: new Date().toISOString(), counts, results }, null, 2), "utf-8");
  console.log(`\nSaved: ${OUTPUT}`);
  console.log("\nTag distribution:");
  for (const [tag, n] of Object.entries(counts)) {
    const pct = ((n / results.length) * 100).toFixed(1);
    console.log(`  ${tag.padEnd(28)} ${String(n).padStart(4)}  (${pct}%)`);
  }
  await prisma.$disconnect();
})();
