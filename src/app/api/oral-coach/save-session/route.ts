// POST /api/oral-coach/save-session
//
// End-of-practice save endpoint. Client posts the OralSession JSON
// (theme + avatar + reading result + SBC result). We log it and
// return 200 — persistence to a proper DB table and R2 audio upload
// will follow in the next iteration.
//
// This endpoint intentionally accepts the session as-is without
// the audio blobs. Audio recording upload is handled separately
// (not yet wired) so the JSON stays small and cache-friendly.

import { NextRequest, NextResponse } from "next/server";
import { getSessionUserId } from "@/lib/session";

export async function POST(request: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body || !body.session) {
    return NextResponse.json({ error: "session payload required" }, { status: 400 });
  }

  const { session } = body as {
    session: {
      themeId?: string;
      themeLabel?: string;
      avatarKey?: string;
      startedAt?: number;
      reading?: { total?: number };
      sbc?: { overallSeabScore?: number };
    };
  };
  const readingTotal = session.reading?.total ?? 0;
  const sbcTotal = session.sbc?.overallSeabScore ?? 0;
  const combined = Math.round((readingTotal + sbcTotal) * 10) / 10;

  console.log("[save-session]", {
    userId,
    theme: session.themeLabel,
    avatar: session.avatarKey,
    readingTotal,
    sbcTotal,
    combined,
    at: new Date().toISOString(),
  });

  // TODO(2026-07-02): persist to a new OralPracticeSession table via
  // Prisma migration. For now we return success so the client can
  // show the "Saved" state.
  return NextResponse.json({ ok: true, combined });
}
