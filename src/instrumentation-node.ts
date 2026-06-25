// Node-runtime side of the boot-time sweep hook. Kept separate from
// instrumentation.ts so Turbopack's Edge-runtime build pass never
// traces into stuck-recovery / marking / compo-analysis (those pull
// in fs, path, sharp, and other Node-only modules that the Edge
// runtime refuses to bundle). instrumentation.ts dynamically
// imports THIS file only when process.env.NEXT_RUNTIME === "nodejs".

import { recoverStuckExamMarking, recoverStuckCompo } from "@/lib/stuck-recovery";

const BOOT_DELAY_MS = 30_000;          // 30s — let DB pool + Prisma warm
const BOOT_JITTER_MS = 15_000;         // up to 15s — stagger multi-worker boots

export function scheduleBootSweep() {
  const jitter = Math.floor(Math.random() * BOOT_JITTER_MS);
  setTimeout(() => { void runSweeps(); }, BOOT_DELAY_MS + jitter);
}

async function runSweeps() {
  const t0 = Date.now();
  console.log(`[instrumentation] boot sweep starting (delayed for ready-state)`);
  try {
    const [examResult, compoResult] = await Promise.allSettled([
      recoverStuckExamMarking(),
      recoverStuckCompo(),
    ]);
    const examSummary = examResult.status === "fulfilled"
      ? `exam: ${examResult.value.rescued} rescued`
      : `exam: FAILED (${examResult.reason instanceof Error ? examResult.reason.message : examResult.reason})`;
    const compoSummary = compoResult.status === "fulfilled"
      ? `compo: ${compoResult.value.rescued} rescued`
      : `compo: FAILED (${compoResult.reason instanceof Error ? compoResult.reason.message : compoResult.reason})`;
    console.log(`[instrumentation] boot sweep done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${examSummary} · ${compoSummary}`);
  } catch (err) {
    console.error(`[instrumentation] boot sweep crashed:`, err);
  }
}
