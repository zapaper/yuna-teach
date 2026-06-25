// POST /api/admin/exam/[id]/copy-subpart-file
// One-off admin tool: copy a submission canvas from one subpart label
// to another (e.g. page_8_b.jpg → page_8_c.jpg). Needed when a
// focused-paper subpart was mis-labelled at clean-extract time and the
// kid wrote their (c) answer under the duplicate-(b) UI slot — the
// label fix in DB doesn't move the file on disk.
//
// Body (JSON):
//   { questionIndex: number, fromLabel: string, toLabel: string }
//
// Auth: admin session only.

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { isSessionAdmin } from "@/lib/session";

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const SUBMISSIONS_DIR = path.join(VOLUME_PATH, "submissions");

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden — admin only" }, { status: 403 });
  }
  const { id: paperId } = await params;
  const body = await request.json() as { questionIndex?: number; fromLabel?: string; toLabel?: string };
  const { questionIndex, fromLabel, toLabel } = body;
  if (typeof questionIndex !== "number" || !fromLabel || !toLabel) {
    return NextResponse.json({ error: "questionIndex (number), fromLabel, toLabel are required" }, { status: 400 });
  }
  if (!/^[a-z](-[ivx]+)?$/i.test(fromLabel) || !/^[a-z](-[ivx]+)?$/i.test(toLabel)) {
    return NextResponse.json({ error: "labels must be lowercase letter, optionally with -i/-ii/-iii suffix" }, { status: 400 });
  }
  const dir = path.join(SUBMISSIONS_DIR, paperId);
  const src = path.join(dir, `page_${questionIndex}_${fromLabel}.jpg`);
  const dst = path.join(dir, `page_${questionIndex}_${toLabel}.jpg`);
  const srcInk = path.join(dir, `page_${questionIndex}_${fromLabel}_ink.png`);
  const dstInk = path.join(dir, `page_${questionIndex}_${toLabel}_ink.png`);

  const copied: string[] = [];
  try {
    await fs.copyFile(src, dst);
    copied.push(path.basename(dst));
  } catch (e) {
    return NextResponse.json({ error: `Source file not found: ${path.basename(src)} (${(e as Error).message})` }, { status: 404 });
  }
  // Best-effort copy of the ink PNG too — used by the marker's blue-ink
  // blank-detection path. If it's missing, the marker can still read
  // from the composite JPG, so swallow this error.
  try {
    await fs.copyFile(srcInk, dstInk);
    copied.push(path.basename(dstInk));
  } catch { /* ink PNG may not exist for older submissions */ }

  console.log(`[admin/copy-subpart-file] ${paperId} Q${questionIndex}: ${fromLabel} → ${toLabel}, copied ${copied.join(", ")}`);
  return NextResponse.json({ ok: true, copied });
}
