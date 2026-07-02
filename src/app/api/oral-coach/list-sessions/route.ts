// GET /api/oral-coach/list-sessions?module=english|chinese
//
// Returns the current user's saved practice sessions for the
// requested module, newest first. Reads the per-user JSON file
// written by /api/oral-coach/save-session on the volume.

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getSessionUserId } from "@/lib/session";

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const STORAGE_DIR = path.join(VOLUME_PATH, "oral-sessions");

type StoredSession = {
  savedAt: number;
  themeId: string;
  themeLabel: string;
  avatarKey: string;
  module: "english" | "chinese";
  startedAt: number;
  reading?: { total?: number };
  sbc?: { overallSeabScore?: number; q1Percent?: number; q2Percent?: number; q3Percent?: number };
  combined: number;
};

export async function GET(request: NextRequest) {
  const userId = await getSessionUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(request.url);
  const moduleFilter = url.searchParams.get("module") === "chinese" ? "chinese" : "english";

  const filePath = path.join(STORAGE_DIR, `${userId}.json`);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const all = JSON.parse(raw) as StoredSession[];
    const filtered = Array.isArray(all)
      ? all.filter((s) => s.module === moduleFilter).slice(0, 12)
      : [];
    return NextResponse.json({ sessions: filtered });
  } catch {
    return NextResponse.json({ sessions: [] });
  }
}
