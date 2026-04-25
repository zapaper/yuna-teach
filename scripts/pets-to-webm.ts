// Re-encode pet clips to VP9 WebMs with clean alpha channels.
//
// All pet sources (.mp4 and .mov) are HEVC/h264 yuv420p — no alpha. They were
// rendered against a solid black background, so the conversion to alpha is a
// chroma-key step.
//
// The previous attempt used chromakey with similarity=0.03 + blend=0.08. That
// produced translucent bodies because the blend gradient extended into dark
// interior pixels (eyes, shadows fell inside the [0.03, 0.11] alpha ramp and
// ended up as semi-transparent). The fix is twofold:
//   • switch to `colorkey` (RGB Euclidean distance) — more predictable than
//     `chromakey` (YUV) for a solid black backdrop, since YUV chroma channels
//     pick up subtle compression noise on near-black pixels.
//   • set blend=0 (hard cut), so alpha is binary inside the matte and there
//     is no translucency on the body itself.
// Edge anti-alias still works because the source frame already has rendered
// edge pixels — we just decide each one is in or out, no gradient.
//
// Run: npx tsx scripts/pets-to-webm.ts
//
// Takes ~1–2 min per clip.

import ffmpegStatic from "ffmpeg-static";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

const FFMPEG = ffmpegStatic as unknown as string;
const AVATARS = path.join(process.cwd(), "public/avatars");

const CLIPS = ["smile", "stretch", "walk", "talk"] as const;
const PETS = ["unicorn", "dragon", "qilin", "merlion", "otter"] as const;

type Job = {
  pet: string;
  clip: string;
  source: string;
};

function build(): Job[] {
  const jobs: Job[] = [];
  for (const pet of PETS) {
    for (const clip of CLIPS) {
      // Prefer .mov if present (slightly higher bitrate masters), else .mp4.
      const mov = path.join(AVATARS, `${pet}_${clip}.mov`);
      const mp4 = path.join(AVATARS, `${pet}_${clip}.mp4`);
      const src = fs.existsSync(mov) ? mov : (fs.existsSync(mp4) ? mp4 : null);
      if (src) jobs.push({ pet, clip, source: src });
      else console.warn("missing source:", pet, clip);
    }
  }
  return jobs;
}

function argsFor(job: Job, output: string): string[] {
  // libvpx-vp9 with pix_fmt yuva420p is the only cross-browser path for
  // WebM with alpha. -auto-alt-ref 0 must be set or VP9 drops the alpha.
  //
  // colorkey similarity=0.10 keys pixels within ~10% RGB Euclidean distance
  // of pure black — loose enough to catch the dark halo right at the sprite
  // edge, tight enough to leave interior dark pixels (eyes, shadows) opaque.
  // blend=0.0 ensures no gradient → no body translucency.
  return [
    "-y",
    "-i", job.source,
    "-vf", "colorkey=color=0x000000:similarity=0.10:blend=0.0,format=yuva420p",
    "-c:v", "libvpx-vp9",
    "-pix_fmt", "yuva420p",
    "-b:v", "1.2M",
    "-auto-alt-ref", "0",
    "-deadline", "good",
    "-cpu-used", "2",
    "-an",
    output,
  ];
}

async function run(job: Job): Promise<void> {
  const output = path.join(AVATARS, `${job.pet}_${job.clip}.webm`);
  const args = argsFor(job, output);
  process.stdout.write(`\n[${job.pet} ${job.clip}] ${path.basename(job.source)} → ${path.basename(output)}\n`);
  await new Promise<void>((resolve, reject) => {
    const p = spawn(FFMPEG, args, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

async function main() {
  if (!FFMPEG || !fs.existsSync(FFMPEG)) {
    console.error("ffmpeg-static binary not found at", FFMPEG);
    process.exit(1);
  }
  console.log("ffmpeg:", FFMPEG);
  const jobs = build();
  console.log(`processing ${jobs.length} clips`);
  const started = Date.now();
  for (const [i, job] of jobs.entries()) {
    const start = Date.now();
    await run(job);
    const took = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  done (${took}s) — ${i + 1}/${jobs.length}`);
  }
  console.log(`\nall done in ${((Date.now() - started) / 1000 / 60).toFixed(1)} min`);
}

main().catch((e) => { console.error(e); process.exit(1); });
