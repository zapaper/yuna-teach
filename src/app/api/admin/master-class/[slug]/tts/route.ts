import { NextRequest, NextResponse } from "next/server";
import path from "path";
import crypto from "crypto";
import { promises as fs } from "fs";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/session";
import { isAdmin } from "@/lib/admin";
import { getMasterClass, type MasterClassSlide } from "@/data/master-class";

// POST /api/admin/master-class/[slug]/tts
//   body: { slideIdx: number; force?: boolean }
//
// Generates an ElevenLabs voice-over for the slide at slideIdx,
// caches under VOLUME_PATH/master-class/<slug>/slide-<idx>.mp3,
// and streams the audio back. Re-runs hit the cache unless ?force=1.
//
// Requires ELEVENLABS_API_KEY in the environment. Admin-only.

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const CACHE_DIR = path.join(VOLUME_PATH, "master-class");

// "Rachel" — ElevenLabs' default English voice. We can make this
// configurable per master-class later (e.g. a kid-friendly voice).
const VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

// Strip our markdown so the TTS doesn't read out "asterisk asterisk".
// Keeps the content, drops the formatting tokens.
function strip(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__([^_\n]+?)__/g, "$1")
    .replace(/\\n/g, "\n")
    .replace(/[•·]/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

// Mood prefix — ElevenLabs v3 audio tags. Prepended on every segment
// so the tone stays consistent even if the user jumps mid-deck.
const MOOD = "[Excited and professional] [fast-pace] ";

// Split a slide into ordered narration SEGMENTS. Each segment becomes
// its own ElevenLabs audio file so the client can do bullet-level
// navigation (>> / << jump between segments).
function slideToSegments(slide: MasterClassSlide): Array<{ label: string; text: string }> {
  const segs: Array<{ label: string; text: string }> = [];

  // Intro: title + body (+ pie chart caption if any)
  const introParts: string[] = [strip(slide.title)];
  if (slide.body) introParts.push(strip(slide.body));
  if (slide.pieChart) {
    introParts.push(`${slide.pieChart.percentage} percent ${strip(slide.pieChart.label)}.`);
    if (slide.pieChart.caption) introParts.push(strip(slide.pieChart.caption));
  }
  segs.push({ label: "Intro", text: introParts.join(". ") });

  // One segment per bullet — appended [pause] to the end so the
  // model adds a natural beat before the next segment starts.
  if (slide.bullets) {
    slide.bullets.forEach((b, i) => {
      segs.push({ label: `Bullet ${i + 1}`, text: `${strip(b)} [pause]` });
    });
  }

  if (slide.scoringExample) {
    segs.push({
      label: "Scoring example",
      text:
        `Here's a scoring example. ${strip(slide.scoringExample.scenario)}. ` +
        `${strip(slide.scoringExample.oneMark.label)}: ${strip(slide.scoringExample.oneMark.text)}. ` +
        `${strip(slide.scoringExample.fullMarks.label)}: ${strip(slide.scoringExample.fullMarks.text)}.`,
    });
  }

  if (slide.callout) {
    segs.push({ label: "Callout", text: strip(slide.callout) });
  }

  // Apply mood prefix to each segment.
  return segs.map(s => ({ label: s.label, text: `${MOOD}${s.text}` }));
}

export async function POST(req: NextRequest, context: { params: Promise<{ slug: string }> }) {
  const sessionUserId = await getSessionUserId();
  if (!sessionUserId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const me = await prisma.user.findUnique({
    where: { id: sessionUserId },
    select: { name: true, settings: true },
  });
  if (!isAdmin(me)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ELEVENLABS_API_KEY not set in environment" }, { status: 500 });
  }

  const { slug } = await context.params;
  const content = getMasterClass(slug);
  if (!content) return NextResponse.json({ error: "Master Class not found" }, { status: 404 });

  const body = await req.json().catch(() => ({})) as { slideIdx?: number; force?: boolean };
  const slideIdx = typeof body.slideIdx === "number" ? body.slideIdx : -1;
  const force = !!body.force;

  // Combined deck index: 0..N keyConcepts, then N..N+M commonMistakes.
  // For simplicity we treat all slides as one flat list keyConcepts ++ commonMistakes.
  const allSlides = [...content.keyConcepts, ...content.commonMistakes];
  if (slideIdx < 0 || slideIdx >= allSlides.length) {
    return NextResponse.json({ error: "slideIdx out of range" }, { status: 400 });
  }

  const slide = allSlides[slideIdx];
  const slideDir = path.join(CACHE_DIR, slug, `slide-${slideIdx}`);
  await fs.mkdir(slideDir, { recursive: true });

  const segments = slideToSegments(slide);
  if (segments.length === 0) {
    return NextResponse.json({ error: "Empty narration" }, { status: 400 });
  }

  async function callElevenLabs(text: string, modelId: string): Promise<Response> {
    return fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey!,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });
  }

  type SegmentOut = { label: string; audio: string; cache: "HIT" | "MISS" };
  const out: SegmentOut[] = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    // Include a content hash in the filename so that editing the slide
    // text invalidates the cache automatically. Old hashes become
    // orphan files (a few KB each) — harmless until we add a janitor.
    const contentHash = crypto.createHash("sha1").update(seg.text).digest("hex").slice(0, 10);
    const segPath = path.join(slideDir, `seg-${i}-${contentHash}.mp3`);
    let audioBuf: Buffer | null = null;
    let cacheStatus: "HIT" | "MISS" = "MISS";

    if (!force) {
      try {
        audioBuf = await fs.readFile(segPath);
        cacheStatus = "HIT";
      } catch { /* miss */ }
    }

    if (!audioBuf) {
      // Prefer eleven_v3 (supports audio tags); fall back to v2 if
      // the account doesn't have v3 access.
      let res = await callElevenLabs(seg.text, "eleven_v3");
      if (!res.ok && (res.status === 400 || res.status === 403 || res.status === 404)) {
        console.warn(`[tts] eleven_v3 returned ${res.status} for seg ${i}, falling back to multilingual_v2`);
        res = await callElevenLabs(seg.text, "eleven_multilingual_v2");
      }
      if (!res.ok) {
        const errText = await res.text().catch(() => "(no body)");
        console.error(`[tts] ElevenLabs failed ${res.status} on seg ${i}: ${errText.slice(0, 300)}`);
        return NextResponse.json({ error: `ElevenLabs ${res.status}`, segmentIdx: i }, { status: 502 });
      }
      audioBuf = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(segPath, audioBuf);
    }

    out.push({ label: seg.label, audio: audioBuf.toString("base64"), cache: cacheStatus });
  }

  return NextResponse.json({ segments: out });
}
