// Mass-regenerate every cached Lumi diagnosis with the v3 prompt as a
// FRESH run (no previousAssessment carry-forward). Runs in waves of
// CONCURRENCY to keep the Pro API and Railway Postgres connection
// pool happy — Emily Science's earlier failure was a P1017 from
// blasting too many parallel workshops at once.
//
// Usage:
//   npx tsx scripts/_mass-regen-lumi-v3.ts
//   npx tsx scripts/_mass-regen-lumi-v3.ts --dry        (list only)
//   npx tsx scripts/_mass-regen-lumi-v3.ts --skip lohxy2014:math,mark-lim:math
//                                                     (already-done pairs)

import { readdirSync, existsSync } from "fs";
import { spawn } from "child_process";
import path from "path";

const CACHE_DIR = "src/lib/tutor-cache";
const CONCURRENCY = 4;
const DRY = process.argv.includes("--dry");
const skipFlag = process.argv.indexOf("--skip");
const SKIP = new Set(
  skipFlag >= 0 ? (process.argv[skipFlag + 1] ?? "").split(",").filter(Boolean) : []
);

type Job = { safeName: string; subject: string };

function listJobs(): Job[] {
  const re = /^unified-diagnosis-(.+)-(math|science|english|chinese)\.gemini-cache\.json$/;
  const out: Job[] = [];
  for (const f of readdirSync(CACHE_DIR)) {
    const m = re.exec(f);
    if (!m) continue;
    out.push({ safeName: m[1], subject: m[2] });
  }
  return out.sort((a, b) => `${a.safeName}:${a.subject}`.localeCompare(`${b.safeName}:${b.subject}`));
}

// safeName -> the original DB student name. Workshop takes the DB
// name (not the safe name) as its first arg. We lowercase + map back
// via the user list — but the lookup is case-insensitive contains,
// so passing the safeName with spaces re-inserted works for most
// names. The exceptions (one-word safe names like "mark-lim" that
// the DB has as "Mark lim") are handled by the workshop's case-
// insensitive lookup.
function studentArgFor(safeName: string): string {
  // Replace dashes with spaces and let the workshop's case-insensitive
  // contains-match find the row. Works for "mark-lim" -> "mark lim",
  // "david-lim" -> "david lim", "kaiyangnggg" -> "kaiyangnggg" (no
  // dashes, passes through), "shadow-demon" -> "shadow demon".
  return safeName.replace(/-/g, " ");
}

async function runOne(job: Job): Promise<{ job: Job; ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    // Quote the student name explicitly. shell:true is required on
    // Node 22+ Windows to spawn npx.cmd (CVE-2024-27980 mitigation),
    // but it re-tokenises args via the shell — meaning "emily lim"
    // would become two args without explicit quotes around it.
    const args = [
      "tsx",
      "scripts/_workshop-unified.ts",
      `"${studentArgFor(job.safeName)}"`,
      job.subject.charAt(0).toUpperCase() + job.subject.slice(1),
      "--fresh",
    ];
    const child = spawn("npx", args, { stdio: ["ignore", "pipe", "pipe"], shell: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve({ job, ok: true });
      else resolve({ job, ok: false, error: stderr.slice(-400) });
    });
    child.on("error", (err) => resolve({ job, ok: false, error: err.message }));
  });
}

async function runWave(jobs: Job[]): Promise<void> {
  const results = await Promise.all(jobs.map(runOne));
  for (const r of results) {
    const label = `${r.job.safeName}:${r.job.subject}`;
    if (r.ok) console.log(`  ✓ ${label}`);
    else console.log(`  ✗ ${label}\n    ${r.error?.split("\n").join("\n    ")}`);
  }
}

(async () => {
  const all = listJobs();
  const jobs = all.filter((j) => !SKIP.has(`${j.safeName}:${j.subject}`));
  console.log(`Found ${all.length} cached diagnoses; ${jobs.length} to regen (${all.length - jobs.length} skipped).`);
  for (const j of jobs) {
    console.log(`  - ${j.safeName}:${j.subject}`);
  }
  if (DRY) {
    console.log("\n--dry: not running.");
    return;
  }
  console.log(`\nRunning in waves of ${CONCURRENCY}.`);
  const waves: Job[][] = [];
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    waves.push(jobs.slice(i, i + CONCURRENCY));
  }
  for (let i = 0; i < waves.length; i++) {
    console.log(`\nWave ${i + 1}/${waves.length} (${waves[i].length} jobs)…`);
    await runWave(waves[i]);
  }

  // Copy newly written caches from eval/ into the runtime dir.
  console.log("\nCopying eval/ caches into src/lib/tutor-cache/…");
  for (const j of jobs) {
    const file = `unified-diagnosis-${j.safeName}-${j.subject}.gemini-cache.json`;
    const evalPath = path.join("eval", file);
    const runtimePath = path.join(CACHE_DIR, file);
    if (existsSync(evalPath)) {
      const data = await import("fs").then((m) => m.readFileSync(evalPath));
      const fs = await import("fs");
      fs.writeFileSync(runtimePath, data);
    }
  }
  console.log("Done.");
})();
