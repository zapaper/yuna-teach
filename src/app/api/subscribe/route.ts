import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { prisma } from "@/lib/db";
import { getStripe, priceIdForPlan, type PlanId } from "@/lib/stripe";
import { requireSession, resolveActor } from "@/lib/auth-guard";

/**
 * POST: Create a Stripe Checkout session.
 * Body: { userId, plan: "monthly" | "annual", promoCode?: string }
 * - plan defaults to "monthly" for back-compat with the existing UI.
 * - promoCode, if provided, must be a PromoCode of kind="stripe_coupon"
 *   in our DB; the stored value is the Stripe Coupon ID we forward.
 *   Trial-extending codes are redeemed at signup, not here.
 */
export async function POST(request: NextRequest) {
  const auth = await requireSession();
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const userId = auth.userId;
  const body = await request.json();
  const { plan = "monthly", promoCode } = body as {
    plan?: PlanId; promoCode?: string;
  };
  if (plan !== "monthly" && plan !== "annual") {
    return NextResponse.json({ error: "Invalid plan" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true, stripeCustomerId: true, subscriptionStatus: true },
  });

  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  if (!user.email) return NextResponse.json({ error: "Email required" }, { status: 400 });
  if (!user.emailVerified) return NextResponse.json({ error: "Email not verified" }, { status: 400 });
  if (user.subscriptionStatus === "active") {
    return NextResponse.json({ error: "Already subscribed" }, { status: 400 });
  }

  const stripe = getStripe();

  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { userId },
    });
    customerId = customer.id;
    await prisma.user.update({
      where: { id: userId },
      data: { stripeCustomerId: customerId },
    });
  }

  // Resolve a stripe_coupon promo code to a Stripe coupon id. We look
  // up the code in our DB rather than passing the user input through,
  // so admins control which Stripe coupons are user-facing and we can
  // enforce maxRedemptions / expiry consistently with trial-day codes.
  let discounts: Stripe.Checkout.SessionCreateParams.Discount[] | undefined;
  if (promoCode && typeof promoCode === "string" && promoCode.trim()) {
    const code = promoCode.trim().toUpperCase();
    const promo = await prisma.promoCode.findUnique({ where: { code } });
    if (promo && promo.active && promo.kind === "stripe_coupon" &&
        (!promo.expiresAt || promo.expiresAt > new Date()) &&
        (promo.maxRedemptions === null || promo.redeemedCount < promo.maxRedemptions)) {
      discounts = [{ coupon: promo.value }];
    }
  }

  const origin = request.headers.get("origin") || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: priceIdForPlan(plan), quantity: 1 }],
    success_url: `${origin}/home/${userId}?subscribed=1`,
    cancel_url: `${origin}/home/${userId}?canceled=1`,
    metadata: { userId, plan, promoCode: promoCode ?? "" },
    ...(discounts ? { discounts } : { allow_promotion_codes: true }),
  });

  return NextResponse.json({ url: session.url });
}

/** GET: Get subscription status + Stripe portal URL for managing subscription */
export async function GET(request: NextRequest) {
  const target = request.nextUrl.searchParams.get("userId");
  const auth = await resolveActor(target);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const userId = auth.userId;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { subscriptionStatus: true, stripeCustomerId: true, emailVerified: true },
  });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  let portalUrl: string | null = null;
  if (user.stripeCustomerId && user.subscriptionStatus === "active") {
    const stripe = getStripe();
    const origin = request.headers.get("origin") || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const portal = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${origin}/home/${userId}`,
    });
    portalUrl = portal.url;
  }

  return NextResponse.json({
    subscriptionStatus: user.subscriptionStatus || "free",
    emailVerified: user.emailVerified,
    portalUrl,
  });
}
