// Shared helpers for master-class icon generation. Used by:
//   - /api/admin/master-class/[slug]/icon  (admin POST trigger)
//   - /api/master-class/[slug]/icon         (public GET, auto-generates
//                                            on 404 with default prompt)

import { GoogleGenAI } from "@google/genai";
import { promises as fs } from "fs";
import * as path from "path";
import sharp from "sharp";
import { prisma } from "./db";

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
export const ICON_DIR = path.join(VOLUME_PATH, "master-class-icons");

// Image-gen model names have churned through preview / GA tiers — try
// the most specific first and fall back. Same list both routes use.
const IMAGE_MODELS = [
  "gemini-2.5-flash-image",
  "gemini-2.0-flash-preview-image-generation",
  "gemini-2.0-flash-exp-image-generation",
];

export function defaultIconPromptFor(title: string, subject: string): string {
  return `A cute anime / chibi-style flat illustration for a primary-school ${subject} topic on ${title}. Vibrant pastel colours, soft cel-shading, kawaii aesthetic, rounded shapes, plenty of white space, no text, no human characters with text on them. Square 1:1 composition, suitable as a rounded app icon.`;
}

// Cross-request lock so multiple simultaneous misses on a fresh class
// don't fire N parallel Gemini image-gen calls. Node serves Next.js
// from a single process, so this is a real lock.
const generationInFlight = new Map<string, Promise<Buffer>>();

export async function generateAndStoreIcon(slug: string, prompt: string): Promise<Buffer> {
  // De-dupe: if a generation for this slug is already in flight, wait
  // on that promise instead of starting a fresh one.
  const existing = generationInFlight.get(slug);
  if (existing) return existing;

  const job = (async () => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not set");

    const ai = new GoogleGenAI({ apiKey });
    let inlineDataB64: string | null = null;
    let usedModel: string | null = null;
    let lastErr: string | null = null;
    for (const m of IMAGE_MODELS) {
      try {
        const res = await ai.models.generateContent({
          model: m,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: { responseModalities: ["IMAGE", "TEXT"] },
        });
        const parts = res.candidates?.[0]?.content?.parts ?? [];
        const inline = parts.find(p => (p as { inlineData?: { data?: string } }).inlineData?.data);
        const data = (inline as { inlineData?: { data?: string } } | undefined)?.inlineData?.data;
        if (data) { inlineDataB64 = data; usedModel = m; break; }
        lastErr = `Model ${m} returned no image`;
      } catch (e) {
        const msg = (e as Error).message ?? "";
        lastErr = `${m}: ${msg.slice(0, 200)}`;
        if (!/not found|NOT_FOUND/i.test(msg)) break;
      }
    }
    if (!inlineDataB64) throw new Error(lastErr ?? "No model accepted the image request");

    const raw = Buffer.from(inlineDataB64, "base64");
    // 400×400 PNG so storage + bandwidth stay tiny while still looking
    // sharp on retina at 112 px.
    const resized = await sharp(raw).resize(400, 400, { fit: "cover" }).png({ quality: 90 }).toBuffer();
    await fs.mkdir(ICON_DIR, { recursive: true });
    await fs.writeFile(path.join(ICON_DIR, `${slug}.png`), resized);

    // Persist the prompt so the admin editor pre-fills and so a future
    // re-gen knows what was used.
    await prisma.masterClass.upsert({
      where: { slug },
      create: { slug, iconPrompt: prompt },
      update: { iconPrompt: prompt },
    }).catch(() => { /* non-fatal — file is already written */ });

    console.log(`[master-class-icon] generated ${slug} (${resized.length} bytes via ${usedModel})`);
    return resized;
  })();

  generationInFlight.set(slug, job);
  try { return await job; }
  finally { generationInFlight.delete(slug); }
}
