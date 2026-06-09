// Test the candidate Science-MCQ elaborate prompt against specific
// questions. Runs Gemini directly with the proposed prompt change
// ("transcribe each labelled statement A-D verbatim before reasoning")
// so we can see whether the model now reads the in-diagram labels
// correctly instead of paraphrasing from training data.
//
// Usage:
//   DATABASE_URL=... npx tsx scripts/_test-elab-prompt.ts <paperId>:<questionNum> [...]

import { prisma } from "../src/lib/db";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? "" });

// Decode raw base64 / data-url to inline part for Gemini.
function toInlinePart(raw: string): { inlineData: { mimeType: string; data: string } } | null {
  const m = raw.match(/^data:image\/(\w+);base64,(.+)$/);
  if (m) return { inlineData: { mimeType: `image/${m[1] === "jpeg" ? "jpeg" : m[1]}`, data: m[2] } };
  if (raw.startsWith("/9j/")) return { inlineData: { mimeType: "image/jpeg", data: raw } };
  if (raw.startsWith("iVBORw0KGgo")) return { inlineData: { mimeType: "image/png", data: raw } };
  return null;
}

(async () => {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error("usage: _test-elab-prompt.ts <paperId>:<questionNum> [...]");
    process.exit(1);
  }

  for (const t of targets) {
    const [paperId, qNum] = t.split(":");
    if (!paperId || !qNum) { console.error(`bad arg ${t}`); continue; }

    const q = await prisma.examQuestion.findFirst({
      where: { examPaperId: paperId, questionNum: qNum },
      select: {
        questionNum: true,
        transcribedStem: true,
        transcribedOptions: true,
        transcribedSubparts: true,
        answer: true,
        imageData: true,
        diagramImageData: true,
        examPaper: { select: { subject: true } },
      },
    });
    if (!q) { console.error(`${t}: question not found`); continue; }

    console.log(`\n=================== ${t} ===================`);
    console.log(`subject=${q.examPaper.subject} answerKey=${q.answer}`);
    console.log(`stem: ${q.transcribedStem ?? "(none)"}`);
    const opts = q.transcribedOptions as string[] | null;
    if (opts) console.log(`options: ${opts.map((o, i) => `(${i+1}) ${o}`).join(" | ")}`);

    let questionText = q.transcribedStem ?? `Question ${q.questionNum}`;
    if (opts && opts.length > 0) {
      questionText += "\n" + opts.map((o, i) => `(${i + 1}) ${o}`).join("\n");
    }
    const subs = q.transcribedSubparts as { label: string; text: string }[] | null;
    if (subs && subs.length > 0) {
      questionText += "\n" + subs.filter(s => s.label !== "_drawable").map(s => `(${s.label}) ${s.text}`).join("\n");
    }

    // ── CANDIDATE PROMPT ──
    // The new bit is the LETTER-SET DETECTION + VERBATIM-TRANSCRIPTION
    // block. Everything else mirrors the live elaborate-mcq prompt.
    const answerAnchor =
      `**The answer is ${q.answer ?? "Not provided"} — this is the official answer key and is authoritative.** ` +
      `The question contains a diagram which may be hard to read precisely from the image alone — when in doubt, ` +
      `trust the answer key over your reading of the diagram and work backwards to justify it. Your explanation ` +
      `MUST arrive at this answer.`;

    const letterSetRule = `
LABELLED-ITEM MCQ — CRITICAL:
If the options are letter-set references (e.g. "A, B and C only", "B, C and D only", "II, III only"), the labelled
items A, B, C, D (or I, II, III…) live as printed text ON the diagram, NOT in the text portion of this prompt.
Before reasoning, do TWO things in order:
  1. Transcribe each labelled item VERBATIM from the image. Output as:
       Statement A: "<exact text>"
       Statement B: "<exact text>"
       …
     If you cannot read a label, write "Statement X: (unreadable)" — do NOT paraphrase or invent text.
  2. Then verify EACH labelled statement TRUE or FALSE against the diagram / data table, citing the specific
     row, column, or feature you used.
  3. ONLY after steps 1 and 2 may you write the final "Step 1 / Step 2 / Answer" explanation.

If the options are NOT letter-set references (numeric / single value / direct answer), skip these steps.`;

    const prompt = `You are a helpful tutor for a primary school student.

Here is the question:
${questionText}

${answerAnchor}
${letterSetRule}

Go straight into the correct answer and provide a clear step-by-step explanation of how to solve it.

Keep the "solution" tight: aim for 200 words, hard cap at 250 (raised for letter-set questions so the verbatim
transcription fits). Age-appropriate, plain language. Use **double asterisks** to bold step labels and key terms.

Respond with ONLY valid JSON: { "solution": "<text>", "diagrams": [] }`;

    const parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[] = [];
    // Send BOTH images for Science (matches the new live behaviour).
    const subjectLc = (q.examPaper.subject ?? "").toLowerCase();
    const isScience = subjectLc.includes("science");
    if (q.diagramImageData) {
      const p = toInlinePart(q.diagramImageData);
      if (p) parts.push(p);
    }
    if ((isScience || !q.diagramImageData) && q.imageData) {
      const p = toInlinePart(q.imageData);
      if (p) parts.push(p);
    }
    parts.push({ text: prompt });

    console.log(`\nSending ${parts.length - 1} image(s) + prompt to gemini-3.1-pro-preview…`);
    const t0 = Date.now();
    try {
      const resp = await ai.models.generateContent({
        model: "gemini-3.1-pro-preview",
        contents: [{ role: "user", parts }],
      });
      const text = resp.text ?? "";
      console.log(`(${Date.now() - t0} ms)\n`);
      // Pretty-print the solution string from the JSON.
      const m = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
      const cleaned = m ? m[1] : text;
      try {
        const j = JSON.parse(cleaned) as { solution?: string };
        if (j.solution) {
          console.log("=== SOLUTION ===");
          console.log(j.solution);
        } else {
          console.log("(no `solution` field in response, raw text:)");
          console.log(text);
        }
      } catch {
        console.log("(not JSON, raw text:)");
        console.log(text);
      }
    } catch (err) {
      console.error(`FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
