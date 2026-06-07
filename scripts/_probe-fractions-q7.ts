// Investigate the false-pass on P6 Fractions Q7 — OpenAI awarded 3
// where Gemini (and the human reviewer) awarded 0. Look at the source
// question + student answer + expected, then re-call OpenAI with the
// exact marking-prompt shape used in markQuizPaper so we can see why
// it scored that way.

import { prisma } from "../src/lib/db";
import { runOpenAIFallback } from "../src/lib/openai-fallback";

const SOURCE_PAPER = "cmozc5icr000d11l735uqp939";

async function main() {
  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: SOURCE_PAPER, questionNum: "7" },
    select: {
      id: true, questionNum: true, marksAvailable: true,
      transcribedStem: true, answer: true, studentAnswer: true,
      transcribedSubparts: true,
    },
  });
  if (!q) { console.log("Q7 not found"); return; }
  console.log(`=== Source Q7 ===`);
  console.log(`marksAvailable: ${q.marksAvailable}`);
  console.log(`\nSTEM:\n${q.transcribedStem}`);
  console.log(`\nEXPECTED:\n${q.answer}`);
  console.log(`\nSTUDENT:\n${q.studentAnswer}`);
  console.log(`\nSUBPARTS: ${JSON.stringify(q.transcribedSubparts).slice(0, 300)}`);

  // Reproduce the production prompt's math-answer-first block. If OpenAI
  // awards 3/5 here but 0/5 without it, the cap section is reading as a
  // default rather than a ceiling.
  const mathBlock = `

MATH MARKING — ANSWER-FIRST RULE (IMPORTANT):
For math questions, working is secondary to the final answer:
- If the student's final answer matches the expected answer → award FULL MARKS immediately.
- ONLY when the final answer is WRONG or absent: scan the working steps for partial credit. Award partial marks proportional to marksAvailable if some steps or methods are correct.

⚠️ WRONG-ANSWER CAP (NON-NEGOTIABLE — for math OEQ):
A wrong final answer can NEVER receive full marks. Cap = (marksAvailable − 1) for the part. Within the cap:
  - 2-mark question wrong → MAX 1
  - 3-mark question wrong → MAX 2 (1 if EARLY MISSTEP; 2 ONLY if last-step slip)
  - 4-mark question wrong → MAX 3
  - 5-mark question wrong → MAX 4
- If wrong with no correct working → ZERO.
`;

  const prompt = `You are marking a primary school student's answer. Be concise. Use British English throughout.

Question: ${q.transcribedStem ?? "See image"}
Student's answer (detected from their handwriting): "${q.studentAnswer ?? ""}"
Expected answer: "${q.answer}"
Marks available: ${q.marksAvailable}

ABSOLUTE RULE: The expected answer is GROUND TRUTH. Award marks only based on how well the student's answer matches it.

FINAL ANSWER GOVERNS: If the student's final answer is wrong, the question is wrong unless visible WORKING earns partial credit. "(no working shown)" means ZERO working — mark on the final answer alone. Never recover a correct value from intermediate steps when the final answer is clearly wrong.
${mathBlock}
Return ONLY valid JSON:
{"questionId": "${q.id}", "marksAvailable": ${q.marksAvailable}, "marksAwarded": <number>, "studentAnswer": "${(q.studentAnswer ?? "").replace(/"/g, '\\"').replace(/\n/g, '\\n').slice(0, 500)}", "notes": "<feedback>", "parts": []}`;

  const params = {
    model: "gemini-2.5-flash", // → translated to gpt-4.1-mini
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseMimeType: "application/json", temperature: 0.1 },
  };

  console.log(`\n=== Calling OpenAI ===`);
  const result = await runOpenAIFallback(params, "probe-fractions-q7");
  console.log(`\nRAW (${result.text.length} chars):\n${result.text}`);
  const m = result.text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const parsed = JSON.parse(m[0]);
      console.log(`\nPARSED:`);
      console.log(JSON.stringify(parsed, null, 2));
    } catch (e) { console.log(`PARSE FAILED: ${(e as Error).message}`); }
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
