// Add audio-only narration fillers (in `{...}` braces) to master class
// YAML slides so the spoken narration reads as natural full sentences
// while the visible bullets stay point-form.
//
// The convention is already supported by the master class system:
// `{...}` text inside a bullet/body/callout is stripped from the
// visible slide but kept in the TTS audio (see parse-script.ts:
// stripBraces / unwrapBraces).
//
// This script reads a YAML, sends each slide's text to gemini-3.1-pro
// to suggest filler additions, and writes back an enhanced version of
// the YAML. Visible content is preserved character-for-character —
// only `{...}` filler is added.

import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml, stringify as stringifyYaml, Document, isMap, isScalar, isSeq } from "yaml";
import { generateContentWithRetry } from "../src/lib/gemini";

// CLI: pass YAML filenames as args to target specific files; default = ALL
// master-class YAMLs (idempotent — won't double-add filler to existing braces).
// Run with: npx tsx -r dotenv/config scripts/add-narration-fillers.ts dotenv_config_path=.env
const ARG_YAMLS = process.argv.slice(2).filter(a => a.endsWith(".yaml"));
// Modules WITHOUT existing filler — running on these adds braces from scratch.
// grammar-mcq-1/2 already have ~45-50 filler braces from an earlier pass —
// excluded to avoid double-adding.
const DEFAULT_YAMLS = [
  "chinese-mcq-1.yaml",
  "chinese-oeq-setpieces.yaml",
  "chinese-idioms.yaml",
  "chinese-sentence-completion.yaml",
  "chinese-cloze.yaml",
  "chinese-comprehension.yaml",
  "english-synthesis-tricks.yaml",
  "science-diversity.yaml",
];
const TARGET_YAMLS = ARG_YAMLS.length > 0 ? ARG_YAMLS : DEFAULT_YAMLS;

type Slide = {
  title?: string;
  body?: string;
  bullets?: string[];
  callout?: string;
};

function detectLanguage(yamlPath: string): "zh" | "en" {
  return yamlPath.includes("chinese") ? "zh" : "en";
}

// Prompt asks Gemini to ADD {...} filler around each unit so the audio
// reads as a complete sentence; visible text must remain identical
// after the braces are stripped.
function buildPrompt(lang: "zh" | "en", slide: Slide): string {
  const langName = lang === "zh" ? "中文 (Chinese)" : "English";
  const fillerExamples = lang === "zh"
    ? `Chinese fillers e.g. "接下来", "现在我们看", "也就是说", "举个例子", "其实呢", "总的来说", "好, ", "再来", "比如", "另外", "顺便提一下", "记住一点"`
    : `English fillers e.g. "Now, ", "Let's look at", "So basically, ", "For example, ", "Remember that, ", "Here's the key:", "Quickly, ", "Next up, ", "By the way, "`;

  return `You are enhancing master-class slide content for TEXT-TO-SPEECH narration. The slide is in ${langName}.

The visible bullets are intentionally TERSE / point-form. But when read aloud as-is, they sound disjointed.

Your task: ADD audio-only filler text inside curly braces { } so the spoken version reads as smooth, natural full sentences. The braces will be STRIPPED from the visible slide but KEPT in the audio.

CRITICAL RULES:
1. NEVER change the existing visible text (the part outside braces). Not even whitespace, punctuation, capitalization, bullets, bold/italic markup.
2. ADD curly-brace segments {...} before, between, or after the existing text to bridge into spoken sentences.
3. Filler should sound like a friendly tutor explaining (${fillerExamples}).
4. Each bullet, body paragraph, and callout should — when its braces are unwrapped — read as a smooth complete sentence/paragraph.
5. Keep filler CONCISE — typically 3-15 characters per insertion. Don't make the audio dramatically longer than the visible.
6. The visible bullets should still parse as their original bullet structure after the braces are stripped.

Return ONLY valid JSON in this exact shape:
{
  "title": "<title with optional {...} fillers>",
  "body": "<body with optional {...} fillers, or null if no body>",
  "bullets": [
    "<bullet 1 with {...} fillers>",
    "<bullet 2 with {...} fillers>",
    ...
  ],
  "callout": "<callout with optional {...} fillers, or null>"
}

Slide content to enhance:
Title: ${slide.title ?? ""}
Body: ${slide.body ?? "(none)"}
Bullets:
${(slide.bullets ?? []).map((b, i) => `${i + 1}. ${b}`).join("\n") || "(none)"}
Callout: ${slide.callout ?? "(none)"}`;
}

async function enhanceSlide(slide: Slide, lang: "zh" | "en"): Promise<Slide | null> {
  const prompt = buildPrompt(lang, slide);
  const res = await generateContentWithRetry({
    model: "gemini-3.1-pro-preview",
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseMimeType: "application/json", temperature: 0.3 },
  }, 1, 3000, `narration`);
  const text = (res.text ?? "").trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Slide;
  } catch {
    return null;
  }
}

/** Validate that stripping {...} from enhanced text yields the original. */
function stripBraces(s: string): string {
  return s.replace(/\s*\{[^{}]*\}\s*/g, " ").replace(/[ \t]+/g, " ").trim();
}
function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
function isFaithful(original: string, enhanced: string): boolean {
  return normalize(stripBraces(enhanced)) === normalize(original);
}

(async () => {
  const target = process.argv[2];
  if (!target) {
    console.error(`Usage: tsx add-narration-fillers.ts <yaml-filename>`);
    console.error(`Available: ${TARGET_YAMLS.join(", ")}`);
    process.exit(1);
  }
  const yamlPath = path.join(__dirname, "..", "src", "data", "master-class", target);
  if (!fs.existsSync(yamlPath)) {
    console.error(`Not found: ${yamlPath}`);
    process.exit(1);
  }
  const lang = detectLanguage(target);
  console.log(`Enhancing ${target} (lang=${lang})...`);

  // Round-trip via yaml library to preserve formatting where possible.
  const raw = fs.readFileSync(yamlPath, "utf8");
  const doc = parseYaml(raw) as { keyConcepts?: Slide[] };
  const slides: Slide[] = doc.keyConcepts ?? [];
  console.log(`  ${slides.length} slides`);

  let edited = raw;
  let touched = 0;
  let skipped = 0;

  // Process slide-by-slide. For each slide, get enhancement, then
  // ONLY apply faithful replacements (where stripping braces yields
  // the original).
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    process.stdout.write(`  slide ${i + 1}/${slides.length}: ${slide.title?.slice(0, 30) ?? ""}... `);
    try {
      const enhanced = await enhanceSlide(slide, lang);
      if (!enhanced) { console.log("(empty)"); skipped++; continue; }

      // Apply faithful replacements only.
      let slideEdited = 0;
      // Body
      if (slide.body && enhanced.body && enhanced.body !== slide.body && isFaithful(slide.body, enhanced.body)) {
        edited = edited.replace(slide.body, enhanced.body);
        slideEdited++;
      }
      // Bullets
      if (slide.bullets && enhanced.bullets) {
        for (let bi = 0; bi < slide.bullets.length; bi++) {
          const orig = slide.bullets[bi];
          const enh = enhanced.bullets[bi];
          if (enh && enh !== orig && isFaithful(orig, enh)) {
            edited = edited.replace(orig, enh);
            slideEdited++;
          }
        }
      }
      // Callout
      if (slide.callout && enhanced.callout && enhanced.callout !== slide.callout && isFaithful(slide.callout, enhanced.callout)) {
        edited = edited.replace(slide.callout, enhanced.callout);
        slideEdited++;
      }
      console.log(`+${slideEdited} edits`);
      touched += slideEdited;
    } catch (err) {
      console.log(`FAILED: ${(err as Error).message}`);
      skipped++;
    }
  }

  // Sanity-check: re-parse the edited YAML to make sure it's still valid.
  try {
    parseYaml(edited);
  } catch (err) {
    console.error(`\nYAML invalid after edits — NOT writing. Error: ${(err as Error).message}`);
    process.exit(1);
  }

  fs.writeFileSync(yamlPath, edited, "utf8");
  console.log(`\nDone. ${touched} replacements applied, ${skipped} slides skipped.`);
  console.log(`Wrote ${yamlPath}`);
  // Silence unused
  void Document; void isMap; void isScalar; void isSeq; void stringifyYaml;
})();
