import { NextRequest, NextResponse } from "next/server";
import path from "path";
import crypto from "crypto";
import { promises as fs } from "fs";
import { getSessionUserId } from "@/lib/session";
import { type MasterClassSlide } from "@/data/master-class";
import { getMasterClassHydrated } from "@/lib/master-class/hydrate";

// POST /api/master-class/[slug]/tts
//   body: { slideIdx: number; force?: boolean }
//
// Generates an ElevenLabs voice-over for the slide at slideIdx,
// caches under VOLUME_PATH/master-class/<slug>/slide-<idx>.mp3,
// and streams the audio back. Re-runs hit the cache unless ?force=1.
//
// Requires ELEVENLABS_API_KEY in the environment. Admin-only.

const VOLUME_PATH = process.env.VOLUME_PATH ?? path.join(process.cwd(), ".data");
const CACHE_DIR = path.join(VOLUME_PATH, "master-class");

// Active voice ID. Swap freely — the cache key includes the voice ID
// below, so changing this invalidates old cached audio automatically.
const VOICE_ID = "WZlYpi1yf6zJhNWXih74";

// Strip our markdown so the TTS doesn't read out "asterisk asterisk".
// Keeps the content, drops the formatting tokens.
//
// Bold emphasis: ElevenLabs (both v3 and v2) naturally inflects words
// in ALL CAPS — that's the most reliable cross-model emphasis trick.
// So **important** in the script becomes IMPORTANT in the TTS input.
function strip(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, (_m, inner) => String(inner).toUpperCase())
    .replace(/__([^_\n]+?)__/g, "$1")
    .replace(/\\n/g, "\n")
    .replace(/[•·]/g, ",")
    .replace(/\s+/g, " ")
    .trim();
}

// Mood prefix — ElevenLabs v3 audio tags. Prepended on every segment
// so the tone stays consistent even if the user jumps mid-deck.
// Dropped the explicit [fast-pace] tag — natural pacing reads more
// clearly for students; speed-up was making it feel rushed.
const MOOD = "[Excited and professional] ";

// Split a slide into ordered narration SEGMENTS. Each segment becomes
// its own ElevenLabs audio file so the client can do bullet-level
// navigation (>> / << jump between segments).
//
// slide.narration.{intro,bullets[i],scoringExample,callout} are
// optional overrides — when set, the override text is read aloud
// instead of the auto-built script from visible content. This lets
// authors add teacher-style transitions ("Now let's look at…") or
// longer audio elaborations that DON'T appear visually on the slide.
function slideToSegments(slide: MasterClassSlide): Array<{ label: string; text: string }> {
  const segs: Array<{ label: string; text: string }> = [];
  const nar = slide.narration;

  // Intro: override > (title + body + pie chart caption)
  let introText: string;
  if (nar?.intro) {
    introText = strip(nar.intro);
  } else {
    const introParts: string[] = [strip(slide.title)];
    if (slide.body) introParts.push(strip(slide.body));
    if (slide.pieChart) {
      introParts.push(`${slide.pieChart.percentage} percent ${strip(slide.pieChart.label)}.`);
      if (slide.pieChart.caption) introParts.push(strip(slide.pieChart.caption));
    }
    introText = introParts.join(". ");
  }
  segs.push({ label: "Intro", text: introText });

  // One segment per bullet — appended [pause] to the end so the
  // model adds a natural beat before the next segment starts.
  if (slide.bullets) {
    slide.bullets.forEach((b, i) => {
      const override = nar?.bullets?.[i];
      const text = override ? strip(override) : strip(b);
      segs.push({ label: `Bullet ${i + 1}`, text: `${text} [pause]` });
    });
  }

  if (slide.scoringExample) {
    const text = nar?.scoringExample
      ? strip(nar.scoringExample)
      : `Here's a scoring example. ${strip(slide.scoringExample.scenario)}. ` +
        `${strip(slide.scoringExample.oneMark.label)}: ${strip(slide.scoringExample.oneMark.text)}. ` +
        `${strip(slide.scoringExample.fullMarks.label)}: ${strip(slide.scoringExample.fullMarks.text)}.`;
    segs.push({ label: "Scoring example", text });
  }

  if (slide.callout) {
    const text = nar?.callout ? strip(nar.callout) : strip(slide.callout);
    segs.push({ label: "Callout", text });
  }

  // Apply mood prefix to each segment.
  return segs.map(s => ({ label: s.label, text: `${MOOD}${s.text}` }));
}

export async function POST(req: NextRequest, context: { params: Promise<{ slug: string }> }) {
  // Any signed-in user can request narration — both the admin
  // workshop and the student-facing player call this. Caching
  // makes repeat hits free regardless of who triggered the first.
  const sessionUserId = await getSessionUserId();
  if (!sessionUserId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ELEVENLABS_API_KEY not set in environment" }, { status: 500 });
  }

  const { slug } = await context.params;
  const content = await getMasterClassHydrated(slug);
  if (!content) return NextResponse.json({ error: "Master Class not found" }, { status: 404 });

  const body = await req.json().catch(() => ({})) as { slideIdx?: number; force?: boolean; cacheOnly?: boolean };
  const slideIdx = typeof body.slideIdx === "number" ? body.slideIdx : -1;
  const force = !!body.force;
  // cacheOnly: return segments ONLY if every segment is already on disk
  // (no ElevenLabs calls). Lets the admin / player check "is voice
  // ready?" on mount without burning generation calls.
  const cacheOnly = !!body.cacheOnly;

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
    // Include both the segment text AND the active voice ID in the
    // cache hash so that editing the script OR swapping voices both
    // invalidate old audio automatically. Orphan files (a few KB
    // each) accumulate on disk — harmless until we add a janitor.
    const contentHash = crypto
      .createHash("sha1")
      .update(`${VOICE_ID}|${seg.text}`)
      .digest("hex")
      .slice(0, 10);
    const segPath = path.join(slideDir, `seg-${i}-${contentHash}.mp3`);
    let audioBuf: Buffer | null = null;
    let cacheStatus: "HIT" | "MISS" = "MISS";

    if (!force) {
      try {
        audioBuf = await fs.readFile(segPath);
        cacheStatus = "HIT";
      } catch { /* miss */ }
    }

    // cacheOnly: bail with cached:false the moment we hit a missing
    // segment — we won't call ElevenLabs for any segment. The caller
    // sees no segments and can show a "Generate" button.
    if (cacheOnly && !audioBuf) {
      return NextResponse.json({ cached: false, segments: [] });
    }

    if (!audioBuf) {
      // Prefer eleven_v3 (supports audio tags); fall back to v2 if
      // the account doesn't have v3 access.
      async function tryGenerate(): Promise<Response> {
        let r = await callElevenLabs(seg.text, "eleven_v3");
        if (!r.ok && (r.status === 400 || r.status === 403 || r.status === 404)) {
          console.warn(`[tts] eleven_v3 returned ${r.status} for seg ${i}, falling back to multilingual_v2`);
          r = await callElevenLabs(seg.text, "eleven_multilingual_v2");
        }
        return r;
      }

      // Retry on 429 with exponential backoff (1.5s → 3s → 6s).
      // Concurrency limits and per-second caps both surface as 429.
      const RETRY_DELAYS_MS = [1500, 3000, 6000];
      let res = await tryGenerate();
      for (let attempt = 0; attempt < RETRY_DELAYS_MS.length && res.status === 429; attempt++) {
        const wait = RETRY_DELAYS_MS[attempt];
        console.warn(`[tts] 429 on seg ${i}, retrying in ${wait}ms (attempt ${attempt + 1}/${RETRY_DELAYS_MS.length})`);
        await new Promise(r => setTimeout(r, wait));
        res = await tryGenerate();
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => "(no body)");
        console.error(`[tts] ElevenLabs failed ${res.status} on seg ${i}: ${errText.slice(0, 300)}`);
        return NextResponse.json({ error: `ElevenLabs ${res.status}`, segmentIdx: i }, { status: 502 });
      }
      audioBuf = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(segPath, audioBuf);
      // Brief spacer between sequential segment calls so we don't
      // run smack into the per-second rate limit on the very next
      // call. 300ms is comfortable for most plans.
      await new Promise(r => setTimeout(r, 300));
    }

    out.push({ label: seg.label, audio: audioBuf.toString("base64"), cache: cacheStatus });
  }

  return NextResponse.json({ cached: out.every(s => s.cache === "HIT"), segments: out });
}
