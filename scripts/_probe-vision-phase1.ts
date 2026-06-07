// Direct probe — give gpt-5 and gpt-4.1-mini the same student-answer
// image with the same Phase 1 prompt and dump the raw responses.
// Lets us see whether gpt-5 returns "TRANSCRIPTION: EMPTY" / blank,
// or returns content that our parser then drops.

import { promises as fs } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";
import OpenAI from "openai";
void prisma;

const PROMPT = `Read the student's handwritten answer from the image above. The image shows the student's answer area for one part of a science question. There may be blue ink with their working and final answer.

ANTI-HALLUCINATION: You are a TRANSCRIBER, not a solver. Copy what the student wrote in BLUE INK on the image. Do NOT invent working, do NOT auto-correct, do NOT add labels not present.

OUTPUT FORMAT — MANDATORY:
Your response MUST start with EXACTLY these two lines (in this order, no quotes, no markdown):

HANDWRITING: PRESENT|ABSENT
TRANSCRIPTION: FOUND|EMPTY

HANDWRITING: PRESENT — any ink/marks visible (even ONE stroke).
HANDWRITING: ABSENT — canvas truly blank, no ink anywhere.

TRANSCRIPTION: FOUND — you read at least one digit/letter/word/shape. Transcribe it on lines below.
TRANSCRIPTION: EMPTY — you see ink but cannot interpret it as text or a recognisable shape.

After the two header lines, transcribe what you see line-by-line:
  Working: <each line of working, separated by line breaks>
  Final answer: <the answer near the "Ans:" line or the clearly-stated final value>

If the student wrote ONLY a final answer with no working, report:
  Working: (no working shown)
  Final answer: <value>`;

const IMAGES = [
  { label: "Q6(a) page_0_a_ink (the actual student ink)", path: ".data/submissions/cmpugyxqd003t9xawuc7rkgbx/page_0_a_ink.png" },
  { label: "Q6(a) page_0_a (the cropped subpart region with question + ink)", path: ".data/submissions/cmpugyxqd003t9xawuc7rkgbx/page_0_a.jpg" },
];

const MODELS = ["gpt-4.1-mini", "gpt-5"];

async function main() {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY!, timeout: 90_000 });

  for (const img of IMAGES) {
    const abs = path.resolve(img.path);
    let buf: Buffer;
    try { buf = await fs.readFile(abs); }
    catch { console.log(`(missing) ${img.path}`); continue; }
    const mime = img.path.endsWith(".png") ? "image/png" : "image/jpeg";
    const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
    console.log(`\n========== ${img.label} (${(buf.length / 1024).toFixed(1)} KB) ==========`);

    for (const model of MODELS) {
      try {
        const start = Date.now();
        const acceptsTemp = !/^gpt-5(?:-mini)?$/.test(model);
        const resp = await client.chat.completions.create({
          model,
          messages: [{
            role: "user",
            content: [
              { type: "image_url" as const, image_url: { url: dataUrl } },
              { type: "text" as const, text: PROMPT },
            ],
          }],
          ...(acceptsTemp ? { temperature: 0.1 } : {}),
        });
        const text = resp.choices[0]?.message?.content ?? "";
        console.log(`\n--- ${model} (${Date.now() - start}ms, ${text.length} chars) ---`);
        console.log(text || "(empty response)");
      } catch (err) {
        const e = err as { status?: number; message?: string };
        console.log(`\n--- ${model} ERROR ${e.status ?? "?"}: ${(e.message ?? "").slice(0, 200)}`);
      }
    }
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
