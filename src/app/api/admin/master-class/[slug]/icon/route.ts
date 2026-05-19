import { NextRequest, NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { promises as fs } from "fs";
import * as path from "path";
import sharp from "sharp";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/session";
import { isAdmin } from "@/lib/admin";
import { getMasterClass } from "@/data/master-class";

// POST /api/admin/master-class/[slug]/icon
//   body: { prompt: string }
// Calls Gemini to regenerate the class icon. Persists the new PNG to
// VOLUME_PATH/master-class-icons/<slug>.png and saves the prompt to
// MasterClass.iconPrompt so future loads can pre-fill the editor.
//
// GET  /api/admin/master-class/[slug]/icon
//   Returns { prompt: string | null, defaultPrompt: string } so the
//   admin workshop can pre-fill its prompt textarea on first load.

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const ICON_DIR = path.join(VOLUME_PATH, "master-class-icons");

// Model fallback list — image-gen names have churned through preview
// and GA tiers; try the most specific first.
const IMAGE_MODELS = [
  "gemini-2.5-flash-image",
  "gemini-2.0-flash-preview-image-generation",
  "gemini-2.0-flash-exp-image-generation",
];

function defaultPromptFor(title: string, subject: string): string {
  return `A cute anime / chibi-style flat illustration for a primary-school ${subject} topic on ${title}. Vibrant pastel colours, soft cel-shading, kawaii aesthetic, rounded shapes, plenty of white space, no text, no human characters with text on them. Square 1:1 composition, suitable as a rounded app icon.`;
}

async function requireAdmin() {
  const sessionUserId = await getSessionUserId();
  if (!sessionUserId) return { error: "Unauthorized", status: 401 as const };
  const me = await prisma.user.findUnique({
    where: { id: sessionUserId },
    select: { name: true, settings: true },
  });
  if (!isAdmin(me)) return { error: "Forbidden", status: 403 as const };
  return { ok: true as const };
}

export async function GET(_req: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const auth = await requireAdmin();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { slug } = await context.params;
  const yaml = getMasterClass(slug);
  if (!yaml) return NextResponse.json({ error: "Master Class not found" }, { status: 404 });
  const row = await prisma.masterClass.findUnique({ where: { slug }, select: { iconPrompt: true } });
  return NextResponse.json({
    prompt: row?.iconPrompt ?? null,
    defaultPrompt: defaultPromptFor(yaml.title, yaml.subject),
  });
}

export async function POST(req: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const auth = await requireAdmin();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "GEMINI_API_KEY not set" }, { status: 500 });

  const { slug } = await context.params;
  const yaml = getMasterClass(slug);
  if (!yaml) return NextResponse.json({ error: "Master Class not found" }, { status: 404 });

  const body = await req.json().catch(() => ({})) as { prompt?: string };
  const prompt = (body.prompt ?? "").trim();
  if (!prompt) return NextResponse.json({ error: "prompt required" }, { status: 400 });

  const ai = new GoogleGenAI({ apiKey });

  // Try each candidate model until one accepts the request.
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
      if (data) {
        inlineDataB64 = data;
        usedModel = m;
        break;
      }
      lastErr = `Model ${m} returned no image`;
    } catch (e) {
      const msg = (e as Error).message ?? "";
      lastErr = `${m}: ${msg.slice(0, 200)}`;
      if (!/not found|NOT_FOUND/i.test(msg)) {
        // a real error, not just an unavailable model — stop trying
        break;
      }
    }
  }
  if (!inlineDataB64) {
    return NextResponse.json({ error: lastErr ?? "No model accepted the image request" }, { status: 502 });
  }

  // Resize to a square 400x400 PNG so storage + bandwidth stay tiny
  // while still looking sharp on retina displays at 112px.
  const buf = Buffer.from(inlineDataB64, "base64");
  const resized = await sharp(buf).resize(400, 400, { fit: "cover" }).png({ quality: 90 }).toBuffer();
  await fs.mkdir(ICON_DIR, { recursive: true });
  const outPath = path.join(ICON_DIR, `${slug}.png`);
  await fs.writeFile(outPath, resized);

  // Persist the prompt so the editor can pre-fill next time.
  await prisma.masterClass.upsert({
    where: { slug },
    create: { slug, iconPrompt: prompt },
    update: { iconPrompt: prompt },
  });

  return NextResponse.json({ ok: true, model: usedModel, bytes: resized.length });
}
