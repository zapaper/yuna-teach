// GET    /api/essay-coach/[id]  — fetch one attempt (owner-only).
// PATCH  /api/essay-coach/[id]  — same editable fields as admin route.
// DELETE /api/essay-coach/[id]  — remove row + files.
//
// Auth: caller must be the uploader of this attempt (or an admin).
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";
import { COMPO_DIR } from "@/lib/compo-analysis";

async function loadOwned(id: string, userId: string, isAdmin: boolean) {
  const row = await prisma.compoAttempt.findUnique({ where: { id } });
  if (!row) return { row: null as null, status: 404 as const, error: "Not found" };
  if (!isAdmin && row.uploaderId !== userId) {
    return { row: null as null, status: 403 as const, error: "Forbidden" };
  }
  return { row, status: 200 as const };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireSession();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { id } = await params;
  const { row, status, error } = await loadOwned(id, auth.userId, auth.isAdmin);
  if (!row) return NextResponse.json({ error }, { status });
  return NextResponse.json({ row });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireSession();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { id } = await params;
  const owned = await loadOwned(id, auth.userId, auth.isAdmin);
  if (!owned.row) return NextResponse.json({ error: owned.error }, { status: owned.status });

  let body: { label?: unknown; ocrText?: unknown; elevatedDraft?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body OK */ }
  const data: { label?: string | null; ocrText?: string; recommendations?: unknown } = {};
  if ("label" in body) {
    if (body.label === null) data.label = null;
    else if (typeof body.label === "string") {
      const trimmed = body.label.trim();
      data.label = trimmed.length === 0 ? null : trimmed;
    } else {
      return NextResponse.json({ error: "label must be string or null" }, { status: 400 });
    }
  }
  if ("ocrText" in body) {
    if (typeof body.ocrText !== "string") {
      return NextResponse.json({ error: "ocrText must be string" }, { status: 400 });
    }
    data.ocrText = body.ocrText;
  }
  if ("elevatedDraft" in body) {
    if (typeof body.elevatedDraft !== "string") {
      return NextResponse.json({ error: "elevatedDraft must be string" }, { status: 400 });
    }
    const recs = (owned.row.recommendations as Record<string, unknown> | null) ?? {};
    data.recommendations = { ...recs, elevatedDraft: body.elevatedDraft };
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "no editable fields supplied" }, { status: 400 });
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await prisma.compoAttempt.update({ where: { id }, data: data as any });
    return NextResponse.json({ row });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "P2025") return NextResponse.json({ error: "Not found" }, { status: 404 });
    console.error(`[essay-coach:${id}] patch failed:`, err);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireSession();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { id } = await params;
  const owned = await loadOwned(id, auth.userId, auth.isAdmin);
  if (!owned.row) return NextResponse.json({ error: owned.error }, { status: owned.status });

  const dir = path.join(COMPO_DIR, id);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[essay-coach:${id}] file cleanup failed (proceeding with DB delete):`, err);
  }
  try {
    await prisma.compoAttempt.delete({ where: { id } });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "P2025") {
      console.error(`[essay-coach:${id}] db delete failed:`, err);
      return NextResponse.json({ error: "Delete failed" }, { status: 500 });
    }
  }
  return NextResponse.json({ ok: true });
}
