"use client";

import { useEffect, useMemo, useState } from "react";
import {
  isNative,
  configurePurchases,
  startPurchase,
  restorePurchases,
} from "@/lib/native";

// Web prices are display-only — the real charge comes from the
// Stripe Price IDs configured server-side (STRIPE_MONTHLY_PRICE_ID /
// STRIPE_ANNUAL_PRICE_ID). On native iOS we read prices from the
// RevenueCat offering instead. Edit display only when also editing
// the Stripe Price.
const WEB_PRICES = {
  monthly: { display: "S$10 / month", note: "Billed monthly. Cancel anytime." },
  annual:  { display: "S$100 / year", note: "Two months free vs monthly. Cancel anytime." },
};

type UserShape = {
  id: string;
  name: string;
  email: string | null;
  emailVerified: boolean;
  subscriptionStatus: string | null;
  paymentSource: string | null;
  appleExpiresAtIso: string | null;
  hasStripeCustomer: boolean;
  role: string;
};

type NativePackage = {
  id: "monthly" | "annual";
  priceString: string;
  introPriceString: string | null; // "1 month free" if applicable
  productIdentifier: string;
};

export default function PricingClient({ user }: { user: UserShape }) {
  const [native, setNative] = useState(false);
  const [packages, setPackages] = useState<NativePackage[]>([]);
  const [loadingOffering, setLoadingOffering] = useState(false);
  const [submitting, setSubmitting] = useState<"monthly" | "annual" | "restore" | "stripe-monthly" | "stripe-annual" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [promoCode, setPromoCode] = useState("");

  // Detect platform once, then on iOS fetch the live RC offering. The
  // dynamic import keeps the SDK out of the web bundle.
  useEffect(() => {
    setNative(isNative());
  }, []);

  useEffect(() => {
    if (!native) return;
    let cancelled = false;
    (async () => {
      setLoadingOffering(true);
      try {
        await configurePurchases(user.id);
        const { Purchases } = await import("@revenuecat/purchases-capacitor");
        const offerings = await Purchases.getOfferings();
        const current = offerings.current;
        if (!current) {
          if (!cancelled) setError("No subscription offering available — check RevenueCat config.");
          return;
        }
        const out: NativePackage[] = [];
        if (current.monthly) {
          out.push({
            id: "monthly",
            priceString: current.monthly.product.priceString,
            // RC exposes the StoreKit-side intro offer ("1 month free")
            // via product.introPrice — read its localized period string.
            introPriceString: current.monthly.product.introPrice?.periodNumberOfUnits
              ? `Free for ${current.monthly.product.introPrice.periodNumberOfUnits} ${current.monthly.product.introPrice.periodUnit.toLowerCase()}${current.monthly.product.introPrice.periodNumberOfUnits === 1 ? "" : "s"}`
              : null,
            productIdentifier: current.monthly.product.identifier,
          });
        }
        if (current.annual) {
          out.push({
            id: "annual",
            priceString: current.annual.product.priceString,
            introPriceString: current.annual.product.introPrice?.periodNumberOfUnits
              ? `Free for ${current.annual.product.introPrice.periodNumberOfUnits} ${current.annual.product.introPrice.periodUnit.toLowerCase()}${current.annual.product.introPrice.periodNumberOfUnits === 1 ? "" : "s"}`
              : null,
            productIdentifier: current.annual.product.identifier,
          });
        }
        if (!cancelled) setPackages(out);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load offering");
      } finally {
        if (!cancelled) setLoadingOffering(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [native, user.id]);

  const isActive = user.subscriptionStatus === "active";
  const expiresLabel = useMemo(() => {
    if (!user.appleExpiresAtIso) return null;
    return new Date(user.appleExpiresAtIso).toLocaleDateString();
  }, [user.appleExpiresAtIso]);

  // ── Actions ─────────────────────────────────────────────────────

  async function onSubscribeNative(pkg: "monthly" | "annual") {
    setError(null);
    setSubmitting(pkg);
    try {
      const result = await startPurchase(user.id, pkg);
      if (!result.ok) {
        if (result.reason === "stripe_conflict") {
          setError("You already have an active subscription via the website. Manage it from there.");
        } else if (result.reason === "cancelled") {
          // user-initiated cancel, no error toast
        } else {
          setError(`Purchase failed: ${result.reason}`);
        }
      } else {
        // Subscription is active — refresh the page so server-rendered
        // user state reflects the new subscriptionStatus.
        window.location.reload();
      }
    } finally {
      setSubmitting(null);
    }
  }

  async function onRestore() {
    setError(null);
    setSubmitting("restore");
    try {
      const result = await restorePurchases(user.id);
      if (!result.ok) {
        setError(`Restore failed: ${result.reason}`);
      } else {
        window.location.reload();
      }
    } finally {
      setSubmitting(null);
    }
  }

  async function onSubscribeWeb(plan: "monthly" | "annual") {
    if (!user.email || !user.emailVerified) {
      setError("Please verify your email before subscribing.");
      return;
    }
    setError(null);
    setSubmitting(plan === "monthly" ? "stripe-monthly" : "stripe-annual");
    try {
      const r = await fetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: user.id,
          plan,
          promoCode: promoCode.trim() || undefined,
        }),
      });
      const data = await r.json();
      if (!r.ok || !data.url) {
        setError(data.error ?? "Could not start checkout");
        return;
      }
      window.location.href = data.url as string;
    } finally {
      setSubmitting(null);
    }
  }

  async function onManageSub() {
    if (user.paymentSource === "apple") {
      // Apple's recommended way: deep-link to system Subscriptions
      // settings. Works in WKWebView via standard URL scheme.
      window.location.href = "https://apps.apple.com/account/subscriptions";
      return;
    }
    // Stripe: hit the existing GET /api/subscribe to fetch the portal URL.
    setSubmitting("stripe-monthly");
    try {
      const r = await fetch(`/api/subscribe?userId=${user.id}`);
      const data = await r.json();
      if (data.portalUrl) window.location.href = data.portalUrl;
      else setError("Could not open subscription portal.");
    } finally {
      setSubmitting(null);
    }
  }

  // ── Render ──────────────────────────────────────────────────────

  return (
    <main className="min-h-screen bg-gradient-to-b from-[#eff4ff] to-white pb-12">
      <div className="max-w-md mx-auto px-5 pt-10">
        <h1 className="text-3xl font-extrabold text-[#001e40] mb-1">MarkForYou Premium</h1>
        <p className="text-sm text-[#43474f] mb-7">
          Unlimited AI marking, progress tracking, and personalised mistake-revision tools.
        </p>

        {isActive && (
          <div className="bg-[#d1fae5] border border-[#006c49]/30 rounded-2xl p-4 mb-6">
            <p className="text-sm font-bold text-[#006c49] mb-1">You&apos;re subscribed.</p>
            <p className="text-xs text-[#43474f]">
              Source: {user.paymentSource === "apple" ? "App Store" : "Website"}
              {expiresLabel ? ` · Renews ${expiresLabel}` : ""}
            </p>
            <button
              onClick={onManageSub}
              className="mt-3 text-xs font-bold text-[#003366] hover:underline"
            >
              Manage subscription →
            </button>
          </div>
        )}

        {/* Native iOS package list */}
        {!isActive && native && (
          <>
            {loadingOffering && (
              <p className="text-sm text-[#43474f] py-8 text-center">Loading prices…</p>
            )}
            {!loadingOffering && packages.length === 0 && (
              <p className="text-sm text-[#ba1a1a] py-4">
                No subscription packages available. {error}
              </p>
            )}
            {packages.map((pkg) => (
              <div
                key={pkg.id}
                className="bg-white rounded-2xl border border-[#e5eeff] p-5 mb-3 shadow-sm"
              >
                <div className="flex items-baseline justify-between mb-1">
                  <h2 className="text-lg font-bold text-[#001e40] capitalize">{pkg.id}</h2>
                  {pkg.id === "annual" && (
                    <span className="text-[10px] font-extrabold uppercase tracking-widest bg-[#fff7e6] text-[#a06900] px-2 py-0.5 rounded-full">
                      Save 20%
                    </span>
                  )}
                </div>
                {pkg.introPriceString && (
                  <p className="text-sm font-bold text-[#006c49] mb-1">
                    ✓ {pkg.introPriceString}, then {pkg.priceString}
                  </p>
                )}
                {!pkg.introPriceString && (
                  <p className="text-sm font-bold text-[#001e40] mb-1">{pkg.priceString}</p>
                )}
                <p className="text-xs text-[#43474f] mb-4">
                  Cancel anytime in your iPhone&apos;s Settings → Apple ID → Subscriptions.
                </p>
                <button
                  onClick={() => onSubscribeNative(pkg.id)}
                  disabled={submitting !== null}
                  className="w-full py-3 rounded-xl bg-[#003366] text-white text-sm font-bold hover:bg-[#002145] disabled:opacity-50"
                >
                  {submitting === pkg.id ? "Starting…" : pkg.introPriceString ? "Start free trial" : "Subscribe"}
                </button>
              </div>
            ))}

            <button
              onClick={onRestore}
              disabled={submitting !== null}
              className="w-full text-xs font-bold text-[#003366] hover:underline mt-2 mb-6 disabled:opacity-50"
            >
              {submitting === "restore" ? "Restoring…" : "Restore purchases"}
            </button>

            {/* Apple-required subscription disclosure block. Apple's
                review team cross-checks this against their boilerplate;
                missing or substantially-edited copy is a near-certain
                rejection on first submission. */}
            <p className="text-[11px] text-[#737780] leading-relaxed mt-4">
              Payment will be charged to your Apple Account at confirmation of purchase.
              Subscriptions automatically renew unless cancelled at least 24 hours before
              the end of the current period. Your account will be charged for renewal
              within 24 hours prior to the end of the current period. You can manage and
              cancel your subscriptions in your Apple Account settings after purchase.
              {" "}
              <a href="https://www.markforyou.com/privacy" className="underline">Privacy Policy</a>
              {" · "}
              <a href="https://www.markforyou.com/terms" className="underline">Terms of Use</a>.
            </p>
          </>
        )}

        {/* Web (Stripe) path */}
        {!isActive && !native && (
          <>
            <div className="bg-white rounded-2xl border border-[#e5eeff] p-5 mb-3 shadow-sm">
              <h2 className="text-lg font-bold text-[#001e40] mb-1">Monthly</h2>
              <p className="text-sm font-bold text-[#001e40] mb-1">{WEB_PRICES.monthly.display}</p>
              <p className="text-xs text-[#43474f] mb-4">{WEB_PRICES.monthly.note}</p>
              <button
                onClick={() => onSubscribeWeb("monthly")}
                disabled={submitting !== null}
                className="w-full py-3 rounded-xl bg-[#003366] text-white text-sm font-bold hover:bg-[#002145] disabled:opacity-50"
              >
                {submitting === "stripe-monthly" ? "Loading…" : "Subscribe monthly"}
              </button>
            </div>

            <div className="bg-white rounded-2xl border-2 border-[#a7c8ff] p-5 mb-3 shadow-sm relative">
              <span className="absolute -top-2 right-4 text-[10px] font-extrabold uppercase tracking-widest bg-[#fff7e6] text-[#a06900] px-2 py-0.5 rounded-full border border-[#a06900]/20">
                Save S$20
              </span>
              <h2 className="text-lg font-bold text-[#001e40] mb-1">Annual</h2>
              <p className="text-sm font-bold text-[#001e40] mb-1">{WEB_PRICES.annual.display}</p>
              <p className="text-xs text-[#43474f] mb-4">{WEB_PRICES.annual.note}</p>
              <button
                onClick={() => onSubscribeWeb("annual")}
                disabled={submitting !== null}
                className="w-full py-3 rounded-xl bg-[#003366] text-white text-sm font-bold hover:bg-[#002145] disabled:opacity-50"
              >
                {submitting === "stripe-annual" ? "Loading…" : "Subscribe annually"}
              </button>
            </div>

            <details className="mb-3">
              <summary className="text-xs font-bold text-[#003366] cursor-pointer hover:underline">
                Have a promo code?
              </summary>
              <input
                type="text"
                value={promoCode}
                onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
                placeholder="Enter code"
                className="mt-2 w-full px-3 py-2 rounded-xl border border-[#c3c6d1] text-sm uppercase tracking-wide focus:outline-none focus:border-[#003366]"
              />
              <p className="text-[11px] text-[#737780] mt-1">
                Discount applies at checkout. Trial-extension codes are redeemed at signup, not here.
              </p>
            </details>

            <p className="text-[11px] text-[#737780] leading-relaxed mt-4">
              You will be redirected to Stripe to complete payment. Subscriptions renew
              automatically unless cancelled.{" "}
              <a href="/privacy" className="underline">Privacy Policy</a>
              {" · "}
              <a href="/terms" className="underline">Terms of Use</a>.
            </p>
          </>
        )}

        {error && (
          <div className="mt-4 bg-[#ffdad6] border border-[#ba1a1a]/30 rounded-xl px-4 py-3 text-sm text-[#ba1a1a]">
            {error}
          </div>
        )}
      </div>
    </main>
  );
}
