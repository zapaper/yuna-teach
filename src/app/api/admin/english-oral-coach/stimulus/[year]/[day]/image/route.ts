// GET /api/admin/english-oral-coach/stimulus/<year>/<day>/image
//
// Serves the SBC stimulus picture for a given (year, day).
//
// 2016-2024: regenerated Singapore-photo stimuli live in R2 under
//   oral-coach/pictures/<year>_oral_day<N>_stimulus.jpg
// The endpoint 302-redirects there so the file stays behind the
// admin-auth check on the first hit but subsequent loads go
// straight to R2 (browser caches the redirect).
//
// 2025: original photo extracted from the 2025 paper via
// autoCropPictures(). Still served from the local volume because
// it's the only "authentic" paper stimulus we have.

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { isSessionAdmin } from "@/lib/session";

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const STORAGE_DIR = path.join(VOLUME_PATH, "english-supplementary");

// Years whose Singapore-photo stimuli were regenerated via Imagen and
// uploaded to R2 under oral-coach/pictures/. Adding a year here means
// requests for that year get 302'd to R2 instead of served from the
// local volume.
const R2_YEARS = new Set([
  "2016", "2017", "2018", "2019",
  "2020", "2021", "2022", "2023", "2024",
]);

export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ year: string; day: string }> },
) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { year, day } = await ctx.params;
  if (!/^\d{4}$/.test(year)) return NextResponse.json({ error: "bad year" }, { status: 400 });
  const dayN = parseInt(day, 10);
  if (dayN !== 1 && dayN !== 2) return NextResponse.json({ error: "day must be 1 or 2" }, { status: 400 });

  if (R2_YEARS.has(year)) {
    // Redirect straight to the R2 public URL. Do NOT bounce through
    // `/oral-coach/pictures/...` first: NextResponse.redirect(new URL(
    // path, _request.url)) resolves against the INTERNAL node bind
    // address (http://0.0.0.0:8080 on Railway), so the Location:
    // header ends up pointing at an address the browser can't reach.
    // The client-side avatar loops work because they never go
    // through a server-issued redirect — they hit /oral-coach/*
    // directly, and next.config.ts's redirect rule fires with an
    // already-absolute R2 destination. This endpoint has to do the
    // same thing itself: construct the absolute R2 URL server-side
    // and 302 there in one hop.
    const avatarBase = process.env.NEXT_PUBLIC_AVATAR_BASE_URL;
    if (avatarBase) {
      return NextResponse.redirect(
        `${avatarBase}/oral-coach/pictures/${year}_oral_day${dayN}_stimulus.jpg`,
        302,
      );
    }
    // Local dev fallback: no R2 base configured — try to serve the
    // file from the local volume like 2025 does. If it isn't there,
    // the outer try/catch below hands back a friendly 404.
  }

  const filePath = path.join(STORAGE_DIR, `${year}_oral_day${dayN}_stimulus.jpg`);
  try {
    const buf = await fs.readFile(filePath);
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "public, max-age=300",
      },
    });
  } catch {
    return NextResponse.json(
      { error: `stimulus picture not found — check R2 or re-run scripts/regen-oral-stimuli-2026.ts` },
      { status: 404 },
    );
  }
}
