import { NextRequest, NextResponse } from "next/server";
import { getMonthlyUsage, isPaidUser, FREE_LIMITS } from "@/lib/usage";

export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("userId");
  if (!userId) return NextResponse.json({ error: "Missing userId" }, { status: 400 });

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
