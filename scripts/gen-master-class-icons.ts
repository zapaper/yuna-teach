// One-off generator: ask Gemini to draw a small 200x200 icon for
// each Master Class registered in the registry. Saves PNGs to
// public/master-class-icons/<slug>.png so the list pages can show
// them as <img src="/master-class-icons/<slug>.png">.
//
// Usage:  npx tsx scripts/gen-master-class-icons.ts
//         (optionally) --only <slug>   only regenerate one
//
// Requires GEMINI_API_KEY in .env.

import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { listMasterClasses } from "../src/data/master-class";

const OUT_DIR = path.join(process.cwd(), "public", "master-class-icons");

const PROMPTS: Record<string, string> = {
  "interactions-environment": "A friendly, minimalist flat-design icon for a primary-school Science topic on Interactions within the Environment. Show a small green leafy plant with a yellow sun above and a tiny butterfly. Soft pastel emerald and sky-blue colours, thick rounded shapes, plenty of white space, no text, no human characters. Square 1:1 composition, suitable as a rounded app icon.",
  "patterns": "A friendly, minimalist flat-design icon for a primary-school Math topic on Patterns. Show three growing groups of geometric shapes (small dot, medium dot, large dot OR small square, medium square, big square) arranged in a clean step pattern. Soft pastel violet and orange colours, thick rounded shapes, plenty of white space, no text, no human characters. Square 1:1 composition, suitable as a rounded app icon.",
  "electrical-circuits": "A cute anime / chibi-style flat illustration for a primary-school Science topic on Electrical Systems and Circuits. Show a glowing yellow lightbulb on the left and a coiled copper wire spring with sparkles around it on the right. Soft pastel yellow, sky-blue, and coral colours. Kawaii aesthetic, thick rounded shapes, plenty of white space, no text, no human characters. Square 1:1 composition, suitable as a rounded app icon.",
};

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.error("GEMINI_API_KEY not set"); process.exit(1); }
  const ai = new GoogleGenAI({ apiKey });

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const onlySlug = (() => {
    const idx = process.argv.indexOf("--only");
    return idx >= 0 ? process.argv[idx + 1] : null;
  })();

  const classes = listMasterClasses().filter(c => !onlySlug || c.slug === onlySlug);
  if (classes.length === 0) { console.error("No master classes matched."); process.exit(1); }

  for (const mc of classes) {
    const prompt = PROMPTS[mc.slug] ?? `A minimalist flat-design icon for a primary-school topic called "${mc.title}". Soft pastel colours, rounded shapes, no text, square 1:1 composition.`;
    console.log(`[${mc.slug}] generating…`);
    // Try a few model IDs in order — image-gen model names have
    // churned a lot through preview / GA.
    const candidates = [
      "gemini-2.5-flash-image",
      "gemini-2.0-flash-preview-image-generation",
      "gemini-2.0-flash-exp-image-generation",
    ];
    let res: Awaited<ReturnType<typeof ai.models.generateContent>> | null = null;
    for (const m of candidates) {
      try {
        res = await ai.models.generateContent({
          model: m,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: { responseModalities: ["IMAGE", "TEXT"] },
        });
        console.log(`[${mc.slug}] used model: ${m}`);
        break;
      } catch (e) {
        const msg = (e as Error).message ?? "";
        if (/not found|NOT_FOUND/i.test(msg)) {
          console.log(`[${mc.slug}] ${m} unavailable, trying next…`);
          continue;
        }
        throw e;
      }
    }
    if (!res) {
      console.error(`[${mc.slug}] no image-gen model accepted the request — skipping`);
      continue;
    }
    const parts = res.candidates?.[0]?.content?.parts ?? [];
    const inline = parts.find(p => (p as { inlineData?: { data?: string } }).inlineData?.data);
    const data = (inline as { inlineData?: { data?: string } } | undefined)?.inlineData?.data;
    if (!data) {
      console.error(`[${mc.slug}] no image in response`);
      console.error(JSON.stringify(res, null, 2).slice(0, 1000));
      continue;
    }
    const buf = Buffer.from(data, "base64");
    // Resize to 200x200 PNG so storage stays tiny and the icon
    // renders sharply across devices (use 400 internal for retina).
    const resized = await sharp(buf).resize(400, 400, { fit: "cover" }).png({ quality: 90 }).toBuffer();
    const outPath = path.join(OUT_DIR, `${mc.slug}.png`);
    fs.writeFileSync(outPath, resized);
    console.log(`[${mc.slug}] wrote ${outPath} (${(resized.length / 1024).toFixed(1)} KB)`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
