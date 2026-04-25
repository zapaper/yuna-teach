// Re-encode otter clips only. The shared pets-to-webm.ts uses
// colorkey similarity=0.04 which is correct for unicorn/dragon/qilin/merlion
// but too tight for the otter master — that file has compression chroma
// noise around its studio black bg, so 4% RGB Euclidean distance misses
// the noisier bg pixels and they survive as opaque black squares.
//
// This script keys with chromakey at similarity=0.04, blend=0. chromakey
// works in YUV chroma space which catches noisy near-black bg pixels that
// straight RGB colorkey misses, while 0.04 stays tight enough that the
// otter's brown body fill (which has YUV chroma close-ish to dark grey)
// stays opaque. blend=0 keeps the cut hard. Earlier 0.10 was too loose
// — keyed out the body too. Run after dropping fresh otter mp4/mov
// sources into public/avatars/.
//
// Run from yuna-teach/:
//   npx tsx scripts/otter-to-webm.ts

import ffmpegStatic from "ffmpeg-static";
import { spawn } from "child_process";
import path from "path";
import fs from "fs";

const FFMPEG = ffmpegStatic as unknown as string;
const AVATARS = path.join(process.cwd(), "public/avatars");

const CLIPS = ["smile", "stretch", "walk", "talk"] as const;

type Job = { clip: string; source: string };

function build(): Job[] {
  const jobs: Job[] = [];
  for (const clip of CLIPS) {
    // Pick the more recently modified source (mp4 OR mov), so a fresh
    // upload always wins without manual cleanup.
    const candidates = [
      path.join(AVATARS, `otter_${clip}.mp4`),
      path.join(AVATARS, `otter_${clip}.mov`),
    ].filter(p => fs.existsSync(p));
    if (candidates.length === 0) {
      console.warn("missing source: otter", clip);
      continue;
    }
    candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    jobs.push({ clip, source: candidates[0] });
  }
  return jobs;
}

function argsFor(job: Job, output: string): string[] {
  return [
    "-y",
    "-i", job.source,
    "-vf", "chromakey=color=0x000000:similarity=0.04:blend=0.0,format=yuva420p",
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
  const output = path.join(AVATARS, `otter_${job.clip}.webm`);
  const args = argsFor(job, output);
  process.stdout.write(`\n[otter ${job.clip}] ${path.basename(job.source)} → ${path.basename(output)}\n`);
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
  console.log(`processing ${jobs.length} otter clips`);
  const started = Date.now();
  for (const [i, job] of jobs.entries()) {
    const start = Date.now();
    await run(job);
    const took = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`  done (${took}s) — ${i + 1}/${jobs.length}`);
  }
  console.log(`\nall done in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
