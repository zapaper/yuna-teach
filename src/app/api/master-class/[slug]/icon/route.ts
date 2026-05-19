import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import * as path from "path";

// GET /api/master-class/[slug]/icon
// Streams the class icon PNG. Prefer the admin-regenerated copy at
// VOLUME_PATH/master-class-icons/<slug>.png; fall back to the
// bundled file at public/master-class-icons/<slug>.png.
//
// Cache: 5-minute browser cache so the list page doesn't re-fetch
// every render, but a regen reflects within minutes (or sooner if
// the admin hard-refreshes).

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const VOLUME_ICON_DIR = path.join(VOLUME_PATH, "master-class-icons");
const BUNDLED_ICON_DIR = path.join(process.cwd(), "public", "master-class-icons");

export async function GET(_req: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  // sanitise slug: only lowercase letters / digits / hyphen — protects
  // against ../ path-traversal attempts.
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
  }

  const volumePath = path.join(VOLUME_ICON_DIR, `${slug}.png`);
  const bundledPath = path.join(BUNDLED_ICON_DIR, `${slug}.png`);

  for (const p of [volumePath, bundledPath]) {
    try {
      const buf = await fs.readFile(p);
      return new NextResponse(buf as unknown as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=300",
        },
      });
    } catch { /* try next */ }
  }

  return NextResponse.json({ error: "Icon not found" }, { status: 404 });
}
