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

/** The Stripe Price ID for the S$5/month subscription */
export const MONTHLY_PRICE_ID = process.env.STRIPE_PRICE_ID!;
