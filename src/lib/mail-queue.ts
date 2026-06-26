// Outbound-email queue. Wraps the send call so that when the upstream
// transport rejects us (SendGrid 401 during the trial-expiry outage,
// 429 burst limit, etc.), the send intent is captured in the
// PendingEmail table for replay once transport is back.
//
// USAGE pattern at every send site:
//
//   import { tryOrQueue } from "@/lib/mail-queue";
//
//   const result = await tryOrQueue({
//     eventType: "signup_welcome",
//     toEmail:   parent.email,
//     toName:    parent.name,
//     payload:   { parentId: parent.id },
//     send:      async () => sgMail.send({ ... }),
//   });
//
// When transport is back, scripts/replay-pending-emails.ts dispatches by
// eventType to the right renderer, sends, and marks rows "sent". The
// payload should be the MINIMUM needed to re-render the email at replay
// time — render content from live data so the parent sees current
// numbers, not the values that were true when the send first failed.

import { prisma } from "@/lib/db";
import type { Prisma } from "@prisma/client";

export type EventType =
  | "signup_welcome"
  | "subject_3_quizzes_done"
  | "lumi_intro"
  | "lumi_weekly";

export type QueueArgs = {
  eventType: EventType;
  toEmail: string;
  toName?: string | null;
  payload: Prisma.InputJsonValue;
  send: () => Promise<unknown>;
};

export type QueueResult =
  | { sent: true;  queued: false }
  | { sent: false; queued: true; queueId: string; reason: string }
  | { sent: false; queued: false; reason: string };

// Errors that SHOULD queue. 401 = key revoked / trial expired. 403 =
// sender / scope issue (queue too — same operator action needed). 429
// = rate-limited (queue and we'll replay later). 5xx = SendGrid down.
// Anything else (bad recipient, malformed payload) we let bubble so
// the caller decides; we don't want to silently queue a "to: invalid"
// that will keep failing on replay.
function isTransientTransportError(err: unknown): { ok: boolean; reason: string } {
  if (!err || typeof err !== "object") return { ok: false, reason: "non-error throw" };
  const e = err as { code?: number; statusCode?: number; message?: string };
  const code = e.code ?? e.statusCode;
  if (code === 401) return { ok: true, reason: `401 Unauthorized (key disabled / trial expired)` };
  if (code === 403) return { ok: true, reason: `403 Forbidden (sender / scope)` };
  if (code === 429) return { ok: true, reason: `429 Rate Limited` };
  if (typeof code === "number" && code >= 500 && code < 600) return { ok: true, reason: `${code} transport error` };
  return { ok: false, reason: `${code ?? "?"}: ${e.message ?? "(no msg)"}` };
}

export async function tryOrQueue(args: QueueArgs): Promise<QueueResult> {
  try {
    await args.send();
    return { sent: true, queued: false };
  } catch (err) {
    const verdict = isTransientTransportError(err);
    if (!verdict.ok) {
      // Permanent failure — surface upstream. Caller decides logging.
      return { sent: false, queued: false, reason: verdict.reason };
    }
    const row = await prisma.pendingEmail.create({
      data: {
        eventType: args.eventType,
        payload:   args.payload,
        toEmail:   args.toEmail,
        toName:    args.toName ?? null,
        status:    "pending",
        attemptCount: 1,
        lastError: verdict.reason,
        attemptedAt: new Date(),
      },
      select: { id: true },
    });
    return { sent: false, queued: true, queueId: row.id, reason: verdict.reason };
  }
}

// Fetch a window of pending rows for the replay sweeper. Caller iterates
// each, re-renders, sends, then calls markSent / markFailed.
export async function loadPending(opts: { limit?: number; eventType?: EventType }) {
  return prisma.pendingEmail.findMany({
    where: {
      status: "pending",
      ...(opts.eventType ? { eventType: opts.eventType } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: opts.limit ?? 50,
  });
}

export async function markSent(id: string) {
  return prisma.pendingEmail.update({
    where: { id },
    data: { status: "sent", sentAt: new Date(), lastError: null },
  });
}

export async function markFailed(id: string, error: string, abandon = false) {
  return prisma.pendingEmail.update({
    where: { id },
    data: {
      status: abandon ? "abandoned" : "pending",
      attemptCount: { increment: 1 },
      attemptedAt: new Date(),
      lastError: error.slice(0, 1000),
    },
  });
}
