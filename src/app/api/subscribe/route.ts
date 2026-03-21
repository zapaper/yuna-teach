import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getStripe, MONTHLY_PRICE_ID } from "@/lib/stripe";

/** POST: Create a Stripe Checkout session for S$5/month subscription */
export async function POST(request: NextRequest) {
  const { userId } = await request.json();
  if (!userId) return NextResponse.json({ error: "Missing userId" }, { status: 400 });

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

  // Create or retrieve Stripe customer
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

  // Create Checkout session
  const origin = request.headers.get("origin") || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [{ price: MONTHLY_PRICE_ID, quantity: 1 }],
    success_url: `${origin}/home/${userId}?subscribed=1`,
    cancel_url: `${origin}/home/${userId}?canceled=1`,
    metadata: { userId },
  });

  return NextResponse.json({ url: session.url });
}

/** GET: Get subscription status + Stripe portal URL for managing subscription */
export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("userId");
  if (!userId) return NextResponse.json({ error: "Missing userId" }, { status: 400 });

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
