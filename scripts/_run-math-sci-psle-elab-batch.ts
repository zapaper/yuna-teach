// Run elaborations for PSLE Math + Science MCQ questions WITHOUT
// diagrams. Mirrors the /api/admin/elaborate-mcq route's non-English
// prompt path (math heuristics + diagram rules), but skipping any
// question that has a diagram, image options, or a referenced figure
// bound — diagram MCQs need more careful handling and are batched
// separately.
//
//   npx tsx scripts/_run-math-sci-psle-elab-batch.ts [limit=120]

import { GoogleGenAI } from "@google/genai";
import { prisma } from "../src/lib/db";
import { mathHeuristicsBlock } from "../src/lib/math-heuristics";

const limit = Math.max(1, parseInt(process.argv[2] ?? "120", 10));

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

const COMMON_DIAGRAM_RULES = `Diagram rules:
- For arithmetic, do not draw figures. Diagram = empty array.
- Show working in plain text with the units / model approach where it suits.`;

async function main() {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
  const candidates = await prisma.examQuestion.findMany({
    where: {
      elaboration: null,
      examPaper: {
        sourceExamId: null, paperType: null,
        OR: [
          { level: { equals: "PSLE", mode: "insensitive" } },
          { title: { contains: "PSLE", mode: "insensitive" } },
        ],
      },
      OR: [
        { examPaper: { subject: { contains: "math", mode: "insensitive" } } },
        { examPaper: { subject: { contains: "science", mode: "insensitive" } } },
      ],
    },
    select: {
      id: true, questionNum: true, transcribedStem: true,
      transcribedOptions: true, transcribedOptionImages: true, transcribedOptionTable: true,
      transcribedSubparts: true, diagramImageData: true, diagramBounds: true,
      answer: true, syllabusTopic: true,
      examPaper: { select: { title: true, subject: true, level: true } },
    },
    orderBy: { id: "asc" },
  });

  // Filter to MCQ-only AND no-diagram in the script (Prisma can't do
  // the array-shape checks cleanly).
  const isMcq = (q: typeof candidates[number]) => {
    const opts = q.transcribedOptions as unknown[] | null;
    const imgs = q.transcribedOptionImages as unknown[] | null;
    const tbl = q.transcribedOptionTable as { rows?: unknown } | null;
    if (Array.isArray(opts) && opts.length === 4) return true;
    if (Array.isArray(imgs) && imgs.some(o => !!o)) return true;
    if (tbl && Array.isArray(tbl.rows) && (tbl.rows as unknown[]).length === 4) return true;
    return false;
  };
  const hasDiagram = (q: typeof candidates[number]) => {
    if (q.diagramImageData && q.diagramImageData.length > 100) return true;
    if (q.diagramBounds) return true;
    const imgs = q.transcribedOptionImages as unknown[] | null;
    if (Array.isArray(imgs) && imgs.some(o => !!o)) return true;
    return false;
  };
  const filtered = candidates.filter(q => isMcq(q) && !hasDiagram(q)).slice(0, limit);

  console.log(`Picked ${filtered.length} pending PSLE Math/Science MCQ no-diagram rows. Running elaborations…\n`);

  let ok = 0, fail = 0;
  for (let i = 0; i < filtered.length; i++) {
    const q = filtered[i];
    const opts = q.transcribedOptions as string[] | null;
    const subs = q.transcribedSubparts as { label: string; text: string }[] | null;
    let questionText = q.transcribedStem ?? `Question ${q.questionNum}`;
    if (opts && opts.length > 0) {
      questionText += "\n" + opts.map((o, j) => `(${j + 1}) ${o}`).join("\n");
    }
    if (subs && subs.length > 0) {
      questionText += "\n" + subs.filter(s => s.label !== "_drawable").map(s => `(${s.label}) ${s.text}`).join("\n");
    }
    const answerAnchor = `**The answer is ${q.answer ?? "Not provided"} — this is the official answer key and is authoritative.** Your explanation MUST arrive at this answer. If your working seems to point at a different answer, you have misread the question, re-examine the question text and answer key, then explain how the official answer is reached.`;

    const prompt = `You are a helpful tutor for a primary school student.

Here is the question:
${questionText}

${answerAnchor}

Go straight into the correct answer and provide a clear step-by-step explanation of how to solve it. Do NOT discuss what the student did wrong or why they lost marks — just teach the correct approach.

Keep the "solution" tight: aim for 120 words, hard cap at 150. Age-appropriate, encouraging, simple language. **Fractions MUST be written as inline LaTeX delimited by single dollar signs**. CRITICAL — your output is JSON, so backslashes inside string values MUST be DOUBLED: write \`$\\\\frac{3}{7}$\` (with TWO backslashes) inside the "solution" string, not \`$\\frac{3}{7}$\`. The JSON parser will turn the doubled backslash back into one. Same for mixed numbers: \`$3\\\\frac{1}{2}$\`. If you forget to double the backslash, JSON parsing will eat \`\\f\` as a form-feed and the fraction breaks. Other math stays plain text: x or * for multiply, ÷ for divide, x^2 for powers, = for equals. The only LaTeX command allowed is \\\\frac. Use **double asterisks** to bold step labels (**Step 1:**, **Answer:**) and key words inside each step (the operation, the value being computed, "**1 unit**", subject terms). No other markdown.

For Singapore-primary fraction or ratio word problems where the question gives one fraction of one quantity and another fraction of a *remainder* (e.g. "1/4 of total were X", "2/5 of the remaining were Y"), prefer the **units / model method** rather than algebra: pick a **common number of units** that makes both fractions whole, then express each part of the question in those units. Convert one known quantity into "1 unit = …" then read off the answer. This mirrors the answer-key format teachers use.
${mathHeuristicsBlock(q.examPaper.subject)}

${COMMON_DIAGRAM_RULES}

Respond with ONLY valid JSON (no markdown fences, no surrounding text):
{
  "solution": "<step-by-step working with **bold** as described>",
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
      console.log(`[${i + 1}/${filtered.length}] ${q.examPaper.title} — Q${q.questionNum}  ${q.examPaper.subject ?? "?"}  (${t}s)`);
      console.log(`============================================================`);
      console.log(`STEM: ${(q.transcribedStem ?? "").slice(0, 200)}`);
      if (opts) for (let j = 0; j < opts.length; j++) console.log(`  (${j + 1}) ${opts[j]}`);
      console.log(`ANSWER: ${q.answer}`);
      console.log(`\nELABORATION (${solution.length} chars):`);
      console.log(solution);
      console.log();
    } catch (err) {
      fail++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[${i + 1}/${filtered.length}] FAILED  ${q.examPaper.title} Q${q.questionNum}: ${msg.slice(0, 200)}`);
      const sentinel = JSON.stringify({ __elabError: msg.slice(0, 280), attemptedAt: new Date().toISOString() });
      await prisma.examQuestion.update({ where: { id: q.id }, data: { elaboration: sentinel } });
    }
  }
  console.log(`\nDone. ok=${ok}  failed=${fail}`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
