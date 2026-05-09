// Subscription / trial state helpers. The DB shape:
//   - subscriptionStatus: "active" | "canceled" | "past_due" | "expired"
//                         | "trialing" | "trial_expired" | null
//   - trialEndsAt:        DateTime? (set at signup, +30 days; +promo days)
//   - paymentSource:      "stripe" | "apple" | null
//
// Access model (per the pricing strategy):
//   - "active":         full access. (Stripe or Apple sub.)
//   - "trialing" + (now <= trialEndsAt): full access.
//   - everything else:  read-only — keep progress reports etc., but
//     blocked from creating new assignments / quizzes / papers /
//     daily-quiz attempts. The UI should route blocked actions to
//     /pricing/[userId].

import type { User } from "@prisma/client";

type SubFields = Pick<
  User,
  "subscriptionStatus" | "trialEndsAt" | "appleExpiresAt" | "paymentSource"
>;

/** True when the user has an active paid subscription (Stripe or Apple). */
export function isSubscribed(u: SubFields | null | undefined): boolean {
  if (!u) return false;
  if (u.subscriptionStatus !== "active") return false;
  // For Apple subs, also check expiry — webhooks sometimes lag.
  if (u.paymentSource === "apple" && u.appleExpiresAt) {
    return u.appleExpiresAt.getTime() > Date.now();
  }
  return true;
}

/** True when the user is inside the free-trial window (and not yet paid). */
export function isTrialing(u: SubFields | null | undefined): boolean {
  if (!u) return false;
  if (isSubscribed(u)) return false;
  if (!u.trialEndsAt) return false;
  return u.trialEndsAt.getTime() > Date.now();
}

/** Days remaining in trial — rounded UP. 0 if trial expired or not in trial. */
export function daysLeftInTrial(u: SubFields | null | undefined): number {
  if (!u || !u.trialEndsAt) return 0;
  const ms = u.trialEndsAt.getTime() - Date.now();
  if (ms <= 0) return 0;
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

/**
 * Master access check used by the pop-up + the gates on creation
 * routes. True iff user has paid OR is still inside trial.
 */
export function hasFullAccess(u: SubFields | null | undefined): boolean {
  return isSubscribed(u) || isTrialing(u);
}

/**
 * Server-side gate for "can this user create a new
 * assignment / quiz / exam paper / daily-quiz session?"
 * Returns reason on denial so callers can return a meaningful
 * error to the UI.
 */
export function canAssign(
  u: SubFields | null | undefined
): { ok: true } | { ok: false; reason: "no_access" } {
  if (hasFullAccess(u)) return { ok: true };
  return { ok: false, reason: "no_access" };
}

/** Default trial length in days for a brand-new signup with no promo. */
export const DEFAULT_TRIAL_DAYS = 30;

/**
 * Master kill-switch for the billing system. Default OFF — while
 * we're in beta, the trial fields are populated on signup but
 * nothing is *enforced*: gates are no-ops, the trial-reminder
 * pop-up doesn't fire. Flip NEXT_PUBLIC_BILLING_ENFORCED=true on
 * Railway when we're ready to start charging.
 *
 * The NEXT_PUBLIC_ prefix lets the client-side TrialReminder read
 * the same flag without a separate server round-trip.
 *
 * Why a flag instead of a code branch removed later: trialEndsAt
 * is being written on every signup right now, so when the day
 * comes we just flip the flag and existing accounts already have
 * trial windows set — no surprise lockouts, no rollback fire-drill.
 */
export function isBillingEnforced(): boolean {
  return process.env.NEXT_PUBLIC_BILLING_ENFORCED === "true";
}

/**
 * Server-side gate. Loads the user (and their linked parents if the
 * user is a STUDENT) and returns a NextResponse if blocked, or null
 * if allowed. Use at the top of POST handlers that create new
 * assignable content.
 *
 *   const blocked = await guardCanAssign(userId);
 *   if (blocked) return blocked;
 *
 * Access rule: user is allowed if THEIR account has full access OR
 * (user is a student) any linked parent has full access. This is so
 * a paying parent's children can keep using the app after their own
 * trial ends, without us having to fan out subscriptionStatus across
 * sibling rows on every payment webhook.
 *
 * Returns 402 (Payment Required) on block — the client treats that
 * status as "show pay screen".
 */
export async function guardCanAssign(
  userId: string | null | undefined,
): Promise<Response | null> {
  // Beta kill-switch — flag is OFF by default, all calls allowed.
  if (!isBillingEnforced()) return null;
  if (!userId) return null; // caller validates separately
  const { prisma } = await import("./db");
  const { NextResponse } = await import("next/server");
  const { isAdmin } = await import("./admin");
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      name: true,
      role: true,
      settings: true,
      subscriptionStatus: true,
      trialEndsAt: true,
      appleExpiresAt: true,
      paymentSource: true,
      studentLinks: {
        include: {
          parent: {
            select: {
              subscriptionStatus: true,
              trialEndsAt: true,
              appleExpiresAt: true,
              paymentSource: true,
            },
          },
        },
      },
    },
  });
  // Admin bypass — admins assign + manage across accounts for
  // support; their own subscription state is irrelevant.
  if (isAdmin(user)) return null;
  if (canAssign(user).ok) return null;
  if (user?.role === "STUDENT") {
    const parentOk = user.studentLinks.some((l) => canAssign(l.parent).ok);
    if (parentOk) return null;
  }
  return NextResponse.json(
    { error: "subscription_required", message: "Your trial has ended. Subscribe to keep assigning new work." },
    { status: 402 },
  );
}
