import Stripe from "stripe";

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: "2026-02-25.clover",
    });
  }
  return _stripe;
}

// Stripe Price IDs for the two web plans. STRIPE_PRICE_ID is kept as
// the legacy alias for the monthly tier so older code keeps working;
// new code should reference MONTHLY_PRICE_ID / ANNUAL_PRICE_ID.
export const MONTHLY_PRICE_ID = process.env.STRIPE_MONTHLY_PRICE_ID || process.env.STRIPE_PRICE_ID!;
export const ANNUAL_PRICE_ID = process.env.STRIPE_ANNUAL_PRICE_ID || "";

export type PlanId = "monthly" | "annual";

export function priceIdForPlan(plan: PlanId): string {
  if (plan === "annual") {
    if (!ANNUAL_PRICE_ID) throw new Error("STRIPE_ANNUAL_PRICE_ID not configured");
    return ANNUAL_PRICE_ID;
  }
  return MONTHLY_PRICE_ID;
}
