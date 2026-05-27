import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/session";
import { isAdmin } from "@/lib/admin";
import { getMasterClass } from "@/data/master-class";
import { defaultIconPromptFor, generateAndStoreIcon } from "@/lib/master-class-icon";

// POST /api/admin/master-class/[slug]/icon
//   body: { prompt: string }
// Calls Gemini to regenerate the class icon. Persists the new PNG to
// VOLUME_PATH/master-class-icons/<slug>.png and saves the prompt to
// MasterClass.iconPrompt so future loads can pre-fill the editor.
//
// GET  /api/admin/master-class/[slug]/icon
//   Returns { prompt: string | null, defaultPrompt: string } so the
//   admin workshop can pre-fill its prompt textarea on first load.

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
    defaultPrompt: defaultIconPromptFor(yaml.title, yaml.subject),
  });
}

export async function POST(req: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const auth = await requireAdmin();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { slug } = await context.params;
  const yaml = getMasterClass(slug);
  if (!yaml) return NextResponse.json({ error: "Master Class not found" }, { status: 404 });

  const body = await req.json().catch(() => ({})) as { prompt?: string };
  const prompt = (body.prompt ?? "").trim();
  if (!prompt) return NextResponse.json({ error: "prompt required" }, { status: 400 });

  try {
    const buf = await generateAndStoreIcon(slug, prompt);
    return NextResponse.json({ ok: true, bytes: buf.length });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
