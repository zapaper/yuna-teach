// Generate the panda mascot set for Grammar MCQ Part 2.
// More creative concept-specific poses than Part 1 — moving past
// "panda at a chalkboard" to scenes/props that match each rule
// family.
//
// Reuses the Part 1 teaching panda as a style anchor so the
// character stays consistent across both decks.
//
// Output → /public/master-class/grammar-mcq-2/
//   panda-welcome.png            (Part 2 cover — explorer panda)
//   panda-teaching-verb-forms.png  (juggling 3 verb-form cards)
//   panda-teaching-connectors.png  (bridge linking two thought bubbles)
//   panda-teaching-tense.png       (hourglass + time arrow)
//   panda-teaching-prepositions.png (puzzle-piece matching)
//   panda-cta.png                  (sneakers at a starting line)

import * as fs from "fs";
import * as path from "path";
import { generateContentWithRetry } from "../src/lib/gemini";

const PART1_DIR = path.join(__dirname, "..", "public", "master-class", "grammar-mcq-1");
const OUT_DIR = path.join(__dirname, "..", "public", "master-class", "grammar-mcq-2");
const REFERENCE_PATH = path.join(PART1_DIR, "panda-teaching.png");

const STYLE = `Cute panda mascot in the same anime / kawaii style as the reference image. Match the proportions (slightly bigger head than body — not extreme chibi), soft pastel watercolor look, flat shading, big sparkly black eyes, pink cheeks, NO harsh outlines. Pure white background. Aimed at primary-school students aged 10-12.`;

type Pose = { name: string; prompt: string };

const POSES: Pose[] = [
  {
    name: "panda-welcome.png",
    prompt: `${STYLE}

Pose: The panda is dressed as a friendly little EXPLORER, with a small adventure backpack on its back and a tiny flag in one paw that says "Part 2" in handwritten letters. Big confident smile, one paw raised in a "let's go!" gesture. Like inviting the student on the next leg of the journey.`,
  },
  {
    name: "panda-teaching-verb-forms.png",
    prompt: `${STYLE}

Pose: The panda is JUGGLING THREE COLORED CARDS in the air around its head. Each card has one verb form label clearly written:
  - Card 1 (pink): "-ing"
  - Card 2 (blue): "to + verb"
  - Card 3 (yellow): "base"
The panda has a focused, playful expression — like demonstrating that the three verb forms are different choices the student must pick between. The cards are arc'd above the panda like circus juggling.`,
  },
  {
    name: "panda-teaching-connectors.png",
    prompt: `${STYLE}

Pose: The panda is holding up a small BRIDGE or CHAIN-LINK between two soft cloud-shaped thought bubbles. One bubble is on the left and one is on the right; the panda stands in the middle with the bridge connecting them. Inside the left bubble there's a small "A" letter, inside the right bubble a small "B". Demonstrates how connectors link two clauses together.`,
  },
  {
    name: "panda-teaching-tense.png",
    prompt: `${STYLE}

Pose: The panda is holding a small wooden HOURGLASS (sand timer) in both paws at chest height. Above the panda's head floats a small clock face showing simple "←" past, "•" present, "→" future arrows. Curious expression — like showing how words signal which time we're talking about.`,
  },
  {
    name: "panda-teaching-prepositions.png",
    prompt: `${STYLE}

Pose: The panda is holding two small JIGSAW PUZZLE PIECES — fitting them together. Each piece has a preposition written on it ("on" on one, "of" on the other) so they snap together as a matched pair. Concentrated, satisfied expression — showing how prepositions belong with specific words.`,
  },
  {
    name: "panda-cta.png",
    prompt: `${STYLE}

Pose: The panda is at a small starting line on the ground (a chalk line with "START" written on it). The panda is in a friendly "ready to run" stance, with one paw raised pointing forward. A small flag near it reads "Go!" or "Practice!". Excited, energetic smile.`,
  },
];

async function generateOne(pose: Pose, referenceBuf: Buffer): Promise<void> {
  console.log(`Generating ${pose.name}...`);
  const res = await generateContentWithRetry({
    model: "gemini-2.5-flash-image",
    contents: [{
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/png", data: referenceBuf.toString("base64") } },
        { text: pose.prompt + "\n\nMatch the panda character style of the reference image EXACTLY — same colors, same eye shape, same body proportions, same artistic style. Only the pose and props should differ from the reference." },
      ],
    }],
    config: { responseModalities: ["IMAGE", "TEXT"] },
  }, 1, 3000, `panda-g2-${pose.name}`);

  const parts = res.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    const inline = (p as { inlineData?: { data?: string; mimeType?: string } }).inlineData;
    if (inline?.data) {
      const buf = Buffer.from(inline.data, "base64");
      const outPath = path.join(OUT_DIR, pose.name);
      fs.writeFileSync(outPath, buf);
      console.log(`  wrote ${outPath} (${(buf.length / 1024).toFixed(0)} KB)`);
      return;
    }
  }
  console.log(`  ⚠️ no image returned for ${pose.name}`);
}

(async () => {
  if (!fs.existsSync(REFERENCE_PATH)) {
    console.error(`Reference panda-teaching.png not found at ${REFERENCE_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const referenceBuf = fs.readFileSync(REFERENCE_PATH);
  console.log(`Reference: ${REFERENCE_PATH} (${(referenceBuf.length / 1024).toFixed(0)} KB)\n`);

  for (const pose of POSES) {
    try {
      await generateOne(pose, referenceBuf);
    } catch (err) {
      console.error(`  ${pose.name} FAILED:`, (err as Error).message);
    }
  }

  // Reuse reaction pandas from Part 1 (thinking / correct / wrong) —
  // they're emotional poses, not tied to specific content. Copy them
  // into the Part 2 folder so the YAML can reference its own paths
  // without cross-folder leakage.
  for (const f of ["panda-thinking.png", "panda-correct.png", "panda-wrong.png"]) {
    const src = path.join(PART1_DIR, f);
    const dst = path.join(OUT_DIR, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      console.log(`  copied ${f} from Part 1`);
    }
  }

  console.log("\nDone.");
})();
