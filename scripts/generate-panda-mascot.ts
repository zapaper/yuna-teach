// Generate 2 sample panda mascot images for the Grammar MCQ Part 1
// master class. If the style works, we generate the remaining poses
// (thinking, correct, wrong, cta) afterwards.
//
// Output:  /public/master-class/grammar-mcq-1/panda-welcome.png
//          /public/master-class/grammar-mcq-1/panda-teaching.png

import * as fs from "fs";
import * as path from "path";
import { generateContentWithRetry } from "../src/lib/gemini";

const OUT_DIR = path.join(__dirname, "..", "public", "master-class", "grammar-mcq-1");

// Shared style preamble. Same across all poses to keep the character
// consistent. We're aiming for a friendly anime / chibi panda — clean
// flat-shading, soft pastel colors, no harsh outlines, transparent or
// white background so the image sits naturally in the top-right corner
// of a master-class slide.
const STYLE = `Cute chibi panda mascot, anime / kawaii style. EXAGGERATED CHIBI PROPORTIONS — head is OVERSIZED, roughly 1.5× the body's width, body is small and stubby. Think classic chibi head-to-body ratio (head almost as large as the body). Soft pastel watercolor look, flat shading with light shadows, gentle expressions. Large head, big sparkly black eyes, small round ears, simple snout, pink cheeks. Tiny stubby body and limbs. NO harsh outlines, NO complex backgrounds. Pure white background or transparent. The panda fills most of the frame but leaves comfortable margin. Designed for a primary-school (P5-P6, ages 10-12) educational app — looks friendly and approachable, not too cartoonish, not babyish.`;

type Pose = { name: string; prompt: string };

const POSES: Pose[] = [
  {
    name: "panda-welcome.png",
    prompt: `${STYLE}

Pose: The panda is standing and waving HELLO with one paw raised in greeting. In the other paw, it holds a small chalkboard or signboard reading "Grammar MCQ" in friendly hand-written letters. The panda has a big, warm smile — making the student feel welcomed to the lesson. Background: pure white.`,
  },
  {
    name: "panda-teaching.png",
    prompt: `${STYLE}

Pose: The panda is in a "teaching" stance, standing next to a small whiteboard or holding a pointer stick. It's pointing toward something invisible (the lesson content) with an encouraging, focused expression — like a friendly tutor explaining a rule. Eyes are bright and confident. Background: pure white.`,
  },
];

async function generateOne(pose: Pose): Promise<void> {
  console.log(`Generating ${pose.name}...`);
  const res = await generateContentWithRetry({
    model: "gemini-2.5-flash-image",
    contents: [{ role: "user", parts: [{ text: pose.prompt }] }],
    config: { responseModalities: ["IMAGE", "TEXT"] },
  }, 1, 3000, `panda-${pose.name}`);

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
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  // Sequential to stay polite with image-gen quota.
  for (const pose of POSES) {
    try {
      await generateOne(pose);
    } catch (err) {
      console.error(`  ${pose.name} FAILED:`, (err as Error).message);
    }
  }
  console.log("\nDone. Check the 2 sample images.");
})();
