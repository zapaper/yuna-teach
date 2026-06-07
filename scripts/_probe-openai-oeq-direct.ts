// Direct probe — call OpenAI with a real OEQ marking prompt and print the
// raw response text. We need to see whether OpenAI's JSON shape parses
// the same way as Gemini's, or whether the response format diverges in
// some way that breaks markQuizPaper's parser.
//
// Pulls one OEQ from a known eval clone, builds the minimal marking
// prompt, calls runOpenAIFallback, prints raw text + parse attempt.

import { prisma } from "../src/lib/db";
import { runOpenAIFallback } from "../src/lib/openai-fallback";

const CLONE_ID_PREFIX = "cmptee7xd"; // P4 Focused: Geometry — all-math, no images needed

async function main() {
  const paper = await prisma.examPaper.findFirst({
    where: { id: { startsWith: CLONE_ID_PREFIX } },
    select: { id: true, title: true },
  });
  if (!paper) { console.log("no paper"); return; }
  console.log(`paper: ${paper.title} (${paper.id})`);

  // Pick one OEQ with a clean text-only structure.
  const qs = await prisma.examQuestion.findMany({
    where: { examPaperId: paper.id },
    orderBy: { orderIndex: "asc" },
    select: {
      id: true, questionNum: true, marksAvailable: true,
      transcribedStem: true, answer: true, studentAnswer: true,
    },
  });

  // Q7 is a 2-mark angle question with a clear student answer.
  const q = qs.find(x => x.questionNum === "7") ?? qs[1];
  console.log(`\nQ${q.questionNum} (${q.marksAvailable}m)`);
  console.log(`  stem: ${(q.transcribedStem ?? "").slice(0, 200)}`);
  console.log(`  expected: ${q.answer}`);
  console.log(`  student: ${(q.studentAnswer ?? "").slice(0, 200)}`);

  // Build a minimal marking prompt — just enough to drive the JSON return.
  // Mirror the shape of markQuizPaper's prompt (system rules + JSON schema).
  const prompt = `You are marking a primary school student's answer. Be concise.

Question: ${q.transcribedStem ?? "See image"}
Student's answer: "${q.studentAnswer ?? ""}"
Expected answer: "${q.answer}"
Marks available: ${q.marksAvailable}

Return ONLY valid JSON in this exact shape:
{"questionId": "${q.id}", "marksAvailable": ${q.marksAvailable}, "marksAwarded": <number 0..${q.marksAvailable}>, "studentAnswer": "${(q.studentAnswer ?? "").replace(/"/g, '\\"').replace(/\n/g, '\\n').slice(0, 500)}", "notes": "<short feedback>", "parts": []}`;

  // Build params in the Gemini-shape that runOpenAIFallback expects.
  const params = {
    model: "gemini-2.5-flash",
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseMimeType: "application/json", temperature: 0.1 },
  };

  console.log(`\n--- calling OpenAI (gpt-5-mini via runOpenAIFallback) ---`);
  try {
    const result = await runOpenAIFallback(params, `probe-q${q.questionNum}`);
    console.log(`\n--- RAW RESPONSE (${result.text.length} chars) ---`);
    console.log(result.text);
    console.log(`\n--- PARSE ATTEMPT ---`);
    const m = result.text.match(/\{[\s\S]*\}/);
    if (!m) {
      console.log(`NO JSON FOUND in response`);
    } else {
      try {
        const parsed = JSON.parse(m[0]);
        console.log(`PARSED OK:`);
        console.log(JSON.stringify(parsed, null, 2));
      } catch (e) {
        console.log(`PARSE FAILED:`, (e as Error).message);
      }
    }
  } catch (err) {
    console.log(`\n--- OPENAI CALL THREW ---`);
    console.log(err);
    if (err instanceof Error) {
      console.log(`message: ${err.message}`);
      console.log(`name: ${err.name}`);
    }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
