// Batch-generate class icons for master classes that don't yet have one.
//
// Mirrors the logic in src/app/api/admin/master-class/[slug]/icon/route.ts —
// uses Gemini image-gen with the default prompt for each class, resizes to
// 400×400 PNG, writes to VOLUME_PATH/master-class-icons/<slug>.png, and
// persists the prompt to MasterClass.iconPrompt.

import * as fs from "fs/promises";
import * as path from "path";
import sharp from "sharp";
import { GoogleGenAI } from "@google/genai";
import { prisma } from "../src/lib/db";
import { listMasterClasses } from "../src/data/master-class";

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const ICON_DIR = path.join(VOLUME_PATH, "master-class-icons");

const IMAGE_MODELS = ["gemini-2.5-flash-image", "imagen-3.0-generate-002"];

function defaultPromptFor(title: string, subject: string): string {
  return `A cute anime / chibi-style flat illustration for a primary-school ${subject} topic on ${title}. Vibrant pastel colours, soft cel-shading, kawaii aesthetic, rounded shapes, plenty of white space, no text, no human characters with text on them. Square 1:1 composition, suitable as a rounded app icon.`;
}

async function generateIcon(slug: string, title: string, subject: string): Promise<{ ok: true; bytes: number; model: string } | { ok: false; error: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, error: "GEMINI_API_KEY not set" };

  const ai = new GoogleGenAI({ apiKey });
  const prompt = defaultPromptFor(title, subject);

  let inlineDataB64: string | null = null;
  let usedModel: string | null = null;
  let lastErr = "";
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
      lastErr = `Model ${m}: no image returned`;
    } catch (e) {
      const msg = (e as Error).message ?? "";
      lastErr = `${m}: ${msg.slice(0, 200)}`;
      if (!/not found|NOT_FOUND/i.test(msg)) break;
    }
  }
  if (!inlineDataB64) return { ok: false, error: lastErr };

  const buf = Buffer.from(inlineDataB64, "base64");
  const resized = await sharp(buf).resize(400, 400, { fit: "cover" }).png({ quality: 90 }).toBuffer();
  await fs.mkdir(ICON_DIR, { recursive: true });
  await fs.writeFile(path.join(ICON_DIR, `${slug}.png`), resized);

  await prisma.masterClass.upsert({
    where: { slug },
    create: { slug, iconPrompt: prompt },
    update: { iconPrompt: prompt },
  });

  return { ok: true, bytes: resized.length, model: usedModel! };
}

(async () => {
  // Optionally filter by CLI args (specific slugs)
  const filterSlugs = process.argv.slice(2).filter(a => /^[a-z-]+$/.test(a));
  const all = listMasterClasses();
  const classes = filterSlugs.length > 0 ? all.filter(c => filterSlugs.includes(c.slug)) : all;

  await fs.mkdir(ICON_DIR, { recursive: true });

  console.log(`Generating icons for ${classes.length} master classes:\n`);
  let ok = 0, skipped = 0, failed = 0;
  for (const c of classes) {
    const iconPath = path.join(ICON_DIR, `${c.slug}.png`);
    try {
      await fs.access(iconPath);
      console.log(`  ${c.slug}: SKIP (icon already exists at ${iconPath})`);
      skipped++;
      continue;
    } catch { /* not exist — generate */ }

    process.stdout.write(`  ${c.slug} (${c.title})... `);
    const r = await generateIcon(c.slug, c.title, c.subject);
    if (r.ok) {
      console.log(`✓ ${r.bytes} bytes via ${r.model}`);
      ok++;
    } else {
      console.log(`✗ ${r.error}`);
      failed++;
    }
  }
  console.log(`\nDone. ${ok} generated, ${skipped} skipped (already exist), ${failed} failed.`);
  await prisma.$disconnect();
})();
