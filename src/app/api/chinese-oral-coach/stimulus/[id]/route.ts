// GET /api/chinese-oral-coach/stimulus/<themeId>
//
// 302 to the R2 URL for the theme's stimulus picture. Reuses the
// English module's R2 uploads (visuals are language-agnostic).

import { NextRequest, NextResponse } from "next/server";
import { isSessionAdmin } from "@/lib/session";
import { getOralThemeZh } from "@/lib/oral-themes-zh";

export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const theme = getOralThemeZh(id);
  if (!theme) return NextResponse.json({ error: "theme not found" }, { status: 404 });

  const avatarBase = process.env.NEXT_PUBLIC_AVATAR_BASE_URL;
  if (avatarBase) {
    return NextResponse.redirect(`${avatarBase}/${theme.imageR2Path}`, 302);
  }
  return NextResponse.json({ error: "NEXT_PUBLIC_AVATAR_BASE_URL not set" }, { status: 500 });
}
