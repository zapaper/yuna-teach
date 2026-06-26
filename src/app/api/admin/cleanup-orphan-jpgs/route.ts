// Admin-only cleanup of orphan submission JPG directories on the
// Railway volume. Created because the standalone CLI script
// (scripts/_delete-orphan-submission-jpgs.ts) can't run from local
// — postgres.railway.internal isn't reachable from outside Railway,
// and /data is Railway's volume mount that doesn't exist on dev
// machines. Trigger this endpoint instead; it runs on the Railway
// container where both the DB and the volume are real.
//
//   GET  /api/admin/cleanup-orphan-jpgs              → dry run, list orphans
//   POST /api/admin/cleanup-orphan-jpgs?apply=1      → perform delete
//
// Safety:
//   · Admin-only (isSessionAdmin).
//   · Only deletes directories DIRECTLY under VOLUME_PATH/submissions/
//     whose name is a paperId NOT present in ExamPaper. Active papers
//     are never touched.
//   · Dry-run by default — must pass ?apply=1 on POST to delete.

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const SUBMISSIONS_DIR = path.join(VOLUME_PATH, "submissions");

async function findOrphans(): Promise<{ allDirs: number; orphans: string[] }> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(SUBMISSIONS_DIR);
  } catch (err) {
    throw new Error(`Could not read ${SUBMISSIONS_DIR}: ${(err as Error).message}`);
  }
  const dirNames: string[] = [];
  for (const name of entries) {
    try {
      const st = await fs.stat(path.join(SUBMISSIONS_DIR, name));
      if (st.isDirectory()) dirNames.push(name);
    } catch { /* ignore */ }
  }
  const orphans: string[] = [];
  const BATCH = 200;
  for (let i = 0; i < dirNames.length; i += BATCH) {
    const slice = dirNames.slice(i, i + BATCH);
    const found = await prisma.examPaper.findMany({
      where: { id: { in: slice } },
      select: { id: true },
    });
    const foundSet = new Set(found.map(p => p.id));
    for (const name of slice) if (!foundSet.has(name)) orphans.push(name);
  }
  return { allDirs: dirNames.length, orphans };
}

export async function GET() {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const { allDirs, orphans } = await findOrphans();
    return NextResponse.json({
      volumePath: VOLUME_PATH,
      submissionsDir: SUBMISSIONS_DIR,
      totalDirs: allDirs,
      orphanCount: orphans.length,
      orphans: orphans.slice(0, 50),
      truncated: orphans.length > 50,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const apply = req.nextUrl.searchParams.get("apply") === "1";
  try {
    const { allDirs, orphans } = await findOrphans();
    if (!apply) {
      return NextResponse.json({
        volumePath: VOLUME_PATH,
        totalDirs: allDirs,
        orphanCount: orphans.length,
        applied: false,
        message: "DRY RUN. Re-POST with ?apply=1 to delete.",
      });
    }
    let ok = 0, fail = 0;
    const failures: Array<{ id: string; error: string }> = [];
    for (const name of orphans) {
      try {
        await fs.rm(path.join(SUBMISSIONS_DIR, name), { recursive: true, force: true });
        ok++;
      } catch (err) {
        fail++;
        failures.push({ id: name, error: (err as Error).message });
      }
    }
    return NextResponse.json({
      volumePath: VOLUME_PATH,
      totalDirs: allDirs,
      orphanCount: orphans.length,
      applied: true,
      deleted: ok,
      failed: fail,
      failures: failures.slice(0, 20),
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
