import { NextRequest, NextResponse } from "next/server";
import { iapEnabled, reconcileFromRevenueCat, verifyRevenueCatAuth } from "@/lib/iap";

// POST /api/iap/asn-webhook
//
// Called by RevenueCat when an Apple Server Notification fires:
// renewals, cancellations, refunds, billing-issue grace periods,
// expirations. We don't decode Apple's JWS ourselves — RevenueCat
// has already done that and is forwarding a normalised event.
//
// Strategy: every webhook simply triggers reconcileFromRevenueCat()
// for the affected app_user_id (= our User.id). That re-pulls the
// canonical subscriber state and rewrites the user row, regardless
// of which event came in. Single code path = no event-type drift.
//
// Auth: RevenueCat lets us configure an Authorization header value
// in the dashboard; verifyRevenueCatAuth checks it against
// REVENUECAT_WEBHOOK_SECRET in constant time.

type RcWebhookEvent = {
  event: {
    type: string;                  // INITIAL_PURCHASE | RENEWAL | CANCELLATION | EXPIRATION | BILLING_ISSUE | NON_RENEWING_PURCHASE | REFUND | …
    app_user_id: string;
    original_app_user_id?: string;
    aliases?: string[];
    event_timestamp_ms: number;
    environment: "PRODUCTION" | "SANDBOX";
  };
  api_version: string;
};

export async function POST(request: NextRequest) {
  if (!iapEnabled()) {
    return NextResponse.json({ error: "IAP disabled" }, { status: 503 });
  }

  // RevenueCat sends the dashboard-configured Authorization value
  // as-is on every call. Reject early before parsing body.
  if (!verifyRevenueCatAuth(request.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: RcWebhookEvent;
  try {
    body = (await request.json()) as RcWebhookEvent;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const evt = body.event;
  if (!evt?.app_user_id || !evt?.type) {
    return NextResponse.json({ error: "Malformed event" }, { status: 400 });
  }

  // RC sometimes uses original_app_user_id when the user was created
  // anonymously then logged in — prefer that if present, fall back
  // to app_user_id. Both should be our User.id once the iOS app
  // calls Purchases.logIn() with our user id post-login.
  const userId = evt.original_app_user_id ?? evt.app_user_id;

  console.log(
    `[iap/asn-webhook] ${evt.type} (${evt.environment}) for user ${userId}`,
  );

  try {
    const result = await reconcileFromRevenueCat(userId);
    if (!result.ok) {
      // 200 even on logical failures — RevenueCat retries non-2xx, so
      // a "no_subscriber" or "stripe_conflict" condition is logged
      // but acked. Otherwise RC keeps retrying for hours.
      console.warn(`[iap/asn-webhook] reconcile failed: ${result.reason}`);
      return NextResponse.json({ ok: true, ack: result.reason });
    }
    return NextResponse.json({
      ok: true,
      subscriptionStatus: result.status,
      expiresAt: result.expiresAt?.toISOString() ?? null,
    });
  } catch (err) {
    // Real errors (DB down, RC unreachable) → 500 so RC retries.
    console.error("[iap/asn-webhook]", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Reconciliation failed" }, { status: 500 });
  }
}
