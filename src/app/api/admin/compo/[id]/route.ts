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
