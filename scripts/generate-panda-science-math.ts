// Generate panda mascots for the science / math master classes:
//   - Patterns (math)
//   - Electrical Circuits (science)
//   - Interactions Environment (science)
//
// Reuses the Part 1 teaching panda as a style reference so the
// character stays consistent across every deck. Worked-example
// slides already have diagrams, so they don't get mascots
// (avoiding visual competition). Reaction pandas (thinking /
// correct / wrong) + the CTA panda are copied from grammar-mcq-2.

import * as fs from "fs";
import * as path from "path";
import { generateContentWithRetry } from "../src/lib/gemini";

const G1_DIR = path.join(__dirname, "..", "public", "master-class", "grammar-mcq-1");
const G2_DIR = path.join(__dirname, "..", "public", "master-class", "grammar-mcq-2");
const REFERENCE_PATH = path.join(G1_DIR, "panda-teaching.png");

const STYLE = `Cute panda mascot in the same anime / kawaii style as the reference image. Match the proportions (slightly bigger head than body — not extreme chibi), soft pastel watercolor look, flat shading, big sparkly black eyes, pink cheeks, NO harsh outlines. Pure white background. Aimed at primary-school students aged 10-12.`;

type Pose = { folder: string; name: string; prompt: string };

const POSES: Pose[] = [
  // ── Patterns (math) ──────────────────────────────────────────────
  {
    folder: "patterns",
    name: "panda-welcome.png",
    prompt: `${STYLE}

Pose: The panda is sitting at a small school desk with an OPEN NOTEBOOK in front of it. The notebook has a number sequence visible: "1, 3, 5, 7, ?". The panda holds a pencil in one paw and looks up with a curious smile, like inviting the student to figure out what comes next.`,
  },
  {
    folder: "patterns",
    name: "panda-teaching-differences.png",
    prompt: `${STYLE}

Pose: The panda stands next to a small chalkboard showing a number sequence "2, 5, 8, 11" with arrows BETWEEN the numbers and "+3" written above each arrow. The panda points at the "+3" with one paw — demonstrating the constant difference. Focused tutor expression.`,
  },
  {
    folder: "patterns",
    name: "panda-teaching-subpatterns.png",
    prompt: `${STYLE}

Pose: The panda holds a small MAGNIFYING GLASS in one paw and looks through it at a sequence of objects (like beads or shapes) arranged in a curving pattern. Suggests "spot the hidden sub-pattern". Concentrated, detective-like expression.`,
  },
  {
    folder: "patterns",
    name: "panda-teaching-nth-term.png",
    prompt: `${STYLE}

Pose: The panda stands next to a small chalkboard showing a division: "Term ÷ 4 = Q, R". The panda holds chalk in one paw. The board has "Q" and "R" labelled clearly. Demonstrates the divide-then-remainder approach. Thoughtful expression.`,
  },
  {
    folder: "patterns",
    name: "panda-teaching-figures.png",
    prompt: `${STYLE}

Pose: The panda is arranging small geometric shapes (a triangle, a square, a circle) into a row on the ground in front of it. Looks like it's building a figure pattern. Curious, playful smile.`,
  },
  {
    folder: "patterns",
    name: "panda-teaching-action.png",
    prompt: `${STYLE}

Pose: The panda wears a small DETECTIVE'S DEERSTALKER HAT (Sherlock Holmes-style cap) and holds a magnifying glass in one paw — ready to investigate worked examples. Confident, "let's solve this" expression.`,
  },

  // ── Electrical Circuits (science) ────────────────────────────────
  {
    folder: "electrical-circuits",
    name: "panda-welcome.png",
    prompt: `${STYLE}

Pose: The panda holds a small GLOWING LIGHT BULB in one paw raised above its head. Tiny yellow rays / sparkles around the bulb. Big delighted smile — like just had a bright idea. The bulb has a visible filament and a small glass shape.`,
  },
  {
    folder: "electrical-circuits",
    name: "panda-teaching-circuit-diagram.png",
    prompt: `${STYLE}

Pose: The panda stands next to a small chalkboard with a simple CIRCUIT DIAGRAM drawn in white chalk: a rectangle representing the circuit with a battery symbol on one side and two bulb symbols on the wire. The panda points at the diagram with a pencil. Tutor expression.`,
  },
  {
    folder: "electrical-circuits",
    name: "panda-teaching-fuse.png",
    prompt: `${STYLE}

Pose: The panda holds up a small CARTOON FUSE (a thin glass tube with a wire inside) that has BLOWN — the wire inside is broken with a small puff of smoke. The panda's expression is "uh oh" but calm — explaining how a blown fuse breaks the circuit.`,
  },
  {
    folder: "electrical-circuits",
    name: "panda-teaching-brightness.png",
    prompt: `${STYLE}

Pose: The panda stands between TWO lit light bulbs — one VERY BRIGHT (lots of yellow rays around it) on the left, and one DIMMER (fewer / shorter rays) on the right. The panda looks at them comparing, with one paw on its chin. Demonstrates bulb brightness comparison.`,
  },
  {
    folder: "electrical-circuits",
    name: "panda-teaching-electromagnet.png",
    prompt: `${STYLE}

Pose: The panda holds a small horseshoe-shaped MAGNET in one paw with several small metal objects (paper clips, nails) being attracted to it — shown floating toward the magnet with small motion lines. The panda smiles, demonstrating magnetic attraction.`,
  },

  // ── Interactions Environment (science) ────────────────────────────
  {
    folder: "interactions-environment",
    name: "panda-welcome.png",
    prompt: `${STYLE}

Pose: The panda stands in a tiny forest setting — with a small green leaf in one paw and a tiny butterfly resting on its other paw. A few small flowers near its feet. Cheerful eco-friendly mood. White background, with just hints of nature around the panda.`,
  },
  {
    folder: "interactions-environment",
    name: "panda-teaching-definitions.png",
    prompt: `${STYLE}

Pose: The panda holds up a small open DICTIONARY or vocabulary book in front of it. The book pages show short labels like "Producer", "Consumer", "Decomposer" written in friendly handwriting. The panda points at one of the words with its paw. Studious expression.`,
  },
  {
    folder: "interactions-environment",
    name: "panda-teaching-food-web.png",
    prompt: `${STYLE}

Pose: The panda stands next to a small whiteboard showing a simple FOOD WEB diagram in white chalk: small drawings of a leaf, a grasshopper, and a bird connected by arrows ("→"). The panda points at one of the arrows. Demonstrates how energy flows.`,
  },
  {
    folder: "interactions-environment",
    name: "panda-teaching-causal-chain.png",
    prompt: `${STYLE}

Pose: The panda stands behind a row of small DOMINOES that are partway through falling — the first one tipping into the second, and so on in a chain. The panda's eyes follow the chain with an "aha!" expression — demonstrating cause-and-effect chain reasoning.`,
  },
  {
    folder: "interactions-environment",
    name: "panda-teaching-mutual-benefits.png",
    prompt: `${STYLE}

Pose: TWO small friendly creatures (e.g. the panda and a tiny BIRD perched on its shoulder) are smiling at each other. Small heart between them. Shows mutual benefit relationship — two species helping each other.`,
  },
  {
    folder: "interactions-environment",
    name: "panda-teaching-adaptation.png",
    prompt: `${STYLE}

Pose: The panda is wearing a small DESERT SUN HAT and holds a tiny canteen of water — looking like it adapted for a hot environment. Or alternatively: panda has small fluffy adapted features (e.g. tiny snowshoes). Demonstrates "feature → helps survive in environment". Determined, adventurous expression.`,
  },
  {
    folder: "interactions-environment",
    name: "panda-teaching-decomposer.png",
    prompt: `${STYLE}

Pose: The panda holds up a small leaf that's partially decomposed (curled, brown edges), with tiny mushrooms growing near its feet. A small recycling-like arrow loop near the leaf. Demonstrates decomposers breaking down material. Gentle, curious expression.`,
  },
  {
    folder: "interactions-environment",
    name: "panda-teaching-human-impact.png",
    prompt: `${STYLE}

Pose: The panda holds a small EARTH (planet globe with blue oceans and green continents) gently in both paws at chest height. Soft, caring expression — demonstrating how humans affect the planet. A few small green leaves near the panda.`,
  },
];

async function generateOne(pose: Pose, referenceBuf: Buffer): Promise<void> {
  const outDir = path.join(__dirname, "..", "public", "master-class", pose.folder);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, pose.name);
  console.log(`Generating ${pose.folder}/${pose.name}...`);
  const res = await generateContentWithRetry({
    model: "gemini-2.5-flash-image",
    contents: [{
      role: "user",
      parts: [
        { inlineData: { mimeType: "image/png", data: referenceBuf.toString("base64") } },
        { text: pose.prompt + "\n\nMatch the panda character style of the reference image EXACTLY — same colors, same eye shape, same body proportions, same artistic style. Only the pose, props, and scene should differ." },
      ],
    }],
    config: { responseModalities: ["IMAGE", "TEXT"] },
  }, 1, 3000, `panda-${pose.folder}-${pose.name}`);

  const parts = res.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    const inline = (p as { inlineData?: { data?: string; mimeType?: string } }).inlineData;
    if (inline?.data) {
      const buf = Buffer.from(inline.data, "base64");
      fs.writeFileSync(outPath, buf);
      console.log(`  wrote ${outPath} (${(buf.length / 1024).toFixed(0)} KB)`);
      return;
    }
  }
  console.log(`  ⚠️ no image returned for ${pose.folder}/${pose.name}`);
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

  // Copy the shared reaction pandas + CTA panda from grammar-mcq-2
  // into each science/math folder so the YAML can reference local
  // paths.
  const SHARED = ["panda-thinking.png", "panda-correct.png", "panda-wrong.png", "panda-cta.png"];
  const FOLDERS = ["patterns", "electrical-circuits", "interactions-environment"];
  for (const folder of FOLDERS) {
    const dst = path.join(__dirname, "..", "public", "master-class", folder);
    if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
    for (const f of SHARED) {
      const src = path.join(G2_DIR, f);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(dst, f));
        console.log(`  copied ${f} → ${folder}/`);
      }
    }
  }

  console.log("\nDone.");
})();
