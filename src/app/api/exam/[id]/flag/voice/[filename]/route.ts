import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { isSessionAdmin } from "@/lib/session";

// GET /api/exam/[id]/flag/voice/[filename]
//
// Streams a flag voice note back to the admin Q&A page. Files live
// under VOLUME_PATH/flag-voices/<paperId>/<filename>. Admin-only — the
// notes can contain personal context that shouldn't be browseable by
// arbitrary users.

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const FLAG_VOICES_DIR = path.join(VOLUME_PATH, "flag-voices");

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; filename: string }> },
) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id, filename } = await params;

  // Defence in depth: prevent path traversal even though Next.js'
  // dynamic-route segments don't normally allow slashes.
  if (filename.includes("/") || filename.includes("..")) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  const filePath = path.join(FLAG_VOICES_DIR, id, filename);
  try {
    const buffer = await fs.readFile(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mime =
      ext === ".webm" ? "audio/webm" :
      ext === ".ogg" ? "audio/ogg" :
      ext === ".m4a" ? "audio/mp4" :
      ext === ".wav" ? "audio/wav" :
      "application/octet-stream";
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": mime,
        "Content-Length": String(buffer.length),
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
