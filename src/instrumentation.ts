// Next.js instrumentation hook — runs ONCE per server-process boot
// (i.e. on every fresh Railway deploy + every worker restart).
//
// Use it to comb through interrupted work and re-trigger it. The
// classic death mode is "Railway redeployed mid-pipeline":
//   · Exam marking that was in_progress when the old container
//     terminated stays in_progress forever. Marking dashboard
//     shows the failed-mark badge; parent dashboard shows
//     "Marking…" with no progress.
//   · Compo analyses that were mid-OCR or mid-elevate when the
//     container died stay at status="analysing" forever, with
//     the row's progress tracker stuck.
//
// Both sweeps live in lib/stuck-recovery so the auto-recover HTTP
// routes can call the same code path. The sweeps are idempotent —
// they only act on rows that are genuinely stale (≥ 5 min idle)
// so multi-worker deploys (each worker fires register()) can't
// step on each other.

export async function register() {
  // Only run on the Node.js server runtime — not edge, not client.
  // Detected by checking the official env injected by Next.js.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Delay so the DB connection + Prisma client are ready before
  // we start hammering the database. Also lets concurrent worker
  // boots stagger a bit (different RNG = different sleep) so the
  // sweep doesn't fan out to N simultaneous attempts to recover
  // the same row.
  const baseDelayMs = 30_000;          // 30s
  const jitterMs = Math.floor(Math.random() * 15_000); // up to 15s
  setTimeout(() => { void runSweeps(); }, baseDelayMs + jitterMs);
}

async function runSweeps() {
  const t0 = Date.now();
  console.log(`[instrumentation] boot sweep starting (delayed for ready-state)`);
  try {
    // Dynamic-import the lib so the rest of the app boots without
    // pulling in Prisma + marking deps until the timer fires.
    const { recoverStuckExamMarking, recoverStuckCompo } = await import("@/lib/stuck-recovery");
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
