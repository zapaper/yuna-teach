import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getSessionUserId } from "@/lib/session";
import AccountClient from "./AccountClient";

export const dynamic = "force-dynamic";

// /account/[userId]
//
// Self-service account management. Currently focused on Apple App
// Store Review Guideline 5.1.1(v) — every app that supports account
// creation must let the user delete the account in-app.
//
// Server-renders the user's identity, role, and subscription state so
// the client component knows whether to warn about an Apple IAP
// subscription before the user confirms deletion.

export default async function AccountPage(
  { params }: { params: Promise<{ userId: string }> },
) {
  const { userId } = await params;
  const sessionId = await getSessionUserId();
  if (!sessionId) redirect(`/login?next=/account/${userId}`);
  if (sessionId !== userId) redirect(`/account/${sessionId}`);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      displayName: true,
      email: true,
      role: true,
      subscriptionStatus: true,
      paymentSource: true,
      appleExpiresAt: true,
      parentLinks: { select: { student: { select: { id: true, name: true, displayName: true } } } },
    },
  });
  if (!user) notFound();

  return (
    <AccountClient
      user={{
        id: user.id,
        displayName: user.displayName ?? user.name,
        email: user.email,
        role: user.role,
        subscriptionStatus: user.subscriptionStatus,
        paymentSource: user.paymentSource,
        appleExpiresAtIso: user.appleExpiresAt?.toISOString() ?? null,
        linkedStudents: user.parentLinks.map(l => ({
          id: l.student.id,
          name: l.student.displayName ?? l.student.name,
        })),
      }}
    />
  );
}
