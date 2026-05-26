import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";
import { renderSinglePage, cropPageImage, detectPictureBounds, detectListeningQuestionsOnPage } from "@/lib/english-supplementary";

// POST /api/admin/english-oral-compo/[id]/recrop-picture
//   Body: { kind: string, pageNum?: number, useFullPage?: boolean }
//
// Re-runs the auto-crop for a single picture. If pageNum is provided
// it OVERWRITES the structured field's picturePageNum first, so the
// admin can fix Gemini's wrong page detection without re-uploading.
// If useFullPage is true, skips bounding-box detection and crops the
// whole page (handy when the auto-detect cuts off part of the image).
//
// kind:
//   "situational"            → situationalWriting.picturePageNum
//   "continuous_<N>"         → continuousPrompts[N-1].picturePageNum
//   "oral_day<N>_stimulus"   → oralDays[N-1].stimulusPicturePageNum
//                              (rotated 90° during crop)

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const STORAGE_DIR = path.join(VOLUME_PATH, "english-supplementary");

type Picturable = {
  situationalWriting: { picturePageNum?: number } | null;
  continuousPrompts: Array<{ optionNum: number; picturePageNum: number | null; brief: string }> | null;
  oralDays: Array<{ day: number; stimulusPicturePageNum: number | null; readingPassage: string; stimulusDescription: string; conversationPrompts: string[] }> | null;
};

function locateKind(row: Picturable, kind: string): { pageNum: number | null; rotate: number; hint: string } {
  if (kind === "situational") {
    return {
      pageNum: row.situationalWriting?.picturePageNum ?? null,
      rotate: 0,
      hint: "the main stimulus picture / poster / flyer at the top of the situational-writing task",
    };
  }
  const cont = kind.match(/^continuous_(\d+)$/);
  if (cont) {
    const n = parseInt(cont[1], 10);
    return {
      pageNum: row.continuousPrompts?.find(p => p.optionNum === n)?.picturePageNum ?? null,
      rotate: 0,
      hint: `the picture labelled option ${n} of the continuous-writing prompts`,
    };
  }
  const oral = kind.match(/^oral_day(\d+)_stimulus$/);
  if (oral) {
    const d = parseInt(oral[1], 10);
    return {
      pageNum: row.oralDays?.find(x => x.day === d)?.stimulusPicturePageNum ?? null,
      rotate: 90,
      hint: "the stimulus-based conversation picture (often printed landscape — sideways on the page)",
    };
  }
  return { pageNum: null, rotate: 0, hint: "" };
}

// Build the update payload that writes a new picturePageNum into
// the right structured-JSON field. Returns null when kind is invalid.
function buildPageUpdate(row: Picturable, kind: string, newPageNum: number): Record<string, unknown> | null {
  if (kind === "situational") {
    const sw = (row.situationalWriting ?? {}) as Record<string, unknown>;
    return { situationalWriting: { ...sw, picturePageNum: newPageNum } };
  }
  const cont = kind.match(/^continuous_(\d+)$/);
  if (cont) {
    const n = parseInt(cont[1], 10);
    const existing = row.continuousPrompts ?? [];
    const updated = [...existing];
    const idx = updated.findIndex(p => p.optionNum === n);
    if (idx >= 0) {
      updated[idx] = { ...updated[idx], picturePageNum: newPageNum };
    } else {
      updated.push({ optionNum: n, picturePageNum: newPageNum, brief: "" });
    }
    return { continuousPrompts: updated };
  }
  const oral = kind.match(/^oral_day(\d+)_stimulus$/);
  if (oral) {
    const d = parseInt(oral[1], 10);
    const existing = row.oralDays ?? [];
    const updated = [...existing];
    const idx = updated.findIndex(x => x.day === d);
    if (idx >= 0) {
      updated[idx] = { ...updated[idx], stimulusPicturePageNum: newPageNum };
    } else {
      updated.push({ day: d, stimulusPicturePageNum: newPageNum, readingPassage: "", stimulusDescription: "", conversationPrompts: [] });
    }
    return { oralDays: updated };
  }
  return null;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const body = await request.json() as { kind?: string; pageNum?: number; useFullPage?: boolean };
  const { kind } = body;
  if (!kind) return NextResponse.json({ error: "kind required" }, { status: 400 });

  const row = await prisma.englishSupplementaryPaper.findUnique({
    where: { id },
    select: {
      id: true, year: true, pdfPath: true,
      situationalWriting: true, continuousPrompts: true, oralDays: true,
    },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!row.pdfPath) return NextResponse.json({ error: "Source PDF missing" }, { status: 404 });

  const typed = {
    situationalWriting: row.situationalWriting as Picturable["situationalWriting"],
    continuousPrompts: row.continuousPrompts as Picturable["continuousPrompts"],
    oralDays: row.oralDays as Picturable["oralDays"],
  };

  // Override the structured pageNum if the admin supplied a new one.
  if (typeof body.pageNum === "number" && body.pageNum > 0) {
    const update = buildPageUpdate(typed, kind, body.pageNum);
    if (!update) return NextResponse.json({ error: `unknown kind: ${kind}` }, { status: 400 });
    await prisma.englishSupplementaryPaper.update({ where: { id }, data: update });
    // Refresh local view of the row's structured fields.
    Object.assign(typed, {
      situationalWriting: (update.situationalWriting ?? typed.situationalWriting) as Picturable["situationalWriting"],
      continuousPrompts: (update.continuousPrompts ?? typed.continuousPrompts) as Picturable["continuousPrompts"],
      oralDays: (update.oralDays ?? typed.oralDays) as Picturable["oralDays"],
    });
  }

  // Listening MCQ branch — different cropping path (one page may
  // contain multiple numbered Qs, so we run Gemini's per-question
  // detection and pick the box matching the requested Q number).
  const listenMatch = kind.match(/^listening_q(\d+)$/);
  if (listenMatch) {
    const targetNum = parseInt(listenMatch[1], 10);
    const reqPage = typeof body.pageNum === "number" ? body.pageNum : null;
    if (!reqPage) return NextResponse.json({ error: "listening_q<N> requires a pageNum (which page is the question on?)" }, { status: 400 });
    try {
      const pdfBuffer = await fs.readFile(row.pdfPath);
      const pageJpeg = await renderSinglePage(pdfBuffer, reqPage, 2400, 90);
      let bounds: { left: number; top: number; width: number; height: number };
      if (body.useFullPage) {
        bounds = { left: 0, top: 0, width: 1, height: 1 };
      } else {
        const qs = await detectListeningQuestionsOnPage(pageJpeg);
        const hit = qs.find(q => q.num === targetNum);
        if (!hit) {
          return NextResponse.json({ error: `Gemini didn't find Q${targetNum} on page ${reqPage}. Try the "Full page" option, or pick the correct page.` }, { status: 404 });
        }
        const pad = 0.02;
        bounds = {
          left: Math.max(0, hit.left - pad),
          top: Math.max(0, hit.top - pad),
          width: Math.min(1 - Math.max(0, hit.left - pad), hit.width + 2 * pad),
          height: Math.min(1 - Math.max(0, hit.top - pad), hit.height + 2 * pad),
        };
      }
      const cropped = await cropPageImage(pageJpeg, bounds, 90, 0);
      await fs.mkdir(STORAGE_DIR, { recursive: true });
      const outPath = path.join(STORAGE_DIR, `${row.year}_${kind}.jpg`);
      await fs.writeFile(outPath, cropped);
      return NextResponse.json({ ok: true, kind, pageNum: reqPage, useFullPage: !!body.useFullPage, size: cropped.length });
    } catch (err) {
      console.error(`[english-oral-compo] recrop ${kind} for ${row.year} failed:`, err);
      return NextResponse.json({ error: "Re-crop failed", details: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  }

  const { pageNum, rotate, hint } = locateKind(typed, kind);
  if (!pageNum) return NextResponse.json({ error: "no page number set for this kind (pass pageNum in body to set one)" }, { status: 400 });

  try {
    const pdfBuffer = await fs.readFile(row.pdfPath);
    const pageJpeg = await renderSinglePage(pdfBuffer, pageNum, 2400, 90);
    const bounds = body.useFullPage
      ? { left: 0, top: 0, width: 1, height: 1 }
      : await detectPictureBounds(pageJpeg, hint);
    const cropped = await cropPageImage(pageJpeg, bounds, 90, rotate);
    await fs.mkdir(STORAGE_DIR, { recursive: true });
    const outPath = path.join(STORAGE_DIR, `${row.year}_${kind}.jpg`);
    await fs.writeFile(outPath, cropped);
    return NextResponse.json({ ok: true, kind, pageNum, useFullPage: !!body.useFullPage, size: cropped.length });
  } catch (err) {
    console.error(`[english-oral-compo] recrop ${kind} for ${row.year} failed:`, err);
    return NextResponse.json({ error: "Re-crop failed", details: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
