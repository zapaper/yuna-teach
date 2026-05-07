import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { iapEnabled, reconcileFromRevenueCat } from "@/lib/iap";

// POST /api/iap/verify
//
// Called by the iOS app immediately after a successful StoreKit
// purchase. Body: { userId }. We don't trust the iOS app to tell us
// the entitlement is active — we ask RevenueCat directly via the
// Secret API key. RevenueCat already validated the App Store receipt
// and is the single source of truth.
//
// Conflict guard: if the user is already on an active Stripe
// subscription, we refuse the IAP purchase up-front. The iOS app
// shows the parent a "you already subscribe via the website" sheet
// and can call Apple's StoreKit refund API. We DON'T flip them onto
// Apple silently — the entitlements would dual-bill the parent.

export async function POST(request: NextRequest) {
  if (!iapEnabled()) {
    return NextResponse.json({ error: "IAP disabled" }, { status: 503 });
  }

  let body: { userId?: string };
  try {
    body = (await request.json()) as { userId?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { userId } = body;
  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  // Sanity-check the user exists. We don't enforce auth here because
  // the verify call happens right after the iOS app's RevenueCat
  // login — RC has already mapped this app_user_id to a real
  // subscriber. A bad userId just gets us a no_subscriber response.
  const exists = await prisma.user.count({ where: { id: userId } });
  if (exists === 0) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  try {
    const result = await reconcileFromRevenueCat(userId);
    if (!result.ok) {
      // stripe_conflict is the only "client error" case the iOS app
      // needs to special-case (show the dual-subscription warning).
      const status = result.reason === "stripe_conflict" ? 409 : 404;
      return NextResponse.json({ error: result.reason }, { status });
    }
    return NextResponse.json({
      ok: true,
      subscriptionStatus: result.status,
      expiresAt: result.expiresAt?.toISOString() ?? null,
    });
  } catch (err) {
    console.error("[iap/verify]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Verification failed" }, { status: 500 });
  }
}
