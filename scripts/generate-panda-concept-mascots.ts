// Generate concept-specific panda mascots for Grammar MCQ Part 1
// teaching slides. Each panda holds / points at a small symbol that
// matches what the slide teaches.
//
// Uses the existing panda-teaching.png as a style reference so the
// character stays consistent across poses.
//
// Output → /public/master-class/grammar-mcq-1/
//   panda-teaching-mirror.png       (tag questions — mirror)
//   panda-teaching-infinity.png     (countable / uncountable — ∞)
//   panda-teaching-sva.png          (subject-verb agreement — "is/are")
//   panda-teaching-pronouns.png     (pronouns — "I / me / myself")

import * as fs from "fs";
import * as path from "path";
import { generateContentWithRetry } from "../src/lib/gemini";

const PUB_DIR = path.join(__dirname, "..", "public", "master-class", "grammar-mcq-1");
const REFERENCE_PATH = path.join(PUB_DIR, "panda-teaching.png");

const STYLE = `Cute panda mascot in the same anime / kawaii style as the reference image. Match the proportions (slightly bigger head than body — not extreme chibi), soft pastel watercolor look, flat shading, big sparkly black eyes, pink cheeks, NO harsh outlines. Pure white background. Friendly tutor energy. Aimed at primary-school students aged 10-12.`;

type Pose = { name: string; prompt: string };

const POSES: Pose[] = [
  {
    name: "panda-teaching-mirror.png",
    prompt: `${STYLE}

Pose: The panda stands next to a small handheld MIRROR (oval, with a handle, like a vanity mirror). The panda holds the mirror up at chest height with one paw, gesturing at the mirror with the other paw — like demonstrating "look, the reflection mirrors what's there". Confident teacher expression. The mirror surface is shiny silver/light blue.`,
  },
  {
    name: "panda-teaching-infinity.png",
    prompt: `${STYLE}

Pose: The panda stands next to a small chalkboard or easel that shows a LARGE infinity symbol "∞" written in white chalk. The panda is pointing at the infinity sign with one paw, smiling — explaining that some things (like water, advice, luck) cannot be counted because they have no number boundary. Curious, friendly expression.`,
  },
  {
    name: "panda-teaching-sva.png",
    prompt: `${STYLE}

Pose: The panda stands next to a small chalkboard that shows the text "is / are" with a small ARROW between them, written in white chalk. The panda is pointing at the chalkboard with one paw, demonstrating the choice between singular ("is") and plural ("are") verb forms. Focused tutor expression.`,
  },
  {
    name: "panda-teaching-pronouns.png",
    prompt: `${STYLE}

Pose: The panda stands next to a small chalkboard showing "I → me → myself" written in white chalk on three lines (or with arrows between them). The panda is pointing at the chalkboard with one paw and pointing at ITSELF with the other paw — like showing how pronouns refer back to the speaker. Bright, expressive eyes.`,
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
        { text: pose.prompt + "\n\nMatch the panda character style of the reference image EXACTLY — same colors, same eye shape, same body proportions, same artistic style. Only the pose, props, and what's written on the chalkboard / object should differ." },
      ],
    }],
    config: { responseModalities: ["IMAGE", "TEXT"] },
  }, 1, 3000, `panda-concept-${pose.name}`);

  const parts = res.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    const inline = (p as { inlineData?: { data?: string; mimeType?: string } }).inlineData;
    if (inline?.data) {
      const buf = Buffer.from(inline.data, "base64");
      const outPath = path.join(PUB_DIR, pose.name);
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
  const referenceBuf = fs.readFileSync(REFERENCE_PATH);
  console.log(`Reference: ${REFERENCE_PATH} (${(referenceBuf.length / 1024).toFixed(0)} KB)\n`);
  for (const pose of POSES) {
    try {
      await generateOne(pose, referenceBuf);
    } catch (err) {
      console.error(`  ${pose.name} FAILED:`, (err as Error).message);
    }
  }
  console.log("\nDone. Check the 4 concept-specific mascots.");
})();
