// Generate the FULL set of 5 panda mascot poses, using the approved
// panda-teaching.png as a style reference so the character stays
// consistent across poses.
//
// Output (all to /public/master-class/grammar-mcq-1/):
//   panda-welcome.png   (regenerated — slightly bigger head than before)
//   panda-thinking.png  (paw to chin, neutral)
//   panda-correct.png   (celebrating, peace sign)
//   panda-wrong.png     (encouraging, "let's try again")
//   panda-cta.png       (holding "Ready!" sign, gesturing forward)

import * as fs from "fs";
import * as path from "path";
import { generateContentWithRetry } from "../src/lib/gemini";

const PUB_DIR = path.join(__dirname, "..", "public", "master-class", "grammar-mcq-1");
const REFERENCE_PATH = path.join(PUB_DIR, "panda-teaching.png");

// Slight tweak from the original style — head a touch bigger, body a
// touch smaller. NOT extreme chibi proportions.
const STYLE = `Cute panda mascot in anime / kawaii style. Head is a TOUCH larger than the body (slightly bigger head, slightly smaller body — not extreme chibi). Soft pastel watercolor, flat shading with light shadows. Big sparkly black eyes, small round ears, pink cheeks. NO harsh outlines, NO complex backgrounds. Pure white background. Same character style as the reference image — keep the proportions, colors, and expression style consistent. Aimed at primary-school students aged 10-12.`;

type Pose = { name: string; prompt: string };

const POSES: Pose[] = [
  {
    name: "panda-welcome.png",
    prompt: `${STYLE}

Pose: The panda is standing and waving HELLO with one paw raised in greeting. In the other paw, it holds a small chalkboard or signboard reading "Grammar MCQ" in friendly hand-written letters. Big warm smile — welcoming the student to the lesson.`,
  },
  {
    name: "panda-thinking.png",
    prompt: `${STYLE}

Pose: The panda is thinking — one paw raised to its chin, head slightly tilted, eyes looking up and to the side, neutral curious expression. Like it's pondering a question alongside the student. Soft, contemplative energy.`,
  },
  {
    name: "panda-correct.png",
    prompt: `${STYLE}

Pose: The panda is CELEBRATING getting an answer right — both paws raised in a small cheer, peace sign with one paw, big happy smile with sparkly eyes. A few small sparkles or stars float around it. Joyful but not over-the-top.`,
  },
  {
    name: "panda-wrong.png",
    prompt: `${STYLE}

Pose: The panda is gently ENCOURAGING — one paw raised in a small "it's ok, let's try again" gesture, soft warm smile, kind eyes. A small heart or thumbs-up nearby. NOT sad, NOT crying — just supportive. Conveys "good try, no problem".`,
  },
  {
    name: "panda-cta.png",
    prompt: `${STYLE}

Pose: The panda is gesturing FORWARD with one paw — like "let's go!" — holding up a small sign with the other paw that reads "Ready?" in friendly handwritten letters. Excited smile. Suggests "time to practice".`,
  },
];

async function generateOne(pose: Pose, referenceBuf: Buffer): Promise<void> {
  console.log(`Generating ${pose.name}...`);
  const res = await generateContentWithRetry({
    model: "gemini-2.5-flash-image",
    contents: [{
      role: "user",
      parts: [
        // Reference image first so the model anchors style off it.
        { inlineData: { mimeType: "image/png", data: referenceBuf.toString("base64") } },
        { text: pose.prompt + "\n\nMatch the panda style of the reference image exactly." },
      ],
    }],
    config: { responseModalities: ["IMAGE", "TEXT"] },
  }, 1, 3000, `panda-full-${pose.name}`);

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
  console.log(`Using ${REFERENCE_PATH} as style reference (${(referenceBuf.length / 1024).toFixed(0)} KB)`);
  console.log();
  for (const pose of POSES) {
    try {
      await generateOne(pose, referenceBuf);
    } catch (err) {
      console.error(`  ${pose.name} FAILED:`, (err as Error).message);
    }
  }
  console.log("\nDone. Check all 5 images.");
})();
