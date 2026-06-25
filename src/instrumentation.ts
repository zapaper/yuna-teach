// Next.js instrumentation hook — runs ONCE per server-process boot
// (i.e. on every fresh Railway deploy + every worker restart).
//
// Used to comb through interrupted work and re-trigger it. The
// classic death mode is "Railway redeployed mid-pipeline":
//   · Exam marking that was in_progress when the old container
//     terminated stays in_progress forever. Marking dashboard
//     shows the failed-mark badge; parent dashboard shows
//     "Marking…" with no progress.
//   · Compo analyses that were mid-OCR or mid-elevate when the
//     container died stay at status="analysing" forever, with
//     the row's progress tracker stuck.
//
// IMPORTANT: this file MUST stay Edge-runtime-safe (no fs / path /
// sharp imports), because Next.js / Turbopack builds it for BOTH
// the Node runtime AND the Edge runtime. Node-only work lives in
// ./instrumentation-node and is loaded via a runtime-gated dynamic
// import that the Edge bundler never traces.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { scheduleBootSweep } = await import("./instrumentation-node");
  scheduleBootSweep();
}
