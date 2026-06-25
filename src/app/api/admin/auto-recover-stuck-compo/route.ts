// POST /api/admin/auto-recover-stuck-compo — admin-callable wrapper
// around recoverStuckCompo(). The shared lib is also used by the
// Next.js instrumentation hook (src/instrumentation.ts) so a fresh
// deploy auto-sweeps without needing this HTTP call.
//
// What counts as "stuck":
//   · status="analysing" + updatedAt older than 5 min (worker died).
//   · status="failed" within the last 14 days (re-try is cheap).

import { NextResponse } from "next/server";
import { isSessionAdmin } from "@/lib/session";
import { recoverStuckCompo } from "@/lib/stuck-recovery";

export async function POST() {
  if (!(await isSessionAdmin())) {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }
  const summary = await recoverStuckCompo();
  return NextResponse.json(summary);
}
