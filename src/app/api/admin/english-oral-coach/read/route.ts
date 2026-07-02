// GET /api/admin/english-oral-coach/read?year=YYYY&day=1|2
//
// Returns the single day's structured passage for the Reading Aloud
// module. The corpus route bundles both days per year and previews
// them; this route pulls the full text of just one day so the client
// can hand it to Azure as the pronunciation-assessment reference.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

export async function GET(request: NextRequest) {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const year = request.nextUrl.searchParams.get("year")?.trim();
  const dayRaw = request.nextUrl.searchParams.get("day")?.trim();
  const day = dayRaw ? parseInt(dayRaw, 10) : NaN;
  if (!year || !/^\d{4}$/.test(year)) {
    return NextResponse.json({ error: "year required (YYYY)" }, { status: 400 });
  }
  if (!Number.isFinite(day) || (day !== 1 && day !== 2)) {
    return NextResponse.json({ error: "day must be 1 or 2" }, { status: 400 });
  }

  const paper = await prisma.englishSupplementaryPaper.findUnique({
    where: { year },
    select: { oralDays: true },
  });
  if (!paper) return NextResponse.json({ error: "no paper for that year" }, { status: 404 });

  const days = paper.oralDays as Array<{
    day: number;
    readingPassage?: string;
    stimulusDescription?: string;
    conversationPrompts?: unknown;
  }> | null;
  const match = days?.find((d) => d.day === day) ?? null;
  if (!match) return NextResponse.json({ error: "no day found" }, { status: 404 });

  // Normalise conversationPrompts to string[] (some rows use [{label, prompt}])
  let prompts: string[] = [];
  const raw = match.conversationPrompts;
  if (Array.isArray(raw)) {
    prompts = raw.map((p) => {
      if (typeof p === "string") return p;
      if (p && typeof p === "object") {
        const o = p as { label?: string; prompt?: string; text?: string };
        if (o.label && o.prompt) return `(${o.label}) ${o.prompt}`;
        if (o.prompt) return o.prompt;
        if (o.text) return o.text;
      }
      return String(p);
    });
  }

  return NextResponse.json({
    day: {
      day: match.day,
      readingPassage: cleanReadingPassage(match.readingPassage ?? ""),
      stimulusDescription: match.stimulusDescription ?? "",
      conversationPrompts: prompts,
    },
  });
}

// Some ingested rows still carry the SEAB PDF boilerplate at the tail
// (or head) of the reading passage — page markers, form numbers, and
// the "PSLE ENGLISH LANGUAGE / READING PASSAGE" heading block. Strip
// them before serving so (a) students see just the story, and (b)
// Azure Speech doesn't score the student down for not reading
// "PSLE ENGLISH LANGUAGE" aloud (it treats the reference text as the
// exact expected utterance).
function cleanReadingPassage(text: string): string {
  const noiseLinePatterns: RegExp[] = [
    /^\s*0001\/\d\s*$/,                                    // 0001/4 form number
    /^\s*---\s*Page\s*\d+\s*---\s*$/i,                     // --- Page 35 ---
    /^\s*\*\*\s*\d+\s*\*\*\s*$/,                           // **1**
    /^\s*\*\*\s*PSLE ENGLISH LANGUAGE\s*\*\*\s*$/i,
    /^\s*\*\*\s*ENGLISH LANGUAGE\s*\*\*\s*$/i,
    /^\s*\*\*\s*MINISTRY OF EDUCATION[^*]*\*\*\s*$/i,
    /^\s*\*\*\s*PRIMARY SCHOOL LEAVING EXAMINATION\s*\*\*\s*$/i,
    /^\s*\*\*\s*READING PASSAGE\s*\*\*\s*$/i,
  ];
  const italicInstructionPattern = /^\s*\*[^*]*you will (?:read|present)[^*]*\*\s*$/i;
  const lines = text.split(/\r?\n/);
  const kept = lines.filter((ln) => {
    if (noiseLinePatterns.some((rx) => rx.test(ln))) return false;
    if (italicInstructionPattern.test(ln)) return false;
    return true;
  });
  // Collapse 3+ consecutive blank lines to exactly 2 (paragraph gap).
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    // Strip stray **bold** markers still hanging around inside prose.
    .replace(/\*\*/g, "")
    .trim();
}
