import { prisma } from "@/lib/db";
import PricingClient from "./PricingClient";

export const dynamic = "force-dynamic";

// /pricing/[userId]
//
// Subscription paywall + upgrade screen. Server-renders the user's
// current subscription state so the page loads with no flash, then
// hands off to the client component which:
//   - On native iOS: fetches the live RevenueCat offering + drives
//     StoreKit purchases via @revenuecat/purchases-capacitor.
//   - On web: keeps the existing Stripe Checkout flow.
//
// Either path lands on the same /api/iap/verify or /api/subscribe
// endpoints already in place — no new server work required.

export default async function PricingPage(
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      displayName: true,
      email: true,
      emailVerified: true,
      subscriptionStatus: true,
      paymentSource: true,
      appleExpiresAt: true,
      stripeCustomerId: true,
      role: true,
    },
  });

  if (!user) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-slate-50 px-6 text-center">
        <div>
          <h1 className="text-xl font-bold text-[#001e40] mb-2">Account not found</h1>
          <p className="text-sm text-[#43474f]">Sign in again from the homepage.</p>
        </div>
      </main>
    );
  }

  // Strip Date objects to ISO strings — Server → Client serialisation
  // needs to be JSON-safe.
  return (
    <PricingClient
      user={{
        id: user.id,
        name: user.displayName ?? user.name,
        email: user.email,
        emailVerified: user.emailVerified,
        subscriptionStatus: user.subscriptionStatus,
        paymentSource: user.paymentSource,
        appleExpiresAtIso: user.appleExpiresAt?.toISOString() ?? null,
        hasStripeCustomer: !!user.stripeCustomerId,
        role: user.role,
      }}
    />
  );
}
