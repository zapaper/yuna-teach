// Apple In-App Purchase plumbing (hybrid IAP — Phase A).
//
// Single source of truth for "is this user subscribed via Apple?" lives
// on the User row (appleOriginalTransactionId + subscriptionStatus +
// appleExpiresAt). RevenueCat is the verification layer: instead of
// implementing Apple's JWS receipt validation + grace-period logic
// ourselves, we ask RevenueCat's REST API for the canonical subscriber
// state.
//
// Two paths feed this module:
//   - /api/iap/verify          (iOS app, after StoreKit purchase)
//   - /api/iap/asn-webhook     (RevenueCat → us, on renewals/refunds)
// Both call reconcileFromRevenueCat() to normalize the user row.

import { prisma } from "./db";

// ── Feature flag ────────────────────────────────────────────────────
// Set IAP_ENABLED=true in Railway env vars when you're ready to flip
// the iOS app live. Until then the routes return 503 so an accidentally
// shipped iOS build can't talk to a half-finished backend.
export function iapEnabled(): boolean {
  return process.env.IAP_ENABLED === "true";
}

// ── RevenueCat REST client ──────────────────────────────────────────
// We use the v1 REST API (https://api.revenuecat.com/v1) over the
// SDKs because we only need read paths server-side; the SDK layer
// belongs in the iOS app. The Secret API Key (NOT the Public SDK key)
// goes in REVENUECAT_SECRET_KEY.

const RC_BASE = "https://api.revenuecat.com/v1";

type RcEntitlement = {
  expires_date: string | null;          // ISO 8601 or null for lifetime
  product_identifier: string;
  purchase_date: string;
};

type RcSubscriber = {
  subscriber: {
    original_app_user_id: string;
    entitlements: Record<string, RcEntitlement>;
    subscriptions: Record<string, {
      expires_date: string | null;
      original_purchase_date: string;
      store: "app_store" | "play_store" | string;
      is_sandbox: boolean;
      original_transaction_id?: string;
      product_identifier: string;
    }>;
  };
};

async function rcGetSubscriber(appUserId: string): Promise<RcSubscriber | null> {
  const key = process.env.REVENUECAT_SECRET_KEY;
  if (!key) throw new Error("REVENUECAT_SECRET_KEY not set");
  const res = await fetch(`${RC_BASE}/subscribers/${encodeURIComponent(appUserId)}`, {
    headers: { Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`RevenueCat returned ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as RcSubscriber;
}

// ── Reconciliation ──────────────────────────────────────────────────
// Pulls canonical subscriber state from RevenueCat and writes it back
// to the User row. Used both by the post-purchase verify endpoint and
// by webhook events (one common path = no drift between them).

export type ReconcileResult =
  | { ok: true; status: "active" | "expired" | "in_grace" | "canceled"; expiresAt: Date | null }
  | { ok: false; reason: "no_subscriber" | "no_apple_subscription" | "stripe_conflict" };

const ENTITLEMENT_ID = process.env.REVENUECAT_ENTITLEMENT_ID ?? "premium";

export async function reconcileFromRevenueCat(userId: string): Promise<ReconcileResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      stripeSubscriptionId: true,
      subscriptionStatus: true,
      paymentSource: true,
    },
  });
  if (!user) return { ok: false, reason: "no_subscriber" };

  // Conflict guard: a user already paying via Stripe shouldn't also
  // hold an Apple entitlement. The iOS verify path uses this signal to
  // reject the purchase up-front; the webhook path treats it as
  // "Stripe wins" and leaves Apple fields blank (the iOS app should
  // refund automatically — handled in /api/iap/verify before any state
  // is written).
  if (user.stripeSubscriptionId && user.subscriptionStatus === "active" && user.paymentSource !== "apple") {
    return { ok: false, reason: "stripe_conflict" };
  }

  const sub = await rcGetSubscriber(userId);
  if (!sub) return { ok: false, reason: "no_subscriber" };

  // Find the Apple entitlement (RevenueCat dashboards group products
  // under named entitlements; we standardise on a single one called
  // "premium" — change via REVENUECAT_ENTITLEMENT_ID).
  const ent = sub.subscriber.entitlements[ENTITLEMENT_ID];
  // Pick the Apple subscription this entitlement maps to (RC may
  // surface entitlements granted by a non-Apple store too — e.g. if
  // we add Android later — but for IAP we only care about app_store).
  const appleSub = Object.values(sub.subscriber.subscriptions).find(
    (s) => s.store === "app_store",
  );
  if (!appleSub) return { ok: false, reason: "no_apple_subscription" };

  const expiresAt = ent?.expires_date ? new Date(ent.expires_date) : null;
  const now = new Date();
  // RevenueCat: an entitlement is "active" iff it exists in the
  // entitlements map AND expires_date > now (or is null = lifetime).
  // RC also handles billing-retry grace periods server-side, so we
  // trust whatever it returns.
  const isActive = !!ent && (expiresAt === null || expiresAt > now);

  const status: "active" | "expired" | "canceled" = isActive
    ? "active"
    : expiresAt && expiresAt <= now
      ? "expired"
      : "canceled";

  await prisma.user.update({
    where: { id: userId },
    data: {
      subscriptionStatus: status,
      paymentSource: "apple",
      appleOriginalTransactionId: appleSub.original_transaction_id ?? null,
      appleProductId: appleSub.product_identifier,
      appleEnvironment: appleSub.is_sandbox ? "Sandbox" : "Production",
      appleExpiresAt: expiresAt,
    },
  });

  return { ok: true, status, expiresAt };
}

// ── Webhook secret check ────────────────────────────────────────────
// RevenueCat lets us configure an Authorization header value in the
// dashboard. They send it on every webhook call; we compare in
// constant time against REVENUECAT_WEBHOOK_SECRET.
export function verifyRevenueCatAuth(headerValue: string | null): boolean {
  const expected = process.env.REVENUECAT_WEBHOOK_SECRET;
  if (!expected || !headerValue) return false;
  if (headerValue.length !== expected.length) return false;
  // Constant-time comparison — avoids timing side-channels even though
  // the attack surface here is small.
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= headerValue.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}
