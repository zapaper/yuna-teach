// Drain the PendingEmail queue once SendGrid is back. Re-renders each
// pending row from live data (so the parent sees current numbers, not
// the stale moment the original trigger fired), sends, marks row as
// "sent". On transport failure, increments attemptCount + records the
// error — abandons the row after MAX_ATTEMPTS so the queue can't loop
// forever on a genuinely-broken row.
//
// Per-event renderers live next to the in-place send sites; this script
// dispatches by eventType to call the right one.
//
// Usage:
//   npx tsx scripts/replay-pending-emails.ts                 (drain all, real send)
//   npx tsx scripts/replay-pending-emails.ts --dry-run       (list pending only)
//   npx tsx scripts/replay-pending-emails.ts --limit=20      (cap batch size)
//   npx tsx scripts/replay-pending-emails.ts --event=signup_welcome   (filter)
//
// Idempotency: rows are flipped from "pending" → "sent" atomically. If
// the script crashes mid-batch the unsent rows remain "pending" and
// are picked up by the next invocation.

import "dotenv/config";
import sgMail from "@sendgrid/mail";
import { prisma } from "../src/lib/db";
import { loadPending, markSent, markFailed, type EventType } from "../src/lib/mail-queue";
import { sendWelcomeEmail } from "../src/lib/send-welcome-email";
import { triggerForStudentSubject } from "./send-progress-emails";
import { sendLumiIntroForReplay } from "./_do-55-send-intros";
import { sendLumiWeeklyForStudent } from "./send-lumi-weekly-emails";

if (process.env.SENDGRID_API_KEY) sgMail.setApiKey(process.env.SENDGRID_API_KEY);

const MAX_ATTEMPTS = 5;

function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const limitArg = args.find(a => a.startsWith("--limit="))?.split("=")[1];
  const eventArg = args.find(a => a.startsWith("--event="))?.split("=")[1];
  return {
    dryRun,
    limit: limitArg ? Math.max(1, parseInt(limitArg, 10)) : 100,
    eventType: eventArg as EventType | undefined,
  };
}

// Dispatch table — one renderer/sender per eventType. Each is async,
// throws on failure so we can attribute to attemptCount, and is fully
// self-contained (reads current state from DB rather than relying on
// the payload past the bare IDs).
async function sendByEvent(eventType: EventType, payload: unknown): Promise<void> {
  const p = payload as Record<string, unknown>;
  switch (eventType) {
    case "signup_welcome": {
      const parentId = String(p.parentId ?? "");
      const childId = String(p.childId ?? "");
      if (!parentId || !childId) throw new Error("missing parentId/childId");
      const parent = await prisma.user.findUnique({
        where: { id: parentId },
        select: { id: true, email: true, name: true, displayName: true },
      });
      const child = await prisma.user.findUnique({
        where: { id: childId },
        select: { id: true, name: true, displayName: true },
      });
      if (!parent?.email) throw new Error(`parent ${parentId} has no email`);
      if (!child)         throw new Error(`child ${childId} not found`);
      await sendWelcomeEmail({
        parentEmail: parent.email,
        parentId: parent.id,
        parentDisplayName: parent.displayName ?? parent.name,
        childId: child.id,
        childDisplayName: child.displayName ?? child.name,
      });
      return;
    }
    case "subject_3_quizzes_done": {
      const studentId = String(p.studentId ?? "");
      const subject = String(p.subject ?? "");
      if (!studentId || !subject) throw new Error("missing studentId/subject");
      // triggerForStudentSubject re-runs the candidate eligibility +
      // send pipeline for that one (student, subject). If the kid is
      // still eligible AND not already-sent, this delivers the email.
      // If they've since been marked sent (e.g. by an earlier replay
      // attempt), it's a no-op — desired.
      await triggerForStudentSubject(studentId, subject);
      return;
    }
    case "lumi_intro": {
      const studentId = String(p.studentId ?? "");
      const subject = String(p.subject ?? "") as "Math" | "Science" | "English";
      const parentId = String(p.parentId ?? "");
      if (!studentId || !subject || !parentId) throw new Error("missing studentId/subject/parentId");
      if (!["Math", "Science", "English"].includes(subject)) throw new Error(`bad subject "${subject}"`);
      await sendLumiIntroForReplay({ studentId, subject, parentId });
      return;
    }
    case "lumi_weekly": {
      const studentId = String(p.studentId ?? "");
      const toOverride = (p.toOverride as string | null | undefined) ?? undefined;
      if (!studentId) throw new Error("missing studentId");
      const result = await sendLumiWeeklyForStudent({ studentId, toOverride });
      if (result.status === "no-recipient") throw new Error(result.reason ?? "no recipient");
      if (result.status === "no-delta")     return; // valid no-op
      if (result.status === "queued")       throw new Error(`re-queued — ${result.reason ?? "transport still down"}`);
      return;
    }
    default:
      throw new Error(`unknown eventType "${eventType}"`);
  }
}

(async () => {
  const { dryRun, limit, eventType } = parseArgs();
  const pending = await loadPending({ limit, eventType });
  console.log(`Pending: ${pending.length}${eventType ? ` (filter=${eventType})` : ""}\n`);
  if (pending.length === 0) { await prisma.$disconnect(); return; }

  if (dryRun) {
    for (const row of pending) {
      console.log(`  [${row.eventType}] ${row.toEmail} (attempts=${row.attemptCount}, lastErr="${row.lastError ?? "—"}")`);
    }
    console.log("\nDRY RUN — pass without --dry-run to actually replay.");
    await prisma.$disconnect();
    return;
  }

  let ok = 0, fail = 0, abandoned = 0;
  for (const row of pending) {
    process.stdout.write(`  [${row.eventType}] ${row.toEmail.padEnd(40)} attempt #${row.attemptCount + 1} … `);
    try {
      await sendByEvent(row.eventType as EventType, row.payload);
      await markSent(row.id);
      process.stdout.write("✓\n");
      ok++;
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      const willAbandon = row.attemptCount + 1 >= MAX_ATTEMPTS;
      await markFailed(row.id, msg, willAbandon);
      process.stdout.write(`✗ ${msg.slice(0, 80)}${willAbandon ? " [ABANDONED]" : ""}\n`);
      if (willAbandon) abandoned++; else fail++;
    }
  }
  console.log(`\n── Summary ──`);
  console.log(`  Sent:      ${ok}`);
  console.log(`  Failed:    ${fail} (will retry on next run)`);
  console.log(`  Abandoned: ${abandoned} (reached MAX_ATTEMPTS=${MAX_ATTEMPTS})`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
