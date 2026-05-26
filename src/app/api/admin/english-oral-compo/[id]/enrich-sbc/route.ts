import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";

// POST /api/admin/english-oral-compo/[id]/enrich-sbc
//
// Reads the auto-cropped SBC pictures for Day 1 + Day 2 from disk,
// sends each to Gemini together with the day's reading passage as
// context, and stores a RICH multi-sentence description back into
// the oralDays[day].richDescription field.
//
// Used by the oral analysis script to feed a higher-quality signal
// into theme classification (the original stimulusDescription is
// just a 1-2 sentence label captured during initial structuring).
//
// Picture rotation: stored crops may be rotated 90° (landscape on
// the printed booklet) — Gemini handles rotation transparently.

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const STORAGE_DIR = path.join(VOLUME_PATH, "english-supplementary");
const MODEL = "gemini-3.1-pro-preview";

let _ai: GoogleGenAI | null = null;
function ai() {
  if (!_ai) _ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, httpOptions: { timeout: 180000 } });
  return _ai;
}

type OralDay = {
  day: 1 | 2;
  readingPassage?: string;
  stimulusPicturePageNum?: number | null;
  stimulusDescription?: string;
  richDescription?: string;
  conversationPrompts?: string[];
};

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const row = await prisma.englishSupplementaryPaper.findUnique({
    where: { id }, select: { id: true, year: true, oralDays: true },
  });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return NextResponse.json({ error: "GEMINI_API_KEY not set" }, { status: 500 });

  const days = ((row.oralDays as OralDay[] | null) ?? []).slice();
  if (days.length === 0) {
    return NextResponse.json({ error: "No oralDays — re-extract Paper 4 first" }, { status: 400 });
  }

  const results: Array<{ day: number; status: "enriched" | "skipped-no-image" | "failed"; chars?: number; error?: string }> = [];

  for (const d of days) {
    const cropPath = path.join(STORAGE_DIR, `${row.year}_oral_day${d.day}_stimulus.jpg`);
    let imageBytes: Buffer;
    try {
      imageBytes = await fs.readFile(cropPath);
    } catch {
      results.push({ day: d.day, status: "skipped-no-image" });
      continue;
    }

    try {
      const res = await ai().models.generateContent({
        model: MODEL,
        contents: [{
          role: "user",
          parts: [
            { text: `This is the Stimulus-Based Conversation (SBC) picture from the PSLE English Paper 4 (Oral) — Day ${d.day}, year ${row.year}.

Context — the reading passage the student reads aloud BEFORE seeing this picture (the picture and passage share a loose thematic link, not always tight):
"""${(d.readingPassage ?? "").slice(0, 1200)}"""

Conversation prompts the student is asked about the picture:
${(d.conversationPrompts ?? []).map((q, i) => `  (${String.fromCharCode(97 + i)}) ${q}`).join("\n") || "(not extracted)"}

Describe the picture in 4-6 sentences. Cover:
- The SETTING / location (indoor, outdoor, where exactly)
- The PEOPLE / characters (who they are, what age, what they're doing)
- The MAIN ACTIVITY or focal point — what's actually happening
- Any TEXT / signage / posters that appear in the picture (this is often the key clue for the conversation theme)
- The implied THEME / topic the examiner wants the student to discuss (e.g. recycling, fitness, road safety, healthy eating, helping others, time management)

Plain prose, no bullet points, no markdown. Note: image may be rotated 90° — interpret normally.` },
            { inlineData: { mimeType: "image/jpeg", data: imageBytes.toString("base64") } },
          ],
        }],
        config: { temperature: 0.2 },
      });
      const text = (res.text ?? "").trim();
      if (!text) {
        results.push({ day: d.day, status: "failed", error: "empty response" });
        continue;
      }
      d.richDescription = text;
      results.push({ day: d.day, status: "enriched", chars: text.length });
    } catch (err) {
      results.push({ day: d.day, status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }

  await prisma.englishSupplementaryPaper.update({
    where: { id }, data: { oralDays: days as object[] },
  });
  return NextResponse.json({ ok: true, year: row.year, results });
}
