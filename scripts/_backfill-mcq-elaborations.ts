// Batch backfill of the AI explanation ("elaboration") field on
// master MCQs. Loops the existing prod route
// /api/admin/elaborate-mcq — which uses gemini-3.1-pro-preview and
// sends the full context (diagram, option diagrams, answer key,
// subparts, full question image for Science) already tuned in the
// route. No prompt duplication in the script; if the route improves
// its prompt, this script picks it up on the next run.
//
// Scope is whatever the route considers in-scope (currently: master
// papers only, Math/Science P3-P6+PSLE, English P5-P6+PSLE Grammar
// MCQ; Chinese OUT by design). Loops until totalRemaining=0 or a
// hard cap is hit.
//
// Reads admin session cookie from eval/cookie.txt (see
// [[eval-cookie]] memory). Pass --base=https://... to override the
// default prod URL (default: https://www.markforyou.com).
//
// Run: npx tsx scripts/_backfill-mcq-elaborations.ts

import "dotenv/config";
import { readFileSync } from "fs";
import path from "path";

const args = new Set(process.argv.slice(2));
const baseArg = process.argv.find(a => a.startsWith("--base="));
const BASE = baseArg ? baseArg.split("=")[1] : (process.env.MFY_BASE ?? "https://www.markforyou.com");
const HARD_CAP = 2000;                        // safety: never fire more than N POSTs even if server misreports remaining
const BATCH_SIZE = 5;                         // per-tick; the route caps at 20
const SLEEP_MS = 2000;                        // between batches
const cookiePath = path.join(__dirname, "..", "eval", "cookie.txt");
const cookie = readFileSync(cookiePath, "utf-8").trim();
if (!cookie) { console.error(`Cookie missing at ${cookiePath}`); process.exit(1); }
const url = `${BASE.replace(/\/$/, "")}/api/admin/elaborate-mcq`;

type Result = {
  processed: number;
  updated: number;
  totalRemaining: number;
  results: Array<{ id: string; questionNum: string; subject: string; level: string; ok: boolean; error?: string }>;
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

(async () => {
  const t0 = Date.now();
  console.log(`Backfill elaborations · route=${url} · batch=${BATCH_SIZE} · sleep=${SLEEP_MS}ms · cap=${HARD_CAP}`);

  // Get initial count.
  const initRes = await fetch(url, { method: "GET", headers: { cookie: `yuna_session=${cookie}` } });
  if (!initRes.ok) {
    const t = await initRes.text().catch(() => "");
    console.error(`GET ${url} failed: ${initRes.status} ${t.slice(0, 200)}`);
    process.exit(1);
  }
  const initJson = await initRes.json() as { totalPending?: number; totalRemaining?: number };
  const initialPending = initJson.totalRemaining ?? initJson.totalPending ?? 0;
  console.log(`Initial pending: ${initialPending}`);

  const seenErrors = new Set<string>();
  let processedTotal = 0;
  let updatedTotal = 0;
  let batches = 0;

  while (processedTotal < HARD_CAP) {
    batches++;
    const bt = Date.now();
    // Retry the fetch itself for transient Cloudflare 524 / Node
    // ETIMEDOUT / DNS blips. The route's own DB writes are per-
    // question so an interrupted batch just means some questions
    // updated and the next call resumes on what's still null.
    let res: Response | null = null;
    let attempts = 0;
    while (!res && attempts < 4) {
      attempts++;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie: `yuna_session=${cookie}` },
          body: JSON.stringify({ limit: BATCH_SIZE, excludeIds: [...seenErrors] }),
        });
      } catch (err) {
        const msg = (err as Error).message ?? String(err);
        console.warn(`  fetch retry ${attempts}: ${msg.slice(0, 120)}`);
        await sleep(5000 * attempts);
      }
    }
    if (!res) { console.error(`abort — 4 fetch failures in a row, network is down`); break; }
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error(`POST failed ${res.status}: ${t.slice(0, 200)}`);
      await sleep(5000);
      continue;
    }
    const j = await res.json() as Result;
    const dt = ((Date.now() - bt) / 1000).toFixed(1);
    processedTotal += j.processed;
    updatedTotal += j.updated;
    const failures = j.results.filter(r => !r.ok);
    for (const f of failures) seenErrors.add(f.id);
    console.log(
      `batch ${batches.toString().padStart(3)}  in ${dt.padStart(4)}s  processed=${j.processed}  updated=${j.updated}  fail=${failures.length}  remaining=${j.totalRemaining}  · running total updated=${updatedTotal}`,
    );
    if (failures.length > 0) {
      for (const f of failures.slice(0, 3)) console.log(`    ↳ FAIL ${f.subject}/${f.level} Q${f.questionNum} (${f.id}): ${(f.error ?? "").slice(0, 120)}`);
    }
    if (j.processed === 0) {
      console.log(`No more processable rows — remaining=${j.totalRemaining}, exiting.`);
      break;
    }
    if (j.totalRemaining === 0) {
      console.log(`totalRemaining=0 — done.`);
      break;
    }
    await sleep(SLEEP_MS);
  }

  const wall = ((Date.now() - t0) / 1000 / 60).toFixed(1);
  console.log(`\nSummary  ·  batches=${batches}  ·  processed=${processedTotal}  ·  updated=${updatedTotal}  ·  errors=${seenErrors.size}  ·  wall=${wall} min`);
})().catch(e => { console.error(e); process.exit(1); });
