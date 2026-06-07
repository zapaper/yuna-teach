// Run a batch of N master Grammar MCQ elaborations directly (mirrors
// the /api/admin/elaborate-mcq route's English branch) and print each
// question + generated explanation for review. Writes back to DB on
// success so we don't redo them later.
//
//   npx tsx scripts/_run-grammar-elab-batch.ts [limit=10]

import { GoogleGenAI } from "@google/genai";
import { prisma } from "../src/lib/db";

const limit = Math.max(1, parseInt(process.argv[2] ?? "10", 10));

const ELAB_ERROR_PREFIX = '{"__elabError"';

const LEVELS = ["Primary 5", "Primary 6", "P5", "P6", "PSLE"];

function parseModelResponse(text: string): { solution: string; diagrams: unknown[] } {
  let raw = text.trim();
  const fence = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) raw = fence[1].trim();
  try {
    const parsed = JSON.parse(raw) as { solution?: unknown; diagrams?: unknown };
    if (parsed && typeof parsed.solution === "string") {
      const diagrams = Array.isArray(parsed.diagrams) ? parsed.diagrams : [];
      return { solution: parsed.solution, diagrams };
    }
  } catch { /* fall through */ }
  return { solution: text, diagrams: [] };
}

async function main() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  // Pull pending master Grammar MCQ rows for P5-P6+PSLE.
  const candidates = await prisma.examQuestion.findMany({
    where: {
      syllabusTopic: "Grammar MCQ",
      elaboration: null,
      examPaper: {
        sourceExamId: null, paperType: null,
        subject: { contains: "english", mode: "insensitive" },
        OR: LEVELS.map(l => l.includes(" ") || l.length > 4
          ? { level: { contains: l, mode: "insensitive" as const } }
          : { level: { equals: l, mode: "insensitive" as const } }),
      },
    },
    select: {
      id: true, questionNum: true, transcribedStem: true,
      transcribedOptions: true, answer: true,
      examPaper: { select: { title: true, level: true } },
    },
    orderBy: { id: "asc" },
    take: limit,
  });

  console.log(`Picked ${candidates.length} pending Grammar MCQ rows. Running elaborations…\n`);

  let ok = 0, fail = 0;
  for (let i = 0; i < candidates.length; i++) {
    const q = candidates[i];
    const opts = q.transcribedOptions as string[] | null;
    const stemText = q.transcribedStem ?? `Question ${q.questionNum}`;
    const optsText = (opts && opts.length > 0)
      ? opts.map((o, j) => `(${j + 1}) ${o}`).join("\n")
      : "";
    const questionText = optsText ? `${stemText}\n${optsText}` : stemText;
    const answerAnchor = `**The answer is ${q.answer ?? "Not provided"} — this is the official answer key and is authoritative.** Your explanation MUST arrive at this answer.`;
    const prompt = `You are a helpful tutor for a Primary 5/6 student learning English grammar.

Here is the question:
${questionText}

${answerAnchor}

Explain the answer in this structure:
1. **The rule** — name the specific grammar rule being tested (e.g. subject-verb agreement, prepositions of place, tense consistency, relative pronouns, conditional sentences, indirect speech backshift, etc.) in ONE clear sentence.
2. **Why the answer is correct** — apply the rule to the sentence in 1-2 sentences.
3. **Why each wrong option fails** — go through the three distractors in order. For each, name the SPECIFIC error (wrong tense, mismatched subject, wrong preposition, double negative, etc.) in one short line per option.

Keep the entire explanation under 130 words, hard cap at 160. Age-appropriate, encouraging, plain language a P5/P6 student can follow. Use **double asterisks** to bold the rule name, key grammar terms, and option numbers ((1), (2), etc.). No fractions, no LaTeX, no diagrams. Return diagrams as an empty array.

Respond with ONLY valid JSON (no markdown fences, no surrounding text):
{
  "solution": "<grammar explanation with **bold** as described>",
  "diagrams": []
}`;
    try {
      const t0 = Date.now();
      const resp = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      });
      const raw = resp.text ?? "";
      const { solution, diagrams } = parseModelResponse(raw);
      const elaboration = solution || "Unable to generate explanation.";
      const cached = JSON.stringify({ solution: elaboration, diagrams });
      await prisma.examQuestion.update({ where: { id: q.id }, data: { elaboration: cached } });
      ok++;
      const t = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`============================================================`);
      console.log(`[${i + 1}/${candidates.length}] ${q.examPaper.title} — Q${q.questionNum}  ${q.examPaper.level}  (${t}s)`);
      console.log(`============================================================`);
      console.log(`STEM: ${stemText.slice(0, 200)}`);
      if (opts) for (let j = 0; j < opts.length; j++) console.log(`  (${j + 1}) ${opts[j]}`);
      console.log(`ANSWER: ${q.answer}`);
      console.log(`\nELABORATION (${solution.length} chars):`);
      console.log(solution);
      console.log();
    } catch (err) {
      fail++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[${i + 1}/${candidates.length}] FAILED  ${q.examPaper.title} Q${q.questionNum}: ${msg.slice(0, 200)}`);
      const sentinel = JSON.stringify({ __elabError: msg.slice(0, 280), attemptedAt: new Date().toISOString() });
      await prisma.examQuestion.update({ where: { id: q.id }, data: { elaboration: sentinel } });
    }
  }
  console.log(`\nDone. ok=${ok}  failed=${fail}`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
