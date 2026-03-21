import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getStripe } from "@/lib/stripe";

export async function POST(request: NextRequest) {
  const body = await request.text();
  const sig = request.headers.get("stripe-signature");
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!sig || !webhookSecret) {
    return NextResponse.json({ error: "Missing signature or secret" }, { status: 400 });
  }

  const stripe = getStripe();
  let event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err) {
    console.error("[stripe-webhook] Signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const { type, data } = event;

  switch (type) {
    case "checkout.session.completed": {
      const session = data.object;
      const userId = session.metadata?.userId;
      const subscriptionId = session.subscription as string;
      if (userId && subscriptionId) {
        await prisma.user.update({
          where: { id: userId },
          data: {
            stripeSubscriptionId: subscriptionId,
            subscriptionStatus: "active",
          },
        });
        console.log(`[stripe] User ${userId} subscribed (${subscriptionId})`);
      }
      break;
    }

    case "customer.subscription.updated": {
      const sub = data.object;
      const customer = await prisma.user.findFirst({
        where: { stripeCustomerId: sub.customer as string },
      });
      if (customer) {
        await prisma.user.update({
          where: { id: customer.id },
          data: { subscriptionStatus: sub.status === "active" ? "active" : sub.status },
        });
        console.log(`[stripe] Subscription ${sub.id} status → ${sub.status}`);
      }
      break;
    }

    case "customer.subscription.deleted": {
      const sub = data.object;
      const customer = await prisma.user.findFirst({
        where: { stripeCustomerId: sub.customer as string },
      });
      if (customer) {
        await prisma.user.update({
          where: { id: customer.id },
          data: { subscriptionStatus: "canceled", stripeSubscriptionId: null },
        });
        console.log(`[stripe] Subscription ${sub.id} canceled for user ${customer.id}`);
      }
      break;
    }

    case "invoice.payment_failed": {
      const invoice = data.object;
      const customer = await prisma.user.findFirst({
        where: { stripeCustomerId: invoice.customer as string },
      });
      if (customer) {
        await prisma.user.update({
          where: { id: customer.id },
          data: { subscriptionStatus: "past_due" },
        });
        console.log(`[stripe] Payment failed for user ${customer.id}`);
      }
      break;
    }

    default:
      // Unhandled event type
      break;
  }

  return NextResponse.json({ received: true });
}
