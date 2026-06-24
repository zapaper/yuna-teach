// GET    /api/admin/compo/[id] — fetch single attempt with all fields.
// DELETE /api/admin/compo/[id] — remove the row AND its uploaded files
//                                from the Railway volume. Idempotent.
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";
import { COMPO_DIR } from "@/lib/compo-analysis";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const row = await prisma.compoAttempt.findUnique({ where: { id } });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ row });
}

// PATCH /api/admin/compo/[id] — update mutable metadata (currently
// just the human label). Body: { label?: string | null }. Trims
// strings, accepts null/empty to clear back to '(no label)'.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  let body: { label?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body OK */ }
  const data: { label?: string | null } = {};
  if ("label" in body) {
    if (body.label === null) data.label = null;
    else if (typeof body.label === "string") {
      const trimmed = body.label.trim();
      data.label = trimmed.length === 0 ? null : trimmed;
    } else {
      return NextResponse.json({ error: "label must be string or null" }, { status: 400 });
    }
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "no editable fields supplied" }, { status: 400 });
  }
  try {
    const row = await prisma.compoAttempt.update({ where: { id }, data });
    return NextResponse.json({ row });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "P2025") return NextResponse.json({ error: "Not found" }, { status: 404 });
    console.error(`[compo:${id}] patch failed:`, err);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  // Best-effort file cleanup: a delete request on a row that's
  // already gone is treated as success (idempotent). Removal of
  // the on-disk folder is also best-effort — if the volume is down
  // or the folder never existed, we still return ok and let the
  // DB row removal carry the contract.
  const dir = path.join(COMPO_DIR, id);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    console.warn(`[compo:${id}] file cleanup failed (proceeding with DB delete):`, err);
  }
  try {
    await prisma.compoAttempt.delete({ where: { id } });
  } catch (err) {
    // Already-deleted rows throw P2025; swallow and report ok.
    const code = (err as { code?: string }).code;
    if (code !== "P2025") {
      console.error(`[compo:${id}] db delete failed:`, err);
      return NextResponse.json({ error: "Delete failed" }, { status: 500 });
    }
  }
  return NextResponse.json({ ok: true });
}
