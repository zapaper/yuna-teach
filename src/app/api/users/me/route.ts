import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionUserId, clearSession } from "@/lib/session";
import { getStripe } from "@/lib/stripe";

// DELETE /api/users/me
//
// Self-service account deletion (Apple App Store Review Guideline
// 5.1.1(v) — apps that support account creation must offer account
// deletion within the app).
//
// Behaviour:
// - Verifies the caller's session and confirms the userId from the
//   request body matches it (defence in depth — query/body params
//   are NEVER trusted for destructive actions, only the cookie).
// - Cancels any active Stripe subscription server-side; we own that
//   billing relationship.
// - Apple IAP subscriptions are NOT cancelled — Apple owns that
//   billing relationship and the user must cancel via Settings →
//   Apple Account → Subscriptions. We surface this in the UI before
//   the user confirms deletion. Account data is still deleted.
// - Cascades through ParentStudent (FK is onDelete: Cascade) and the
//   user's owned ExamPaper rows (also onDelete: Cascade). Student
//   accounts whose ONLY linked parent is the deleting one are also
//   deleted, so the family's data is fully wiped.
// - Returns 200 + { ok: true } on success and clears the session
//   cookie on the way out.

export async function DELETE(request: Request) {
  const sessionId = await getSessionUserId();
  if (!sessionId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const body = (await request.json().catch(() => ({}))) as { userId?: string; confirm?: string };
  if (body.userId !== sessionId) {
    return NextResponse.json({ error: "userId mismatch" }, { status: 403 });
  }
  // Require an explicit confirmation phrase from the client so a
  // misclick can't trigger deletion.
  if (body.confirm !== "DELETE") {
    return NextResponse.json({ error: "Confirmation phrase missing" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      stripeSubscriptionId: true,
      subscriptionStatus: true,
      paymentSource: true,
      parentLinks: {
        select: {
          student: {
            select: {
              id: true,
              _count: { select: { studentLinks: true } },
            },
          },
        },
      },
    },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // 1. Cancel Stripe subscription if it's ours to cancel. Apple IAP
  //    cancellations stay with Apple (the iOS UI warns the user
  //    before they hit confirm).
  if (
    user.stripeSubscriptionId &&
    user.subscriptionStatus === "active" &&
    user.paymentSource !== "apple"
  ) {
    try {
      const stripe = getStripe();
      await stripe.subscriptions.cancel(user.stripeSubscriptionId);
      console.log(`[users/me DELETE] cancelled stripe sub ${user.stripeSubscriptionId} for user ${user.id}`);
    } catch (err) {
      // Don't block deletion on a Stripe error — log and continue.
      // The webhook will eventually catch up if the cancel succeeded
      // partially. If it didn't, a stale subscription is recoverable
      // by Stripe support; an undeleted account isn't a great user
      // experience.
      console.error(`[users/me DELETE] stripe cancel failed:`, err instanceof Error ? err.message : err);
    }
  }

  // 2. Identify linked students whose only parent is this user.
  //    Those become orphans on parent-delete, so we delete them too.
  //    Students that have OTHER linked parents stay — they're shared
  //    accounts (e.g. both parents linked) and the other parent
  //    should still see them.
  const orphanedStudentIds: string[] = [];
  if (user.role === "PARENT") {
    for (const link of user.parentLinks) {
      // _count.studentLinks is the count of ParentStudent rows where
      // this is the student. After the parent's deletion the count
      // drops by 1; if it was already 1 (only this parent), the
      // student is orphaned.
      if (link.student._count.studentLinks <= 1) {
        orphanedStudentIds.push(link.student.id);
      }
    }
  }

  // 3. Delete the user (cascades through owned exam papers, parent
  //    links, etc. per the Prisma schema). Then delete orphaned
  //    students in the same transaction.
  await prisma.$transaction(async (tx) => {
    await tx.user.delete({ where: { id: user.id } });
    if (orphanedStudentIds.length > 0) {
      await tx.user.deleteMany({ where: { id: { in: orphanedStudentIds } } });
    }
  });

  console.log(
    `[users/me DELETE] user ${user.id} (${user.name}, role=${user.role}) deleted; ` +
    `orphaned-students-also-deleted=${orphanedStudentIds.length}`,
  );

  await clearSession();
  return NextResponse.json({ ok: true });
}
