// Daily Lumi cron — runs every morning, fans out:
//   (1) Intro emails to (kid × subject) pairs that have a bundled
//       Lumi cache AND haven't been emailed yet (settings.lumiIntroSent
//       miss). Reuses runIntroSend from _do-55-send-intros.ts so the
//       same eligibility, idempotency, throttle, and queue-on-failure
//       logic the manual script uses also drives the cron.
//   (2) Weekly delta emails (when --send-deltas is set — until then,
//       the dry-run still PROBES + PRINTS what would be sent so we can
//       see the plan before flipping the switch). Throttle for deltas
//       is 6 days since last send per (kid × subject), tracked via
//       settings.lumiWeeklySentAt[subjectKey]. Same idempotency model
//       as the intro, just with a sliding window instead of "once ever".
//
// Idempotency:
//   - Intros use settings.lumiIntroSent[subjectKey] (once ever).
//   - Deltas use settings.lumiWeeklySentAt[subjectKey] (6-day cooldown).
//   - The cron NEVER passes force=true. Force is reserved for explicit
//     operator action via the CLI.
//
// External mailer log:
//   - Intro sends already POST to MAILER_URL/api/events/email-sent
//     from inside runIntroSend.
//   - Delta sends (once activated) will need the same POST added to
//     sendLumiWeeklyForStudent — TODO marker below.
//
// Multi-parent edge case (inherited from runIntroSend): the flag is
// per (kid × subject), not per (kid × subject × parent). If parent A
// succeeds and parent B fails on the same run, the flag flips and
// parent B never gets the intro. Documented in _do-55-send-intros.ts.
//
// Usage:
//   npx tsx scripts/daily-lumi-cron.ts --dry-run     (preview only)
//   npx tsx scripts/daily-lumi-cron.ts               (live send, intro only)
//   npx tsx scripts/daily-lumi-cron.ts --send-deltas (also fan out
//                                                    weekly delta)

import "dotenv/config";
import { prisma } from "../src/lib/db";
import { loadCandidates, runIntroSend, type Candidate } from "./_do-55-send-intros";
import { loadTutorData } from "../src/lib/tutor";

const ARGS = process.argv.slice(2);
const DRY  = ARGS.includes("--dry-run");
const SEND_DELTAS = ARGS.includes("--send-deltas");

const DELTA_SUBJECTS = ["Math", "Science", "English"] as const;
type DeltaSubject = (typeof DELTA_SUBJECTS)[number];

const DELTA_COOLDOWN_DAYS = 6;

function fmtDateShort(iso: string | undefined | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "invalid";
  return d.toISOString().slice(0, 10);
}

function daysSince(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

(async () => {
  const runId = new Date().toISOString();
  console.log(`──── daily-lumi-cron ${runId} ────`);
  console.log(`  mode: ${DRY ? "DRY-RUN" : "LIVE"}    deltas: ${SEND_DELTAS ? "ON" : "off (gated, --send-deltas to enable)"}`);

  // ============================================================
  //  INTRO PLAN
  // ============================================================
  console.log(`\n[INTRO]`);
  const candidates = await loadCandidates();
  const introToSend  = candidates.filter(c => !c.alreadySent);
  const introSkipped = candidates.filter(c =>  c.alreadySent);

  // Group by kid so a kid eligible in 2 subjects shows as ONE row with 2 subjects.
  type KidIntroRow = { studentId: string; studentName: string; subjects: Array<{ subject: string; parents: string[]; sent: boolean }> };
  const byKid = new Map<string, KidIntroRow>();
  for (const c of candidates) {
    let r = byKid.get(c.studentId);
    if (!r) {
      r = { studentId: c.studentId, studentName: c.studentName, subjects: [] };
      byKid.set(c.studentId, r);
    }
    r.subjects.push({ subject: c.subject, parents: c.parents.map(p => p.email), sent: c.alreadySent });
  }
  const kidsToSend  = [...byKid.values()].filter(r => r.subjects.some(s => !s.sent));
  const kidsAllSent = [...byKid.values()].filter(r => r.subjects.every(s => s.sent));

  console.log(`  ${candidates.length} eligible (kid × subject) pairs across ${byKid.size} kids`);
  console.log(`  → to send now: ${introToSend.length} pairs across ${kidsToSend.length} kids`);
  console.log(`  → already sent: ${introSkipped.length} pairs`);

  if (kidsToSend.length > 0) {
    console.log(`\n  ── kids who will receive intro emails today ──`);
    for (const r of kidsToSend) {
      const newSubjects = r.subjects.filter(s => !s.sent);
      const alreadySubjects = r.subjects.filter(s =>  s.sent);
      const subjectsStr = newSubjects.map(s => s.subject).join(" + ");
      const parentList = [...new Set(newSubjects.flatMap(s => s.parents))].join(", ");
      const tag = alreadySubjects.length > 0 ? `  (already sent: ${alreadySubjects.map(s => s.subject).join(", ")})` : "";
      console.log(`    ${r.studentName.padEnd(22)} → ${newSubjects.length} subject${newSubjects.length === 1 ? "" : "s"} (${subjectsStr})  →  ${parentList}${tag}`);
    }
  }
  if (kidsAllSent.length > 0 && DRY) {
    console.log(`\n  ── already sent (won't re-send) — sample first 10 ──`);
    for (const r of kidsAllSent.slice(0, 10)) {
      console.log(`    ${r.studentName.padEnd(22)} : ${r.subjects.map(s => s.subject).join(", ")}`);
    }
    if (kidsAllSent.length > 10) console.log(`    … and ${kidsAllSent.length - 10} more`);
  }

  // Fan out for real (or just say "would send" on dry-run)
  if (!DRY) {
    console.log(`\n  fanning out intro emails…`);
    try {
      const res = await runIntroSend({ force: false, dry: false });
      console.log(`  result: sent=${res.sent}  failed=${res.failed}  eligible=${res.eligible}  skipped=${res.skipped}`);
    } catch (err) {
      console.error(`  FAILED: ${err}`);
    }
  }

  // ============================================================
  //  DELTA PLAN — Friday only
  // ============================================================
  // Weekly delta cadence locked to Friday on 2026-06-27 so parents
  // get a predictable "your weekly update" moment rather than rolling
  // notifications across the week. The probe still runs on dry-run
  // (so you can preview the plan any day) — only the LIVE send is
  // gated. UTC day-of-week: 0=Sun, 1=Mon, …, 5=Fri.
  const isFriday = new Date().getUTCDay() === 5;
  console.log(`\n[DELTA]  cooldown=${DELTA_COOLDOWN_DAYS}d per (kid × subject), 1 email per kid (first linked parent), Friday-only`);
  if (!isFriday && !DRY) {
    console.log(`  today is not Friday (UTC day=${new Date().getUTCDay()}) — skipping delta send`);
    console.log(`\n──── done ${new Date().toISOString()} ────`);
    await prisma.$disconnect();
    return;
  }
  // Only kids who've received at least one intro are eligible for a
  // delta — without an intro they have no baseline for "since last
  // week", and the delta email won't make sense to a parent who
  // hasn't met Lumi yet.
  const candidateStudentIds = new Set<string>(candidates.filter(c => c.alreadySent).map(c => c.studentId));
  // Probe each (kid × subject) — if loadTutorData returns weeklyDelta,
  // there's a delta to send. We respect the delta cooldown (6 days
  // since lumiWeeklySentAt[subject]).
  type DeltaRow = {
    studentName: string;
    studentId: string;
    deltas: Array<{ subject: DeltaSubject; lastSent: string | null; cooldownActive: boolean }>;
    // First linked parent — matches what sendLumiWeeklyForStudent
    // actually addresses via stu.studentLinks[0].parent. We surface it
    // separately so the dry-run output reflects the REAL recipient,
    // not a fan-out we're not going to do.
    recipient: string | null;
  };
  const deltaPlan: DeltaRow[] = [];
  for (const sid of candidateStudentIds) {
    const stu = await prisma.user.findUnique({
      where: { id: sid },
      select: {
        id: true, name: true, settings: true,
        studentLinks: { select: { parent: { select: { email: true } } } },
      },
    });
    if (!stu) continue;
    const sentMap = (stu.settings as { lumiWeeklySentAt?: Record<string, string> } | null)?.lumiWeeklySentAt ?? {};
    // Mirror the same first-non-service-parent pick the send path uses
    // (sendLumiWeeklyForStudent), so the dry-run accurately previews
    // who would actually receive the email.
    const SERVICE_EMAILS = new Set(["admin@yunateach.com"]);
    const recipient = stu.studentLinks
      .map(l => l.parent.email)
      .find((e): e is string => !!e && !SERVICE_EMAILS.has(e.toLowerCase()))
      ?? null;
    const row: DeltaRow = { studentName: stu.name, studentId: stu.id, deltas: [], recipient };
    for (const subj of DELTA_SUBJECTS) {
      const data = await loadTutorData(stu.id, subj);
      if (data.kind !== "ready" || !data.weeklyDelta) continue;
      const lastSent = sentMap[subj.toLowerCase()] ?? null;
      const elapsed = daysSince(lastSent);
      const cooldownActive = elapsed !== null && elapsed < DELTA_COOLDOWN_DAYS;
      row.deltas.push({ subject: subj, lastSent, cooldownActive });
    }
    if (row.deltas.length > 0) deltaPlan.push(row);
  }
  const deltasReadyToSend = deltaPlan
    .map(r => ({ ...r, deltas: r.deltas.filter(d => !d.cooldownActive) }))
    .filter(r => r.deltas.length > 0);
  const deltasInCooldown = deltaPlan
    .map(r => ({ ...r, deltas: r.deltas.filter(d =>  d.cooldownActive) }))
    .filter(r => r.deltas.length > 0);
  const deltasReadyWithRecipient    = deltasReadyToSend.filter(r => !!r.recipient);
  const deltasReadyMissingRecipient = deltasReadyToSend.filter(r =>  !r.recipient);

  console.log(`  kids with at least one delta surface: ${deltaPlan.length}`);
  console.log(`  → ready to send (out of cooldown, has linked parent): ${deltasReadyWithRecipient.length} kids = ${deltasReadyWithRecipient.length} email${deltasReadyWithRecipient.length === 1 ? "" : "s"}`);
  if (deltasReadyMissingRecipient.length > 0) {
    console.log(`  → ready but no linked-parent email (would skip): ${deltasReadyMissingRecipient.length} kids`);
  }
  console.log(`  → in cooldown (<${DELTA_COOLDOWN_DAYS}d since last weekly): ${deltasInCooldown.length} kids`);

  if (deltasReadyWithRecipient.length > 0) {
    console.log(`\n  ── kids who would get a delta this run ──`);
    for (const r of deltasReadyWithRecipient) {
      const list = r.deltas.map(d => `${d.subject}(last sent ${fmtDateShort(d.lastSent)})`).join(", ");
      console.log(`    ${r.studentName.padEnd(22)} → ${r.deltas.length} subject${r.deltas.length === 1 ? "" : "s"}: ${list}  →  ${r.recipient}`);
    }
  }
  if (deltasReadyMissingRecipient.length > 0) {
    console.log(`\n  ── ready but no linked parent — would be skipped ──`);
    for (const r of deltasReadyMissingRecipient) {
      console.log(`    ${r.studentName.padEnd(22)} : ${r.deltas.map(d => d.subject).join(", ")}`);
    }
  }
  if (deltasInCooldown.length > 0 && DRY) {
    console.log(`\n  ── in cooldown (won't re-send) — sample first 5 ──`);
    for (const r of deltasInCooldown.slice(0, 5)) {
      const list = r.deltas.map(d => `${d.subject}(last ${fmtDateShort(d.lastSent)}, ${daysSince(d.lastSent) ?? "?"}d ago)`).join(", ");
      console.log(`    ${r.studentName.padEnd(22)} : ${list}`);
    }
    if (deltasInCooldown.length > 5) console.log(`    … and ${deltasInCooldown.length - 5} more`);
  }

  if (SEND_DELTAS && !DRY) {
    console.log(`\n  [delta] live send not yet wired — TODO: import sendLumiWeeklyForStudent + mailer log POST, then iterate deltasReadyToSend`);
  }

  console.log(`\n──── done ${new Date().toISOString()} ────`);
  await prisma.$disconnect();
})().catch(async e => {
  console.error("cron crashed:", e);
  await prisma.$disconnect();
  process.exit(1);
});
