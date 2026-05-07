// Capacitor-aware feature shims. Imported by client code that needs
// to swap a web API for a native one when running inside the iOS
// shell. Designed to be a no-op in the browser — `isNative()` is
// false there, so callers fall back to their existing web path.
//
// All functions here are CLIENT-ONLY (they touch window). Don't
// import this from server code.

import { Capacitor } from "@capacitor/core";

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

export function platform(): "ios" | "android" | "web" {
  const p = Capacitor.getPlatform();
  if (p === "ios" || p === "android") return p;
  return "web";
}

// ── Camera (paper scan + general photo capture) ─────────────────────
// Replaces getUserMedia + custom edge detection on iOS, which is
// flaky in WKWebView. Returns a JPEG data URL on both paths so
// upstream code doesn't branch.

export async function captureSinglePhoto(): Promise<string | null> {
  if (!isNative()) return null;
  const { Camera, CameraResultType, CameraSource } = await import("@capacitor/camera");
  const photo = await Camera.getPhoto({
    quality: 88,
    allowEditing: false,
    resultType: CameraResultType.DataUrl,
    source: CameraSource.Camera,
    correctOrientation: true,
  });
  return photo.dataUrl ?? null;
}

// ── Push notifications (daily quiz reminders) ──────────────────────
// Stub — the actual register-token-with-server flow lands in Phase B
// after we have an APNs key in the Apple Developer console.

export async function registerForPush(userId: string): Promise<void> {
  if (!isNative()) return;
  const { PushNotifications } = await import("@capacitor/push-notifications");
  const perm = await PushNotifications.requestPermissions();
  if (perm.receive !== "granted") return;
  await PushNotifications.register();
  PushNotifications.addListener("registration", async (token) => {
    // POST { userId, token, platform: "ios" } to a future
    // /api/push/register endpoint. Stubbed for now — uncomment
    // once the endpoint ships.
    // await fetch("/api/push/register", {
    //   method: "POST",
    //   headers: { "Content-Type": "application/json" },
    //   body: JSON.stringify({ userId, token: token.value, platform: "ios" }),
    // });
    console.log("[native] APNs token", token.value, "for user", userId);
  });
}

// ── RevenueCat / In-App Purchase ───────────────────────────────────
// Configures the SDK once on app boot, then exposes purchase +
// restore helpers. The Capacitor SDK auto-talks to App Store
// StoreKit; the public SDK key (appl_...) for the iOS app is read
// from NEXT_PUBLIC_REVENUECAT_IOS_KEY.

let purchasesConfigured = false;

export async function configurePurchases(userId: string): Promise<void> {
  if (!isNative()) return;
  if (purchasesConfigured) return;
  const apiKey = process.env.NEXT_PUBLIC_REVENUECAT_IOS_KEY;
  if (!apiKey) {
    console.warn("[native] NEXT_PUBLIC_REVENUECAT_IOS_KEY not set — skipping IAP config");
    return;
  }
  const { Purchases, LOG_LEVEL } = await import("@revenuecat/purchases-capacitor");
  await Purchases.setLogLevel({ level: LOG_LEVEL.WARN });
  await Purchases.configure({ apiKey, appUserID: userId });
  purchasesConfigured = true;
}

export type RcPackageId = "monthly" | "annual";

export async function startPurchase(userId: string, packageId: RcPackageId): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isNative()) return { ok: false, reason: "not_native" };
  await configurePurchases(userId);
  const { Purchases } = await import("@revenuecat/purchases-capacitor");
  try {
    const offerings = await Purchases.getOfferings();
    const target = packageId === "annual" ? offerings.current?.annual : offerings.current?.monthly;
    if (!target) return { ok: false, reason: `no_${packageId}_offering` };
    await Purchases.purchasePackage({ aPackage: target });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "PURCHASE_CANCELLED" || code === "1") return { ok: false, reason: "cancelled" };
    return { ok: false, reason: code ?? "unknown" };
  }
  // Tell our backend to re-pull canonical state from RevenueCat.
  // The iOS app already has the entitlement locally, but we want
  // subscriptionStatus on User to flip via the same code path the
  // ASN webhook uses.
  const r = await fetch("/api/iap/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    return { ok: false, reason: data.error ?? `verify_failed_${r.status}` };
  }
  return { ok: true };
}

export async function restorePurchases(userId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isNative()) return { ok: false, reason: "not_native" };
  await configurePurchases(userId);
  const { Purchases } = await import("@revenuecat/purchases-capacitor");
  try {
    await Purchases.restorePurchases();
  } catch (err) {
    return { ok: false, reason: (err as { code?: string }).code ?? "unknown" };
  }
  const r = await fetch("/api/iap/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    return { ok: false, reason: data.error ?? `verify_failed_${r.status}` };
  }
  return { ok: true };
}
