import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import { prisma } from "@/lib/db";
import { markExamPaper, markFocusedTest } from "@/lib/marking";
import { bumpUserActivity } from "@/lib/track-activity";
import { getSessionUserId } from "@/lib/session";
import { isAdmin as isAdminUser } from "@/lib/admin";

// Trim the white margins off a saved canvas JPEG so review doesn't show
// a tall blank rectangle when the student wrote in only the top portion
// of the canvas. Cached to <orig>_trim<version>.jpg; regenerates if
// the source file has been resaved more recently than the cache OR if
// the trim params have changed (bump the version when changing the
// pipeline below — old caches just get ignored, harmless extra files
// on disk that a future janitor can clean up).
const TRIM_VERSION = 2; // v1 = threshold 12 + quality 88. v2 = threshold 30 + quality 92 + blank placeholder.
async function trimmedCanvasBuffer(origPath: string): Promise<Buffer> {
  const trimPath = origPath.replace(/\.jpg$/, `_trim${TRIM_VERSION}.jpg`);
  try {
    const [origStat, trimStat] = await Promise.all([
      fs.stat(origPath),
      fs.stat(trimPath),
    ]);
    if (trimStat.mtimeMs >= origStat.mtimeMs) {
      return await fs.readFile(trimPath);
    }
  } catch { /* cache miss or original missing — fall through */ }

  const orig = await fs.readFile(origPath);
  try {
    // threshold bumped 12 → 30: tighter cropping when faint pen ink
    // sits on a JPEG-noisy white margin. 12 was leaving lots of
    // 'almost-white' speckle outside the actual writing → tall
    // wrappers in review. 30 keeps any pixel within ~12% of pure
    // white as background — still well below ink intensity.
    // extend → 10 px breathing room around the ink so descenders /
    // strokes touching the edge don't look clipped.
    const trimmed = await sharp(orig)
      .trim({ threshold: 30, background: { r: 255, g: 255, b: 255 } })
      .extend({ top: 10, bottom: 14, left: 10, right: 10, background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
      .toBuffer();
    await fs.writeFile(trimPath, trimmed);
    return trimmed;
  } catch {
    // sharp.trim throws when the image is entirely background —
    // blank/unanswered canvas. Return a tiny placeholder strip so
    // the review wrapper collapses to ~30 px instead of rendering
    // the full original blank rectangle.
    try {
      const meta = await sharp(orig).metadata();
      const w = meta.width ?? 200;
      const placeholder = await sharp({
        create: { width: Math.min(w, 800), height: 30, channels: 3, background: { r: 255, g: 255, b: 255 } },
      }).jpeg({ quality: 80 }).toBuffer();
      await fs.writeFile(trimPath, placeholder);
      return placeholder;
    } catch {
      return orig;
    }
  }
}

// Authorise a request against a paper's submission files.
//
// Returns { ok: true } if the caller is allowed to view/modify
// the submission, otherwise an HTTP-style error object the caller
// returns directly.
//
// Who's allowed:
//   - admin
//   - the paper's owner (uploaded the master / created the clone)
//   - the assigned student (their own work)
//   - a parent linked to the assigned student
//
// Identity comes from the signed yuna_session cookie. No
// ?userId= query param fallback — that's spoofable and was the
// reason this route was readable without auth before this fix.
async function authoriseSubmissionAccess(paperId: string): Promise<
  | { ok: true; userId: string; isAdmin: boolean }
  | { ok: false; status: number; error: string }
> {
  const sessionUserId = await getSessionUserId();
  if (!sessionUserId) {
    return { ok: false, status: 401, error: "Not signed in" };
  }
  const [paper, user] = await Promise.all([
    prisma.examPaper.findUnique({
      where: { id: paperId },
      select: { userId: true, assignedToId: true },
    }),
    prisma.user.findUnique({
      where: { id: sessionUserId },
      select: { id: true, name: true, settings: true, role: true },
    }),
  ]);
  if (!paper) return { ok: false, status: 404, error: "Paper not found" };
  if (!user) return { ok: false, status: 401, error: "Session user missing" };

  const admin = isAdminUser(user);
  if (admin) return { ok: true, userId: sessionUserId, isAdmin: true };
  if (paper.userId === sessionUserId) return { ok: true, userId: sessionUserId, isAdmin: false };
  if (paper.assignedToId === sessionUserId) return { ok: true, userId: sessionUserId, isAdmin: false };

  if (paper.assignedToId) {
    const link = await prisma.parentStudent.findUnique({
      where: { parentId_studentId: { parentId: sessionUserId, studentId: paper.assignedToId } },
      select: { id: true },
    });
    if (link) return { ok: true, userId: sessionUserId, isAdmin: false };
  }
  return { ok: false, status: 403, error: "Forbidden" };
}

const VOLUME_PATH =
  process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const SUBMISSIONS_DIR = path.join(VOLUME_PATH, "submissions");

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function submissionDir(id: string) {
  return path.join(SUBMISSIONS_DIR, id);
}

// GET /api/exam/[id]/submission
//   ?page=N  → serve the composite JPEG for page N
//   (none)   → return { pageCount, submittedAt }
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await authoriseSubmissionAccess(id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const pageStr = request.nextUrl.searchParams.get("page");

  const paper = await prisma.examPaper.findUnique({
    where: { id },
    select: { completedAt: true },
  });

  if (!paper) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const dir = submissionDir(id);

  // List mode: enumerate every file in the paper's submission dir.
  // Used by scripts/run-marking-eval.ts so a local eval against prod
  // data can pull EVERY canvas / scan / ink PNG instead of guessing
  // filenames per question. Skips debug crops (mcq_q*_pass*.jpg).
  if (request.nextUrl.searchParams.get("list") === "1") {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files = entries
        .filter(e => e.isFile())
        .map(e => e.name)
        .filter(name => !name.startsWith("mcq_q"));
      return NextResponse.json({ files });
    } catch (err) {
      if ((err as { code?: string }).code === "ENOENT") {
        return NextResponse.json({ files: [] });
      }
      return NextResponse.json({ error: "list failed" }, { status: 500 });
    }
  }

  // Debug crop viewer for scanned-back MCQ detection. The marker
  // writes the exact crops it sent to Gemini to
  // submissions/<cloneId>/mcq_q<questionNum>_pass1.jpg (and pass2
  // on retry). Query:
  //   ?mcq=5           → serves mcq_q5_pass1.jpg
  //   ?mcq=5&pass=pass2 → serves the retry crop
  const mcqQ = request.nextUrl.searchParams.get("mcq");
  if (mcqQ !== null) {
    const pass = request.nextUrl.searchParams.get("pass") || "pass1";
    const filePath = path.join(dir, `mcq_q${mcqQ}_${pass}.jpg`);
    try {
      const buffer = await fs.readFile(filePath);
      return new NextResponse(buffer, {
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-cache" },
      });
    } catch {
      return NextResponse.json({ error: "MCQ crop not found (run a re-mark to regenerate)" }, { status: 404 });
    }
  }

  if (pageStr !== null) {
    const n = parseInt(pageStr, 10);
    if (isNaN(n)) {
      return NextResponse.json({ error: "Invalid page" }, { status: 400 });
    }
    const type = request.nextUrl.searchParams.get("type");
    const subpart = request.nextUrl.searchParams.get("subpart");
    const isInk = type === "ink";
    // Default: composite JPEGs are auto-trimmed to ink bounds so the
    // review wrapper doesn't show large blank areas under the writing.
    // Opt-out: ?trim=0 for the raw saved canvas (used by the marker
    // pipeline which needs the original coordinates intact).
    const trimParam = request.nextUrl.searchParams.get("trim");
    const trimEnabled = !isInk && trimParam !== "0";
    const filePath = isInk
      ? path.join(dir, subpart ? `page_${n}_${subpart}_ink.png` : `page_${n}_ink.png`)
      : path.join(dir, subpart ? `page_${n}_${subpart}.jpg` : `page_${n}.jpg`);
    try {
      const buffer = trimEnabled
        ? await trimmedCanvasBuffer(filePath)
        : await fs.readFile(filePath);
      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          "Content-Type": isInk ? "image/png" : "image/jpeg",
          "Cache-Control": "private, no-cache",
        },
      });
    } catch {
      return NextResponse.json({ error: "Page not found" }, { status: 404 });
    }
  }

  // Return metadata
  let pageCount = 0;
  try {
    const files = await fs.readdir(dir);
    pageCount = files.filter(
      (f) => /^page_\d+\.jpg$/.test(f)
    ).length;
  } catch {
    // directory doesn't exist yet
  }

  return NextResponse.json({
    pageCount,
    submittedAt: paper.completedAt?.toISOString() ?? null,
  });
}

// POST /api/exam/[id]/submission
//   Body: multipart form
//     action: "save" | "submit"
//     page_0, page_1, … : JPEG files
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await authoriseSubmissionAccess(id);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const formData = await request.formData();
  const action = formData.get("action") as string;

  // Bump the assigned student's "last active" stamp — submission is
  // the strongest signal a student is currently using the app.
  prisma.examPaper.findUnique({ where: { id }, select: { assignedToId: true } })
    .then((p) => bumpUserActivity(p?.assignedToId ?? null))
    .catch(() => { /* non-fatal */ });

  const dir = submissionDir(id);
  await ensureDir(dir);

  let pageCount = 0;
  const written: string[] = [];
  const allKeys: string[] = [];
  for (const [key, value] of formData.entries()) {
    if (value instanceof File) allKeys.push(`${key}(${value.size}b)`);
    if (!(value instanceof File)) continue;
    if (key.startsWith("page_") && key.endsWith("_ink")) {
      // Ink-only PNG (for reload)
      const n = key.slice(5, -4); // "page_0_ink" → "0"
      const buffer = Buffer.from(await value.arrayBuffer());
      await fs.writeFile(path.join(dir, `page_${n}_ink.png`), buffer);
      written.push(`${n}_ink(${buffer.length}b)`);
    } else if (key.startsWith("page_")) {
      // Composite JPEG (for parent viewing)
      const n = key.slice(5); // "page_0" → "0"
      const buffer = Buffer.from(await value.arrayBuffer());
      await fs.writeFile(path.join(dir, `page_${n}.jpg`), buffer);
      written.push(`${n}(${buffer.length}b)`);
      pageCount++;
    }
  }
  // One-line summary instead of dumping all file paths. Full breakdown
  // only printed when received ≠ written (the actual signal worth
  // surfacing — file-save bugs cause divergence).
  const totalBytes = written.reduce((s, w) => {
    const m = w.match(/\((\d+)b\)/);
    return s + (m ? parseInt(m[1], 10) : 0);
  }, 0);
  const sizeKB = (totalBytes / 1024).toFixed(0);
  if (written.length === allKeys.length) {
    console.log(`[submission] ${id} action=${action} wrote ${written.length} files (${sizeKB}KB)`);
  } else {
    console.warn(`[submission] ${id} action=${action} MISMATCH: wrote ${written.length} of ${allKeys.length} received. wrote: [${written.join(", ")}] received-files: [${allKeys.join(", ")}]`);
  }

  if (action === "submit") {
    const updatedPaper = await prisma.examPaper.update({
      where: { id },
      data: { completedAt: new Date() },
      select: { paperType: true },
    });

    // Auto-mark in background — fire and forget
    if (updatedPaper.paperType === "focused" || updatedPaper.paperType === "mastery") {
      markFocusedTest(id).catch((err) =>
        console.error(`[Auto-mark] ${updatedPaper.paperType} marking for ${id} failed:`, err)
      );
    } else {
      markExamPaper(id).catch((err) =>
        console.error(`[Auto-mark] Background marking for ${id} failed:`, err)
      );
    }
  }

  return NextResponse.json({ success: true, pageCount });
}
