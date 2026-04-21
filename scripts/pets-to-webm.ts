// Re-encode pet clips to VP9 WebMs with clean alpha channels.
//
//   • merlion / unicorn / dragon / qilin: source .mp4 has a solid black
//     background → chroma-key it out with a tight threshold.
//   • otter: source .mov master already carries clean alpha (ProRes 4444) →
//     straight re-encode, just preserve the alpha with no lossy squeeze on
//     edge pixels (the current .webm has grey fringe because the earlier
//     encode was too soft on the alpha).
//
// Run: npx tsx scripts/pets-to-webm.ts
//
// Takes ~1–2 min per clip. Rough total: ~30 min.

import ffmpegStatic from "ffmpeg-static";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

const FFMPEG = ffmpegStatic as unknown as string;
const AVATARS = path.join(process.cwd(), "public/avatars");

const CLIPS = ["smile", "stretch", "walk", "talk"] as const;

type Job = {
  pet: string;
  clip: string;
  source: string; // absolute path
  mode: "chromakey-black" | "mov-alpha-passthrough";
};

function build(): Job[] {
  const jobs: Job[] = [];
  const blackBg = ["merlion", "unicorn", "dragon", "qilin"];
  for (const pet of blackBg) {
    for (const clip of CLIPS) {
      const src = path.join(AVATARS, `${pet}_${clip}.mp4`);
      if (fs.existsSync(src)) jobs.push({ pet, clip, source: src, mode: "chromakey-black" });
      else console.warn("missing mp4 source:", src);
    }
  }
  // NOTE: otter is intentionally not re-encoded here. The .mov masters
  // carry HEVC-with-alpha, which libvpx-vp9 via ffmpeg drops silently —
  // output webm loses the alpha channel and pets render with a black box.
  // Stick with the pre-existing otter webms (slight grey fringe beats no
  // transparency at all) until we find a working HEVC-alpha → VP9-alpha path.
  return jobs;
}

function argsFor(job: Job, output: string): string[] {
  // libvpx-vp9 with pix_fmt yuva420p is the only cross-browser path for
  // WebM with alpha. -auto-alt-ref 0 must be set or VP9 drops the alpha.
  const common = [
    "-y",
    "-i", job.source,
    "-c:v", "libvpx-vp9",
    "-pix_fmt", "yuva420p",
    "-b:v", "1.2M",
    "-auto-alt-ref", "0",
    "-deadline", "good",
    "-cpu-used", "2",
    "-an",
  ];
  if (job.mode === "chromakey-black") {
    // similarity 0.03 is tight — only pure/near-pure black gets keyed out,
    // preserving dark details inside the sprite (eyes, shadows). blend 0.08
    // softens the cut edge so there's no staircase alias. Earlier attempt
    // at 0.12 was way too aggressive and keyed out the pet pixels too.
    return [
      ...common.slice(0, 3),
      "-vf", "chromakey=color=0x000000:similarity=0.03:blend=0.08,format=yuva420p",
      ...common.slice(3),
      output,
    ];
  }
  // MOV already has alpha — just transcode to VP9. No chroma-key needed.
  return [...common, output];
}

async function run(job: Job): Promise<void> {
  const output = path.join(AVATARS, `${job.pet}_${job.clip}.webm`);
  const args = argsFor(job, output);
  process.stdout.write(`\n[${job.pet} ${job.clip}] ${job.mode} → ${path.basename(output)}\n`);
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
