// Master Class slide script parser + serializer.
//
// MEGA-TEXTAREA FORMAT (one slide):
//   First non-empty line          → title
//   Lines starting with "- "      → top-level bullet
//   Lines starting with "-- "     → sub-bullet (rendered as "  • text"
//                                   on a new line inside the previous
//                                   top-level bullet)
//   Lines starting with "> "      → callout
//   Lines starting with "~ "      → placeholder (skipped — used to
//                                   show YAML-only blocks like
//                                   pieChart / scoringExample to the
//                                   author without making them
//                                   editable)
//   Other non-empty paragraphs    → body. Blank lines between
//                                   paragraphs are preserved.
//   {anything in braces}          → audio-only text. Stripped from
//                                   the visible slide but kept in the
//                                   narration override.
//   **bold** and __underline__    → unchanged (renderer handles them).

import type { MasterClassSlide } from "@/data/master-class";

// Strip {…} chunks from a string. Returns the visible text.
export function stripBraces(s: string): string {
  return s.replace(/\s*\{[^{}]*\}\s*/g, " ").replace(/[ \t]+/g, " ").trim();
}

// Drop the braces but keep the text inside. Used to build narration
// strings so the voice reads the audio-only bits in context.
export function unwrapBraces(s: string): string {
  return s.replace(/\{([^{}]*)\}/g, "$1").replace(/[ \t]+/g, " ").trim();
}

export function hasBraces(s: string): boolean {
  return /\{[^{}]*\}/.test(s);
}

// Match a top-level bullet: -, *, • or – followed by a space.
// Captures the bullet text.
const TOP_BULLET_RX = /^([-*•–])\s+(.*)$/;
// Match a sub-bullet: -- followed by a space (we only support `--`
// as the sub-bullet marker — `**` would collide with bold).
const SUB_BULLET_RX = /^--\s+(.*)$/;
// Placeholder line (YAML-only block reminder) — ignored entirely.
const PLACEHOLDER_RX = /^~\s/;
// Callout line.
const CALLOUT_RX = /^>\s+(.*)$/;

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

  // Track whether the most recent non-empty line was a bullet/sub-bullet
  // or a callout. Unprefixed continuation lines (no -, --, >, ~ prefix)
  // belong to whatever block was most recently open, separated by a
  // newline so multi-line worked examples render correctly. A blank
  // line closes the open block.
  type OpenBlock = "bullet" | "callout" | "none";
  let openBlock: OpenBlock = "none";

  for (const rawLine of lines) {
    // Don't trim leading whitespace before the bullet/callout checks
    // (so an indented bullet doesn't accidentally become a sub-bullet),
    // but we trim trailing whitespace for clean parsing.
    const line = rawLine.replace(/\s+$/, "");
    const trimmed = line.trim();
    if (!trimmed) { flushBody(); openBlock = "none"; continue; }
    if (PLACEHOLDER_RX.test(trimmed)) { continue; }
    if (!title) {
      titleRaw = trimmed;
      title = stripBraces(trimmed);
      continue;
    }
    // Sub-bullet — check before top-level (-- starts with -).
    const subMatch = SUB_BULLET_RX.exec(trimmed);
    if (subMatch) {
      flushBody();
      const subRaw = subMatch[1].trim();
      const subVisible = stripBraces(subRaw);
      if (bullets.length === 0) {
        // No parent bullet yet — promote to a top-level bullet.
        bulletsRaw.push(subRaw);
        bullets.push(subVisible);
      } else {
        // Append as indented sub-bullet on the previous bullet line.
        const last = bullets.length - 1;
        bulletsRaw[last] = `${bulletsRaw[last]}\n   • ${subRaw}`;
        bullets[last] = `${bullets[last]}\n   • ${subVisible}`;
      }
      openBlock = "bullet";
      continue;
    }
    const topMatch = TOP_BULLET_RX.exec(trimmed);
    if (topMatch) {
      flushBody();
      const bulletRaw = topMatch[2].trim();
      bulletsRaw.push(bulletRaw);
      bullets.push(stripBraces(bulletRaw));
      openBlock = "bullet";
      continue;
    }
    const calloutMatch = CALLOUT_RX.exec(trimmed);
    if (calloutMatch) {
      flushBody();
      const calloutLineRaw = calloutMatch[1].trim();
      calloutRaw = calloutRaw ? `${calloutRaw} ${calloutLineRaw}` : calloutLineRaw;
      callout = stripBraces(calloutRaw);
      openBlock = "callout";
      continue;
    }
    // Unprefixed line. If the most recent block was a bullet or
    // callout (no blank line since), append this line to it as a
    // continuation. Otherwise it's part of the body paragraph.
    if (openBlock === "bullet" && bullets.length > 0) {
      const last = bullets.length - 1;
      bulletsRaw[last] = `${bulletsRaw[last]}\n${trimmed}`;
      bullets[last] = `${bullets[last]}\n${stripBraces(trimmed)}`;
      continue;
    }
    if (openBlock === "callout") {
      calloutRaw = `${calloutRaw}\n${trimmed}`;
      callout = stripBraces(calloutRaw);
      continue;
    }
    bodyBuf.push(trimmed);
  }
  flushBody();

  // Join paragraphs with a blank line — the renderer turns \n\n into
  // a visual paragraph break.
  const body = bodyParts.join("\n\n") || undefined;

  // Build narration overrides only when raw text differs from visible
  // (i.e. there were {…} segments). Otherwise let the TTS pipeline
  // auto-build from visible content.
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
// admin editor from YAML on first load.
//
// pieChart and scoringExample don't have a textarea representation —
// we emit "~ " placeholder lines so the author KNOWS the slide has
// them attached (and the parser ignores those lines on re-parse).
export function serializeSlideScript(slide: MasterClassSlide): string {
  const parts: string[] = [];
  parts.push(slide.title);

  // YAML-only block reminders, surfaced as placeholder lines.
  const placeholders: string[] = [];
  if (slide.pieChart) {
    const pc = slide.pieChart;
    placeholders.push(`~ Pie chart (YAML-only): ${pc.percentage}% — ${pc.label}${pc.caption ? ` (${pc.caption})` : ""}`);
  }
  if (slide.scoringExample) {
    placeholders.push(`~ Scoring example (YAML-only) — edit in interactions-environment.yaml`);
  }
  if (slide.cta) {
    placeholders.push(`~ CTA button (YAML-only): "${slide.cta.label}"`);
  }
  if (slide.interactiveQuiz?.length) {
    placeholders.push(`~ Interactive quiz (YAML-only): ${slide.interactiveQuiz.length} question(s) — edit in the YAML file`);
  }
  if (placeholders.length) {
    parts.push("");
    parts.push(...placeholders);
  }

  // Body — append any audio-only intro tail as {…} if narration.intro
  // diverges from the visible intro.
  let bodyOut = slide.body ?? "";
  const introNar = slide.narration?.intro?.trim();
  if (introNar) {
    const visibleIntro = [slide.title, slide.body ?? ""].filter(Boolean).join(". ").replace(/\s+/g, " ").trim();
    let audioOnly = introNar.replace(/\s+/g, " ").trim();
    if (audioOnly !== visibleIntro && visibleIntro && audioOnly.startsWith(visibleIntro)) {
      audioOnly = audioOnly.slice(visibleIntro.length).trim().replace(/^[.,;:\s]+/, "");
      if (audioOnly) {
        bodyOut = bodyOut ? `${bodyOut} {${audioOnly}}` : `{${audioOnly}}`;
      }
    }
  }
  if (bodyOut) { parts.push(""); parts.push(bodyOut); }

  if (slide.bullets?.length) {
    parts.push("");
    slide.bullets.forEach((b, i) => {
      // The parser encodes sub-bullets as "\n   • text" inside the
      // bullet string. Split those back into "-- text" lines so the
      // author sees the same shape they typed.
      const SUB_RX = /\n\s*•\s*/g;
      const segments = b.split(SUB_RX);
      const top = segments[0].trim();
      const subs = segments.slice(1).map(s => s.trim()).filter(Boolean);
      const override = slide.narration?.bullets?.[i];
      let topLine: string;
      if (override && override.trim() && override.trim() !== stripBraces(top).trim()) {
        const visible = top.replace(/\s+/g, " ").trim();
        let audioOnly = override.replace(/\s+/g, " ").trim();
        if (visible && audioOnly.startsWith(visible)) {
          audioOnly = audioOnly.slice(visible.length).trim().replace(/^[.,;:\s]+/, "");
        }
        topLine = audioOnly ? `- ${top} {${audioOnly}}` : `- ${top}`;
      } else {
        topLine = `- ${top}`;
      }
      parts.push(topLine);
      for (const sub of subs) parts.push(`-- ${sub}`);
    });
  }

  if (slide.callout) {
    parts.push("");
    const calloutNar = slide.narration?.callout?.trim();
    const flatCallout = slide.callout.replace(/\s*\n\s*/g, " ").trim();
    if (calloutNar && calloutNar !== flatCallout) {
      let audioOnly = calloutNar.replace(/\s+/g, " ").trim();
      if (audioOnly.startsWith(flatCallout)) {
        audioOnly = audioOnly.slice(flatCallout.length).trim().replace(/^[.,;:\s]+/, "");
      }
      parts.push(audioOnly ? `> ${flatCallout} {${audioOnly}}` : `> ${flatCallout}`);
    } else {
      parts.push(`> ${flatCallout}`);
    }
  }

  return parts.join("\n");
}
