import { NextResponse } from "next/server";

// Cheap liveness probe for Railway's deploy healthcheck. No DB hit,
// no auth, no work — just confirms the Next.js server is up and
// responding. Railway uses this to gate traffic switch-over during a
// deploy: traffic moves to the new container only after this returns
// 2xx, so users hit the new build instead of a 502 from the briefly-
// down container.
//
// Don't extend this to check downstream deps (Postgres, disk, etc.).
// A flaky DB shouldn't block deploys — it should surface as a real
// 500 on the affected routes, not as a healthcheck failure that
// prevents new code from rolling out.
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ status: "ok" }, { status: 200 });
}
