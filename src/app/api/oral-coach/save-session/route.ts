// POST /api/oral-coach/save-session
//
// Persist a completed practice session to the volume so it can be
// listed on the homepage. One JSON file per user under
// $VOLUME_PATH/oral-sessions/<userId>.json — an array of the last N
// sessions, newest first. Kept simple (JSON file, no DB migration)
// since sessions are personal + only need list + a total count.

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getSessionUserId } from "@/lib/session";

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const STORAGE_DIR = path.join(VOLUME_PATH, "oral-sessions");
const MAX_SESSIONS_PER_USER = 50;

type StoredSession = {
  savedAt: number;
  themeId: string;
  themeLabel: string;
  avatarKey: string;
  module: "english" | "chinese";
  startedAt: number;
  reading?: { total?: number; pronunciation?: number; fluencyRhythm?: number; expressiveness?: number };
  sbc?: { overallSeabScore?: number; overallPercent?: number; q1Percent?: number; q2Percent?: number; q3Percent?: number };
  combined: number;
};

export async function POST(request: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body || !body.session) {
    return NextResponse.json({ error: "session payload required" }, { status: 400 });
  }

  const s = body.session as {
    themeId?: string;
    themeLabel?: string;
    avatarKey?: string;
    module?: "english" | "chinese";
    startedAt?: number;
    reading?: { total?: number; pronunciation?: number; fluencyRhythm?: number; expressiveness?: number };
    sbc?: { overallSeabScore?: number; overallPercent?: number; q1Percent?: number; q2Percent?: number; q3Percent?: number };
  };

  const readingTotal = s.reading?.total ?? 0;
  const sbcTotal = s.sbc?.overallSeabScore ?? 0;
  const combined = Math.round((readingTotal + sbcTotal) * 10) / 10;

  const entry: StoredSession = {
    savedAt: Date.now(),
    themeId: s.themeId ?? "",
    themeLabel: s.themeLabel ?? "",
    avatarKey: s.avatarKey ?? "chinese",
    module: s.module === "chinese" ? "chinese" : "english",
    startedAt: s.startedAt ?? Date.now(),
    reading: s.reading,
    sbc: s.sbc,
    combined,
  };

  await fs.mkdir(STORAGE_DIR, { recursive: true });
  const filePath = path.join(STORAGE_DIR, `${userId}.json`);
  let existing: StoredSession[] = [];
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) existing = parsed as StoredSession[];
  } catch {
    // No prior file — treat as empty.
  }
  const next = [entry, ...existing].slice(0, MAX_SESSIONS_PER_USER);
  await fs.writeFile(filePath, JSON.stringify(next, null, 2), "utf-8");

  console.log("[save-session] persisted", { userId, theme: entry.themeLabel, module: entry.module, combined });
  return NextResponse.json({ ok: true, combined });
}
