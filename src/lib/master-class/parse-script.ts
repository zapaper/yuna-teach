// Master Class slide script parser + serializer.
//
// MEGA-TEXTAREA FORMAT (one slide):
//   First non-empty line          → title
//   Lines starting with "- "      → bullets
//   Lines starting with "> "      → callout
//   Other non-empty paragraphs    → body (joined with blank-line breaks)
//   {anything in braces}          → audio-only — kept in narration, stripped from visible text
//   **bold** and __underline__    → unchanged (renderer handles them)
//
// Braces work INLINE inside title/body/bullet/callout. The visible
// text drops the braces (and the text inside); the narration block
// keeps the FULL string (including the unwrapped audio bits) so the
// TTS reads everything in context.

import type { MasterClassSlide } from "@/data/master-class";

// Strip {…} chunks from a string. Returns the visible text.
// Brace pairs only nest one level deep — we don't try to be clever.
export function stripBraces(s: string): string {
  return s.replace(/\s*\{[^{}]*\}\s*/g, " ").replace(/\s+/g, " ").trim();
}

// Drop the braces but keep the text inside. Used to build the
// narration string so the voice reads the audio-only bits inline.
export function unwrapBraces(s: string): string {
  return s.replace(/\{([^{}]*)\}/g, "$1").replace(/\s+/g, " ").trim();
}

// Does a string contain any {…} segment?
export function hasBraces(s: string): boolean {
  return /\{[^{}]*\}/.test(s);
}

export type ParsedScript = {
  title: string;
  body?: string;
  bullets?: string[];
  callout?: string;
  narration?: MasterClassSlide["narration"];
};

export function parseSlideScript(raw: string): ParsedScript {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let title = "";
  let titleRaw = "";
  const bullets: string[] = [];
  const bulletsRaw: string[] = [];
  let callout = "";
  let calloutRaw = "";
  const bodyParts: string[] = [];
  const bodyPartsRaw: string[] = [];

  let bodyBuf: string[] = [];
  const flushBody = () => {
    if (bodyBuf.length === 0) return;
    const joined = bodyBuf.join(" ").trim();
    bodyBuf = [];
    if (!joined) return;
    bodyPartsRaw.push(joined);
    const visible = stripBraces(joined);
    if (visible) bodyParts.push(visible);
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushBody();
      continue;
    }
    if (!title) {
      titleRaw = line;
      title = stripBraces(line);
      continue;
    }
    if (line.startsWith("- ") || line.startsWith("* ")) {
      flushBody();
      const bulletRaw = line.slice(2).trim();
      bulletsRaw.push(bulletRaw);
      bullets.push(stripBraces(bulletRaw));
      continue;
    }
    if (line.startsWith("> ")) {
      flushBody();
      const calloutLineRaw = line.slice(2).trim();
      calloutRaw = calloutRaw ? `${calloutRaw} ${calloutLineRaw}` : calloutLineRaw;
      callout = stripBraces(calloutRaw);
      continue;
    }
    bodyBuf.push(line);
  }
  flushBody();

  const body = bodyParts.join("\n\n") || undefined;

  // Build narration overrides only when the raw text differs from
  // the visible text — i.e. there were {…} segments. Otherwise we
  // let the TTS pipeline auto-build from visible content.
  const narration: NonNullable<MasterClassSlide["narration"]> = {};
  const introRaw = [titleRaw, ...bodyPartsRaw].filter(Boolean).join(". ");
  if (introRaw && hasBraces(introRaw)) {
    narration.intro = unwrapBraces(introRaw);
  }
  if (bulletsRaw.some(hasBraces)) {
    narration.bullets = bulletsRaw.map(b => hasBraces(b) ? unwrapBraces(b) : null);
  }
  if (calloutRaw && hasBraces(calloutRaw)) {
    narration.callout = unwrapBraces(calloutRaw);
  }

  return {
    title,
    body,
    bullets: bullets.length ? bullets : undefined,
    callout: callout || undefined,
    narration: Object.keys(narration).length ? narration : undefined,
  };
}

// Serialize a slide back to mega-textarea form. Used to seed the
// admin editor from the YAML on first load — produces text the
// author can edit in place. Audio-only bits from the slide's
// narration block are re-attached inline as {…} segments where
// possible (intro override → trailing brace block on body; bullet
// overrides → trailing brace on that bullet; callout → trailing
// brace on callout).
export function serializeSlideScript(slide: MasterClassSlide): string {
  const parts: string[] = [];
  parts.push(slide.title);
  // Body — append any audio-only intro tail as {…} at the end so the
  // author can see what's voice-only. We only attach the DIFFERENCE
  // between narration.intro and (title + body) when both exist.
  const visibleIntro = [slide.title, slide.body ?? ""].filter(Boolean).join(". ");
  let bodyOut = slide.body ?? "";
  const introNar = slide.narration?.intro?.trim();
  if (introNar && introNar !== visibleIntro.trim()) {
    const visibleNorm = visibleIntro.replace(/\s+/g, " ").trim();
    let audioOnly = introNar.replace(/\s+/g, " ").trim();
    if (visibleNorm && audioOnly.startsWith(visibleNorm)) {
      audioOnly = audioOnly.slice(visibleNorm.length).trim().replace(/^[.,;:\s]+/, "");
    }
    if (audioOnly) {
      bodyOut = bodyOut ? `${bodyOut} {${audioOnly}}` : `{${audioOnly}}`;
    }
  }
  if (bodyOut) parts.push("", bodyOut);

  if (slide.bullets?.length) {
    parts.push("");
    slide.bullets.forEach((b, i) => {
      const override = slide.narration?.bullets?.[i];
      if (override && override.trim() && override.trim() !== stripBraces(b).trim()) {
        const visible = b.replace(/\s+/g, " ").trim();
        let audioOnly = override.replace(/\s+/g, " ").trim();
        if (visible && audioOnly.startsWith(visible)) {
          audioOnly = audioOnly.slice(visible.length).trim().replace(/^[.,;:\s]+/, "");
        }
        parts.push(audioOnly ? `- ${b} {${audioOnly}}` : `- ${b}`);
      } else {
        parts.push(`- ${b}`);
      }
    });
  }

  if (slide.callout) {
    parts.push("");
    const calloutNar = slide.narration?.callout?.trim();
    if (calloutNar && calloutNar !== slide.callout.trim()) {
      const visible = slide.callout.replace(/\s+/g, " ").trim();
      let audioOnly = calloutNar.replace(/\s+/g, " ").trim();
      if (visible && audioOnly.startsWith(visible)) {
        audioOnly = audioOnly.slice(visible.length).trim().replace(/^[.,;:\s]+/, "");
      }
      parts.push(audioOnly ? `> ${slide.callout} {${audioOnly}}` : `> ${slide.callout}`);
    } else {
      parts.push(`> ${slide.callout}`);
    }
  }

  return parts.join("\n");
}
