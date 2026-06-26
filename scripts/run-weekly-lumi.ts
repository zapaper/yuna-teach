// Master function: weekly Lumi refresh for every eligible (kid × subject).
//
// What it does, in order:
//   1. Enumerate (kid × subject) pairs from src/lib/tutor-cache/. Drop
//      Chinese pairs (no Lumi UI shipped for Chinese).
//   2. Resolve each slug back to the real student name via DB lookup
//      (slug = safeName(user.name), recover by scanning).
//   3. For each pair, sequentially within a kid but batched across kids:
//        a. Snapshot current cache → .lastweek.gemini-cache.json
//        b. Run _workshop-unified.ts <name> <subject> --refresh
//        c. On success, promote eval/<file> → src/lib/tutor-cache/<file>
//        d. On failure, leave the original cache in place + log
//   4. Regenerate src/lib/lumi-lastweek-cache.ts with the FULL set of
//      lastweek imports (alphabetical by slug for stable diffs).
//
// Outputs:
//   · Updated src/lib/tutor-cache/*.gemini-cache.json (current)
//   · Updated src/lib/tutor-cache/*.lastweek.gemini-cache.json (snapshot)
//   · Updated src/lib/lumi-lastweek-cache.ts (index)
//   · Per-kid workshop logs at eval/_workshop-<slug>-<subject>.log
//
// You commit + push the result. Future iterations may add an --autocommit
// flag once we trust the pipeline end-to-end.
//
// Usage:
//   npx tsx scripts/run-weekly-lumi.ts                  (full run, batch=3)
//   npx tsx scripts/run-weekly-lumi.ts --dry-run        (list pairs, no work)
//   npx tsx scripts/run-weekly-lumi.ts --batch=4        (override concurrency)
//   npx tsx scripts/run-weekly-lumi.ts --only=mark-lim,david-lim
//                                                       (filter to specific slugs)
//   npx tsx scripts/run-weekly-lumi.ts --subjects=math,science
//                                                       (limit subjects)

import { promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";
import { prisma } from "../src/lib/db";

const CACHE_DIR  = path.join(__dirname, "..", "src", "lib", "tutor-cache");
const EVAL_DIR   = path.join(__dirname, "..", "eval");
const INDEX_PATH = path.join(__dirname, "..", "src", "lib", "lumi-lastweek-cache.ts");

const SKIP_SUBJECTS = new Set(["chinese"]);
const DEFAULT_BATCH = 3;

type Pair = { slug: string; subject: "math" | "science" | "english" };
type Resolved = Pair & { studentName: string };

function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const batchArg = args.find(a => a.startsWith("--batch="))?.split("=")[1];
  const batchSize = batchArg ? Math.max(1, parseInt(batchArg, 10)) : DEFAULT_BATCH;
  const onlyArg = args.find(a => a.startsWith("--only="))?.split("=")[1];
  const onlySlugs = onlyArg ? new Set(onlyArg.split(",").map(s => s.trim()).filter(Boolean)) : null;
  const subjectsArg = args.find(a => a.startsWith("--subjects="))?.split("=")[1];
  const subjects = subjectsArg ? new Set(subjectsArg.split(",").map(s => s.trim().toLowerCase()).filter(Boolean)) : null;
  return { dryRun, batchSize, onlySlugs, subjects };
}

function safeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function enumeratePairs(only: Set<string> | null, subjFilter: Set<string> | null): Promise<Pair[]> {
  const entries = await fs.readdir(CACHE_DIR);
  const re = /^unified-diagnosis-(.+)-(math|science|english|chinese)\.gemini-cache\.json$/;
  const pairs: Pair[] = [];
  for (const e of entries) {
    if (e.includes(".lastweek.")) continue;
    const m = re.exec(e);
    if (!m) continue;
    const slug = m[1];
    const subject = m[2] as Pair["subject"] | "chinese";
    if (SKIP_SUBJECTS.has(subject)) continue;
    if (only && !only.has(slug)) continue;
    if (subjFilter && !subjFilter.has(subject)) continue;
    pairs.push({ slug, subject: subject as Pair["subject"] });
  }
  pairs.sort((a, b) => a.slug.localeCompare(b.slug) || a.subject.localeCompare(b.subject));
  return pairs;
}

async function resolveSlugs(pairs: Pair[]): Promise<{ resolved: Resolved[]; unresolved: Pair[] }> {
  const distinctSlugs = [...new Set(pairs.map(p => p.slug))];
  const users = await prisma.user.findMany({
    where: { role: "STUDENT" },
    select: { id: true, name: true },
  });
  const byName = new Map<string, string>();
  for (const u of users) byName.set(safeName(u.name), u.name);
  const resolved: Resolved[] = [];
  const unresolved: Pair[] = [];
  const seenSlugWarn = new Set<string>();
  for (const p of pairs) {
    const studentName = byName.get(p.slug);
    if (!studentName) {
      unresolved.push(p);
      if (!seenSlugWarn.has(p.slug)) {
        console.warn(`[resolve] slug "${p.slug}" → no STUDENT row in DB`);
        seenSlugWarn.add(p.slug);
      }
      continue;
    }
    resolved.push({ ...p, studentName });
  }
  void distinctSlugs;
  return { resolved, unresolved };
}

async function snapshot(slug: string, subject: string) {
  const src = path.join(CACHE_DIR, `unified-diagnosis-${slug}-${subject}.gemini-cache.json`);
  const dst = path.join(CACHE_DIR, `unified-diagnosis-${slug}-${subject}.lastweek.gemini-cache.json`);
  await fs.copyFile(src, dst);
}

async function promote(slug: string, subject: string): Promise<boolean> {
  const fresh = path.join(EVAL_DIR, `unified-diagnosis-${slug}-${subject}.gemini-cache.json`);
  const cur   = path.join(CACHE_DIR, `unified-diagnosis-${slug}-${subject}.gemini-cache.json`);
  try {
    await fs.copyFile(fresh, cur);
    return true;
  } catch (err) {
    console.error(`[promote] ${slug} × ${subject} failed: ${(err as Error).message}`);
    return false;
  }
}

function runWorkshop(studentName: string, subject: string, slug: string): Promise<{ ok: boolean; elapsed: number }> {
  return new Promise(resolve => {
    const logPath = path.join(EVAL_DIR, `_workshop-${slug}-${subject}.log`);
    const cmd = `npx tsx scripts/_workshop-unified.ts "${studentName}" ${subject} --refresh > "${logPath}" 2>&1`;
    const t0 = Date.now();
    // shell:true on Windows resolves npx as .cmd; pass through stdio so
    // long-running prompts can flush their own progress.
    const child = spawn(cmd, { shell: true, env: process.env });
    child.on("exit", code => {
      const elapsed = (Date.now() - t0) / 1000;
      resolve({ ok: code === 0, elapsed });
    });
    child.on("error", () => resolve({ ok: false, elapsed: (Date.now() - t0) / 1000 }));
  });
}

// Generate the lumi-lastweek-cache.ts index file from scratch. Camel-cases
// slug into a JS identifier. Result is sorted alphabetically by slug so
// diffs stay stable across runs.
async function rebuildIndex(allPairs: Pair[]) {
  // Identifier: collapse non-alphanumerics; cap first letter; suffix LW
  // (e.g. "mark-lim" + "math" → "markLimMathLW").
  const idOf = (slug: string, subject: string) => {
    const parts = [...slug.split(/[^a-z0-9]+/), subject];
    const camel = parts.map((p, i) => i === 0 ? p : (p.charAt(0).toUpperCase() + p.slice(1))).join("");
    return camel + "LW";
  };
  const importLines: string[] = [];
  const mapLines: string[] = [];
  for (const p of allPairs) {
    const id = idOf(p.slug, p.subject);
    importLines.push(`import ${id} from "./tutor-cache/unified-diagnosis-${p.slug}-${p.subject}.lastweek.gemini-cache.json";`);
    mapLines.push(`  "${p.slug}:${p.subject}": ${id},`);
  }
  const out = `// Last week's diagnosis snapshots — used by loadTutorData to compute
// the weekly delta block on the Lumi page. Each snapshot was captured
// BEFORE the current cache was overwritten by the Friday refresh, so
// it represents "last Friday's report" for delta purposes.
//
// AUTOGENERATED by scripts/run-weekly-lumi.ts. Do not hand-edit — the
// next weekly refresh will overwrite the file. Add new (kid × subject)
// entries by running the refresh; the index regenerates from the
// .lastweek files on disk.

${importLines.join("\n")}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const LUMI_LASTWEEK_CACHE: Record<string, any> = {
${mapLines.join("\n")}
};
`;
  await fs.writeFile(INDEX_PATH, out, "utf8");
}

// Run a batch of workshop tasks in parallel, awaiting all before
// returning. Each entry is (resolved pair) and gets its own snapshot
// + workshop + promote sequence.
async function processBatch(batch: Resolved[]): Promise<Array<{ pair: Resolved; ok: boolean; elapsed: number; note?: string }>> {
  const results: Array<{ pair: Resolved; ok: boolean; elapsed: number; note?: string }> = [];
  await Promise.all(batch.map(async pair => {
    try {
      await snapshot(pair.slug, pair.subject);
    } catch (err) {
      results.push({ pair, ok: false, elapsed: 0, note: `snapshot failed: ${(err as Error).message}` });
      return;
    }
    const r = await runWorkshop(pair.studentName, pair.subject, pair.slug);
    if (!r.ok) {
      results.push({ pair, ok: false, elapsed: r.elapsed, note: "workshop failed — see log" });
      return;
    }
    const promoted = await promote(pair.slug, pair.subject);
    results.push({ pair, ok: promoted, elapsed: r.elapsed, note: promoted ? undefined : "promote failed" });
  }));
  return results;
}

(async () => {
  const { dryRun, batchSize, onlySlugs, subjects } = parseArgs();
  console.log(`Weekly Lumi refresh — batch=${batchSize}${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`Cache dir:   ${CACHE_DIR}`);
  console.log(`Index file:  ${INDEX_PATH}\n`);

  const pairs = await enumeratePairs(onlySlugs, subjects);
  const { resolved, unresolved } = await resolveSlugs(pairs);
  console.log(`Eligible pairs: ${pairs.length} (${resolved.length} resolved, ${unresolved.length} unresolved)\n`);

  if (dryRun) {
    console.log("Would process (in batch order):");
    for (const r of resolved) console.log(`  ${r.studentName.padEnd(35)} × ${r.subject}`);
    if (unresolved.length > 0) {
      console.log("\nWould skip (slug not in DB):");
      for (const u of unresolved) console.log(`  ${u.slug} × ${u.subject}`);
    }
    await prisma.$disconnect();
    return;
  }

  // Process in batches of N. Workshops within a batch run in parallel.
  const allResults: Array<{ pair: Resolved; ok: boolean; elapsed: number; note?: string }> = [];
  for (let i = 0; i < resolved.length; i += batchSize) {
    const batch = resolved.slice(i, i + batchSize);
    const batchNo = Math.floor(i / batchSize) + 1;
    const batchCount = Math.ceil(resolved.length / batchSize);
    console.log(`── Batch ${batchNo}/${batchCount} (${batch.length} pairs) ──`);
    for (const b of batch) console.log(`  start: ${b.studentName} × ${b.subject}`);
    const results = await processBatch(batch);
    for (const r of results) {
      const tag = r.ok ? "✓" : "✗";
      console.log(`  ${tag} ${r.pair.studentName} × ${r.pair.subject} — ${r.elapsed.toFixed(1)}s${r.note ? ` (${r.note})` : ""}`);
    }
    allResults.push(...results);
  }

  console.log("\n── Rebuilding lumi-lastweek-cache.ts index ──");
  // Only include pairs that successfully refreshed this round AND
  // pairs from prior runs whose lastweek file still exists. That way
  // a kid whose workshop failed today keeps last week's stale-but-
  // working delta instead of getting silently dropped.
  const existingLastweek = new Set<string>();
  for (const e of await fs.readdir(CACHE_DIR)) {
    const m = /^unified-diagnosis-(.+)-(math|science|english)\.lastweek\.gemini-cache\.json$/.exec(e);
    if (m) existingLastweek.add(`${m[1]}:${m[2]}`);
  }
  const indexPairs = pairs.filter(p => existingLastweek.has(`${p.slug}:${p.subject}`));
  await rebuildIndex(indexPairs);
  console.log(`  Indexed ${indexPairs.length} entries.`);

  console.log("\n── Summary ──");
  const ok = allResults.filter(r => r.ok).length;
  const fail = allResults.length - ok;
  console.log(`  Refreshed: ${ok}`);
  console.log(`  Failed:    ${fail}`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const r of allResults.filter(r => !r.ok)) {
      console.log(`  - ${r.pair.studentName} × ${r.pair.subject}: ${r.note ?? "(no note)"}`);
    }
  }
  if (unresolved.length > 0) {
    console.log("\nUnresolved (skipped):");
    for (const u of unresolved) console.log(`  - ${u.slug} × ${u.subject}`);
  }
  console.log("\nCommit + push when ready to deploy.");
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
