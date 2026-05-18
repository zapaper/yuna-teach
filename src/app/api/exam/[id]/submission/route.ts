import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { markExamPaper, markFocusedTest } from "@/lib/marking";
import { bumpUserActivity } from "@/lib/track-activity";
import { getSessionUserId } from "@/lib/session";
import { isAdmin as isAdminUser } from "@/lib/admin";

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
    const filePath = isInk
      ? path.join(dir, subpart ? `page_${n}_${subpart}_ink.png` : `page_${n}_ink.png`)
      : path.join(dir, subpart ? `page_${n}_${subpart}.jpg` : `page_${n}.jpg`);
    try {
      const buffer = await fs.readFile(filePath);
      return new NextResponse(buffer, {
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
  for (const [key, value] of formData.entries()) {
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
  console.log(`[submission] ${id} action=${action} wrote: [${written.join(", ")}]`);

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
