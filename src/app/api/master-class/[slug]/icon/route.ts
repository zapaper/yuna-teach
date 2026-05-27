import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import * as path from "path";
import { getMasterClass } from "@/data/master-class";
import { prisma } from "@/lib/db";
import { defaultIconPromptFor, generateAndStoreIcon } from "@/lib/master-class-icon";

// GET /api/master-class/[slug]/icon
// Streams the class icon PNG. Resolution order:
//   1. Admin-regenerated copy at VOLUME_PATH/master-class-icons/<slug>.png
//   2. Bundled fallback at public/master-class-icons/<slug>.png
//   3. AUTO-GENERATE — if a registered master class has no icon yet,
//      kick off generation with the saved iconPrompt (or a default
//      based on title + subject) and serve the result. First load on
//      a new class takes ~5-10s; subsequent loads hit the cache.
//
// Cache: 5-minute browser cache.

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const VOLUME_ICON_DIR = path.join(VOLUME_PATH, "master-class-icons");
const BUNDLED_ICON_DIR = path.join(process.cwd(), "public", "master-class-icons");

function pngResponse(buf: Buffer): NextResponse {
  return new NextResponse(buf as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=300",
    },
  });
}

export async function GET(_req: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  // sanitise slug: only lowercase letters / digits / hyphen — protects
  // against ../ path-traversal attempts.
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
  }

  const volumePath = path.join(VOLUME_ICON_DIR, `${slug}.png`);
  const bundledPath = path.join(BUNDLED_ICON_DIR, `${slug}.png`);

  for (const p of [volumePath, bundledPath]) {
    try {
      const buf = await fs.readFile(p);
      return pngResponse(buf);
    } catch { /* try next */ }
  }

  // Auto-generate on first miss — only for registered master classes.
  const yaml = getMasterClass(slug);
  if (!yaml) {
    return NextResponse.json({ error: "Icon not found" }, { status: 404 });
  }
  try {
    const row = await prisma.masterClass.findUnique({ where: { slug }, select: { iconPrompt: true } });
    const prompt = row?.iconPrompt ?? defaultIconPromptFor(yaml.title, yaml.subject);
    console.log(`[master-class-icon] auto-generating for ${slug} (no icon on disk)`);
    const buf = await generateAndStoreIcon(slug, prompt);
    return pngResponse(buf);
  } catch (e) {
    console.error(`[master-class-icon] auto-generate failed for ${slug}: ${(e as Error).message}`);
    return NextResponse.json({ error: "Icon not found and auto-generation failed" }, { status: 502 });
  }
}
