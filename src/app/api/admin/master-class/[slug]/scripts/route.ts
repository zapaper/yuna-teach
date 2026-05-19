import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/session";
import { isAdmin } from "@/lib/admin";
import { getMasterClass } from "@/data/master-class";
import { serializeSlideScript } from "@/lib/master-class/parse-script";

// GET  /api/admin/master-class/[slug]/scripts
//   → { keyConceptScripts: string[], commonMistakeScripts: string[] }
//   When no DB row exists, seed each script from the YAML slide via
//   serializeSlideScript so the author can start editing in place.
//
// PUT  /api/admin/master-class/[slug]/scripts
//   body: { keyConceptScripts: string[], commonMistakeScripts: string[] }
//   Upserts the MasterClass row. No parsing here — the hydrator and
//   TTS route re-parse on read so the source-of-truth stays plain text.

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

  const row = await prisma.masterClass.findUnique({ where: { slug } });
  const saved = {
    key: (row?.keyConceptScripts as string[] | undefined) ?? [],
    mistake: (row?.commonMistakeScripts as string[] | undefined) ?? [],
  };

  const keyConceptScripts = yaml.keyConcepts.map((s, i) =>
    saved.key[i] !== undefined ? saved.key[i] : serializeSlideScript(s)
  );
  const commonMistakeScripts = yaml.commonMistakes.map((s, i) =>
    saved.mistake[i] !== undefined ? saved.mistake[i] : serializeSlideScript(s)
  );

  return NextResponse.json({ keyConceptScripts, commonMistakeScripts });
}

export async function PUT(req: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const auth = await requireAdmin();
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { slug } = await context.params;
  const yaml = getMasterClass(slug);
  if (!yaml) return NextResponse.json({ error: "Master Class not found" }, { status: 404 });

  const body = await req.json().catch(() => ({})) as {
    keyConceptScripts?: unknown;
    commonMistakeScripts?: unknown;
  };
  const key = Array.isArray(body.keyConceptScripts) ? body.keyConceptScripts.map(String) : [];
  const mistake = Array.isArray(body.commonMistakeScripts) ? body.commonMistakeScripts.map(String) : [];

  await prisma.masterClass.upsert({
    where: { slug },
    create: { slug, keyConceptScripts: key, commonMistakeScripts: mistake },
    update: { keyConceptScripts: key, commonMistakeScripts: mistake },
  });
  return NextResponse.json({ ok: true });
}
