// Generate Chinese-themed panda mascots for chinese-mcq-1.
//
// Reuses the Part 1 teaching panda as a style reference. Reaction
// pandas + CTA are copied from grammar-mcq-2.

import * as fs from "fs";
import * as path from "path";
import { generateContentWithRetry } from "../src/lib/gemini";

const G1_DIR = path.join(__dirname, "..", "public", "master-class", "grammar-mcq-1");
const G2_DIR = path.join(__dirname, "..", "public", "master-class", "grammar-mcq-2");
const OUT_DIR = path.join(__dirname, "..", "public", "master-class", "chinese-mcq-1");
const REFERENCE_PATH = path.join(G1_DIR, "panda-teaching.png");

const STYLE = `Cute panda mascot in the same anime / kawaii style as the reference image. Match the proportions (slightly bigger head than body — not extreme chibi), soft pastel watercolor look, flat shading, big sparkly black eyes, pink cheeks, NO harsh outlines. Pure white background. Aimed at primary-school students aged 10-12.`;

type Pose = { name: string; prompt: string };

const POSES: Pose[] = [
  {
    name: "panda-welcome.png",
    prompt: `${STYLE}

Pose: The panda holds a small open Chinese textbook in both paws at chest height. The book's left page shows the bold title "华文" written in friendly red brushstrokes. The panda wears a small graduation-style mortarboard or a tiny scholar's hat. Big welcoming smile.`,
  },
  {
    name: "panda-teaching-pinyin.png",
    prompt: STYLE + "\n\nPose: The panda stands next to a small chalkboard showing the four Mandarin tone marks: ¯ (level), ´ (rising), ˇ (falling-rising), ˋ (falling), written large in white chalk in a row, with labels \"1 sheng / 2 sheng / 3 sheng / 4 sheng\" beneath them. The panda points at one of the tone marks with a paw. Tutor expression.",
  },
  {
    name: "panda-teaching-character.png",
    prompt: `${STYLE}

Pose: The panda holds up TWO small flashcards — both have the same pinyin "fú" written at the top in friendly handwriting, but one card shows the character "浮" (with water radical) and the other shows "服" (different character). The panda smiles, demonstrating that same-sound characters have different meanings.`,
  },
  {
    name: "panda-teaching-vocabulary.png",
    prompt: `${STYLE}

Pose: The panda holds a small Chinese dictionary (字典) in one paw, with the other paw pointing at a word in the open page. A small magnifying glass hovers over the word. Concentrated, scholarly expression. The dictionary is open showing a couple of Chinese character entries.`,
  },
  {
    name: "panda-teaching-idiom.png",
    prompt: `${STYLE}

Pose: The panda holds up a small ancient-looking SCROLL (rolled paper) with four Chinese characters written down it in vertical brushstrokes: "目不转睛". The panda has a wise, knowing smile — like presenting a famous saying. The scroll has subtle decorative red tassels at the top.`,
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
        { text: pose.prompt + "\n\nMatch the panda character style of the reference image EXACTLY — same colors, same eye shape, same body proportions, same artistic style. Only the pose, props, and scene should differ. Any Chinese characters should be rendered cleanly and legibly." },
      ],
    }],
    config: { responseModalities: ["IMAGE", "TEXT"] },
  }, 1, 3000, `panda-zh-${pose.name}`);

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
    try { await generateOne(pose, referenceBuf); }
    catch (err) { console.error(`  ${pose.name} FAILED:`, (err as Error).message); }
  }

  // Copy shared reaction + CTA pandas
  for (const f of ["panda-thinking.png", "panda-correct.png", "panda-wrong.png", "panda-cta.png"]) {
    const src = path.join(G2_DIR, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(OUT_DIR, f));
      console.log(`  copied ${f}`);
    }
  }
  console.log("\nDone.");
})();
