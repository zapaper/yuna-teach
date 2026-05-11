import { NextRequest, NextResponse } from "next/server";
import { getMonthlyUsage, isPaidUser, FREE_LIMITS } from "@/lib/usage";
import { resolveActor } from "@/lib/auth-guard";

export async function GET(request: NextRequest) {
  const target = request.nextUrl.searchParams.get("userId");
  const auth = await resolveActor(target);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const userId = auth.userId;

  const [paid, usage] = await Promise.all([
    isPaidUser(userId),
    getMonthlyUsage(userId),
  ]);

  return NextResponse.json({
    paid,
    usage,
    limits: paid ? null : FREE_LIMITS,
  });
}
