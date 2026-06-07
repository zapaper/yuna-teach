// Generate a correct-vs-wrong bulb wiring diagram for the
// Electrical Circuits master class. Exactly TWO wires per bulb —
// no label arrows that could be confused for wires.
//   CORRECT: one wire at the side (screw thread), one at the bottom tip.
//   WRONG:   both wires at the side (screw thread).
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";

const PROMPT = `Create a clean educational diagram for a Singapore primary-school Science textbook showing TWO identical light bulbs side by side comparing how wires connect to a bulb.

Both bulbs are drawn the same: round glass envelope on top with a small filament squiggle, then a clearly drawn ribbed/threaded metal SCREW BASE in the middle, then a small ROUND BOTTOM METAL TIP at the very bottom (a small dark dot/circle), with a thin dark insulating ring separating the screw thread from the bottom tip.

Style: clean black-line drawing on white background. No 3D shading. Sans-serif English labels only — DO NOT use Chinese or any non-Latin script.

LEFT BULB — header "✓ CORRECT" in bold green at the top, with a large green tick:
  - Exactly TWO blue wires.
  - WIRE 1 comes from the LEFT side of the diagram, traces horizontally inward, and TOUCHES the SIDE of the SCREW THREAD (the ribbed barrel in the middle of the bulb). Clear contact dot ON THE SIDE OF THE THREAD, ROUGHLY AT THE BULB'S MID-HEIGHT.
  - WIRE 2 comes from below the bulb, going straight up, and TOUCHES the BOTTOM METAL TIP (the small dot at the very bottom). Clear contact dot at the tip.
  - The two contact dots are at clearly DIFFERENT heights — one at the SIDE (middle), one at the BOTTOM (lowest point of the bulb).

RIGHT BULB — header "✗ WRONG" in bold red at the top, with a large red cross:
  - Exactly TWO blue wires.
  - WIRE 1 comes from the LEFT side of the diagram, traces horizontally inward, and TERMINATES on the LEFT-HAND side of the RIBBED METAL SCREW THREAD (the threaded barrel in the MIDDLE of the bulb, NOT the glass ball on top). Clear contact dot ON the screw thread, ROUGHLY AT MID-HEIGHT of the screw thread.
  - WIRE 2 comes from the RIGHT side of the diagram, traces horizontally inward, and TERMINATES on the RIGHT-HAND side of the RIBBED METAL SCREW THREAD (same threaded barrel, opposite side). Clear contact dot ON the screw thread, at the same mid-height as Wire 1.
  - BOTH contact dots sit on the RIBBED METAL part — the part that looks like a screw or a stack of small ridges. NEITHER wire goes anywhere near the round glass envelope above. The BOTTOM METAL TIP has NO wire touching it.

ABSOLUTE CONSTRAINTS (must follow exactly):
  1. EACH bulb has EXACTLY 2 BLUE WIRES — no extra wires, no third wire, no label-arrows that look like wires.
  2. NO arrow lines coming from labels to bulb parts. Just plain text labels at the bottom if needed.
  3. NO wire touches the GLASS ENVELOPE (the round transparent ball on top) — on EITHER bulb. Wires only touch the METAL parts (ribbed screw thread or bottom tip).
  4. CORRECT bulb: ONE wire on the ribbed-thread SIDE + ONE wire on the BOTTOM TIP. Two different contacts.
  5. WRONG bulb: BOTH wires on the ribbed-thread SIDE (one left, one right). Same contact, opposite sides. NO wire on the bottom tip. NO wire on the glass.

Composition: landscape orientation, lots of whitespace, very clean. A small bottom caption in plain English: "A bulb only lights when current flows through BOTH metal contacts."`;

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error("GEMINI_API_KEY not set"); process.exit(1); }
  const ai = new GoogleGenAI({ apiKey });
  const candidates = ["gemini-2.5-flash-image", "gemini-2.0-flash-preview-image-generation", "gemini-2.0-flash-exp-image-generation"];
  let res: Awaited<ReturnType<typeof ai.models.generateContent>> | null = null;
  for (const m of candidates) {
    try {
      res = await ai.models.generateContent({
        model: m,
        contents: [{ role: "user", parts: [{ text: PROMPT }] }],
        config: { responseModalities: ["IMAGE", "TEXT"] },
      });
      console.log(`Generated with model: ${m}`);
      break;
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (/not found|NOT_FOUND/i.test(msg)) continue;
      throw e;
    }
  }
  if (!res) { console.error("No model accepted the request"); process.exit(1); }
  const parts = res.candidates?.[0]?.content?.parts ?? [];
  const inline = parts.find(p => (p as { inlineData?: { data?: string } }).inlineData?.data);
  const data = (inline as { inlineData?: { data?: string } } | undefined)?.inlineData?.data;
  if (!data) { console.error("No image in response"); process.exit(1); }
  const buf = Buffer.from(data, "base64");
  const meta = await sharp(buf).metadata();
  const longSide = Math.max(meta.width ?? 0, meta.height ?? 0);
  const resized = longSide > 1200
    ? await sharp(buf).resize({ width: longSide === meta.width ? 1200 : undefined, height: longSide === meta.height ? 1200 : undefined }).png({ quality: 92 }).toBuffer()
    : await sharp(buf).png({ quality: 92 }).toBuffer();
  const outDir = path.join(process.cwd(), "public", "master-class", "circuits");
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, "bulb-contact-points.png");
  fs.writeFileSync(out, resized);
  console.log(`Wrote ${out}  (${(resized.length / 1024).toFixed(1)} KB)`);
}

main().catch(e => { console.error(e); process.exit(1); });
