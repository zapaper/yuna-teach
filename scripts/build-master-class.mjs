// Build step: convert every src/data/master-class/*.yaml to a sibling
// *.generated.json file. The TS modules import the JSON (works in both
// server and client bundles, unlike the YAML+fs runtime approach which
// fails in client components).
//
// Run via `npm run build` (prebuild hook) and on `npm install`
// (postinstall hook). Authors edit the YAML; this script regenerates
// the JSON before Next bundles.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "src/data/master-class");

if (!fs.existsSync(dataDir)) {
  console.log(`[master-class] No data dir at ${dataDir}, skipping`);
  process.exit(0);
}

// {anything in braces} = audio-only — visible text drops the braced
// segments, narration keeps the text inside (without the braces).
// Kept in sync with src/lib/master-class/parse-script.ts.
const hasBraces = s => typeof s === "string" && /\{[^{}]*\}/.test(s);
const stripBraces = s => s.replace(/\s*\{[^{}]*\}\s*/g, " ").replace(/[ \t]+/g, " ").trim();
const unwrapBraces = s => s.replace(/\{([^{}]*)\}/g, "$1").replace(/[ \t]+/g, " ").trim();

// Walk a slide and lift {...} braces out of the visible fields,
// emitting matching narration overrides so TTS reads the full
// in-context sentence while the slide stays point-form.
function processSlide(slide) {
  if (!slide || typeof slide !== "object") return slide;
  const narration = { ...(slide.narration ?? {}) };
  const out = { ...slide };

  // Intro = title + body joined with ". " (matches what TTS auto-builds).
  // We override only when EITHER has braces; the override carries both.
  const titleHasBraces = hasBraces(out.title);
  const bodyHasBraces = hasBraces(out.body);
  if (titleHasBraces || bodyHasBraces) {
    const titleRaw = out.title ?? "";
    const bodyRaw = out.body ?? "";
    const joinedRaw = [titleRaw, bodyRaw].filter(Boolean).join(". ");
    if (narration.intro === undefined) narration.intro = unwrapBraces(joinedRaw);
    if (titleHasBraces) out.title = stripBraces(titleRaw);
    if (bodyHasBraces) out.body = stripBraces(bodyRaw);
  }

  if (Array.isArray(out.bullets) && out.bullets.some(hasBraces)) {
    const existing = Array.isArray(narration.bullets) ? narration.bullets : [];
    narration.bullets = out.bullets.map((b, i) => {
      if (existing[i] !== undefined && existing[i] !== null) return existing[i];
      return hasBraces(b) ? unwrapBraces(b) : null;
    });
    out.bullets = out.bullets.map(b => hasBraces(b) ? stripBraces(b) : b);
  }

  if (hasBraces(out.callout)) {
    if (narration.callout === undefined) narration.callout = unwrapBraces(out.callout);
    out.callout = stripBraces(out.callout);
  }

  if (Object.keys(narration).length > 0) out.narration = narration;
  return out;
}

function processContent(content) {
  if (!content || typeof content !== "object") return content;
  const out = { ...content };
  if (Array.isArray(out.keyConcepts)) out.keyConcepts = out.keyConcepts.map(processSlide);
  if (Array.isArray(out.commonMistakes)) out.commonMistakes = out.commonMistakes.map(processSlide);
  return out;
}

const yamlFiles = fs.readdirSync(dataDir).filter(f => f.endsWith(".yaml"));
if (yamlFiles.length === 0) {
  console.log(`[master-class] No YAML files in ${dataDir}`);
  process.exit(0);
}

let count = 0;
for (const f of yamlFiles) {
  const yamlPath = path.join(dataDir, f);
  const yamlText = fs.readFileSync(yamlPath, "utf8");
  let parsed;
  try {
    parsed = parseYaml(yamlText);
  } catch (err) {
    console.error(`[master-class] Failed to parse ${f}: ${err.message}`);
    process.exit(1);
  }
  const processed = processContent(parsed);
  const jsonPath = path.join(dataDir, f.replace(/\.yaml$/, ".generated.json"));
  fs.writeFileSync(jsonPath, JSON.stringify(processed, null, 2) + "\n");
  console.log(`[master-class] ${f} → ${path.basename(jsonPath)}`);
  count++;
}
console.log(`[master-class] generated ${count} JSON file${count === 1 ? "" : "s"}`);
