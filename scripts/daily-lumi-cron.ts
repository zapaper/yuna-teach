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
import sgMail from "@sendgrid/mail";
import { readFileSync } from "fs";
import path from "path";
import { prisma } from "../src/lib/db";
import { loadCandidates, runIntroSend, type Candidate } from "./_do-55-send-intros";
import { loadTutorData } from "../src/lib/tutor";

const ARGS = process.argv.slice(2);
const DRY  = ARGS.includes("--dry-run");
const SEND_DELTAS = ARGS.includes("--send-deltas");

const DELTA_SUBJECTS = ["Math", "Science", "English"] as const;
type DeltaSubject = (typeof DELTA_SUBJECTS)[number];

const DELTA_COOLDOWN_DAYS = 6;

// Day-3 nurture per-tick cap. We run the cron HOURLY (10am-9pm SGT =
// 12 ticks/day), and each tick sends at most NURTURE_PER_TICK_CAP
// emails. Default 5 → 60/day max → ~3 days to clear the 187 backlog
// of never-started kids. Trickle pattern keeps us out of Gmail's
// Promotions tab. Override via env var to tune up or down.
// (override via NURTURE_PER_TICK_CAP env var if you want to bump it for catchup)
const NURTURE_PER_TICK_CAP = parseInt(process.env.NURTURE_PER_TICK_CAP ?? "5", 10);
const NURTURE_MIN_DAYS = 3;
const NURTURE_FROM = { email: process.env.SENDGRID_FROM_ADDRESS ?? "hello@markforyou.com", name: "MarkForYou" };
const NURTURE_TEAM_REPLY = "jessica@markforyou.com";
const NURTURE_APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://www.markforyou.com";
const NURTURE_SERVICE_EMAILS = new Set(["admin@yunateach.com"]);
const NURTURE_EXCLUDED_NAMES = new Set(["admin", "student555", "student666"]);
const NURTURE_FONT = `-apple-system, BlinkMacSystemFont, "Segoe UI", Calibri, Arial, sans-serif`;
const NURTURE_PER_RECIPIENT_GAP_MS = 6000;

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

  // ============================================================
  //  NURTURE (Day-3+ activation nudge)
  // ============================================================
  // Wired 2026-06-27. Targets: kid signed up ≥3 days ago AND has done
  // 0 papers AND parent has a non-service email AND no prior
  // settings.activationNudgeSent flag. Strict FIFO by createdAt asc so
  // we clear oldest backlog first. Capped at NURTURE_PER_TICK_CAP (60)
  // per tick.
  console.log(`\n[NURTURE]  Day-${NURTURE_MIN_DAYS}+ activation nudge, FIFO oldest first, cap=${NURTURE_PER_TICK_CAP}/tick (hourly cron → ~60/day)`);
  const nurtureCutoff = new Date(Date.now() - NURTURE_MIN_DAYS * 86_400_000);
  const nurtureKids = await prisma.user.findMany({
    where: {
      role: "STUDENT",
      createdAt: { lte: nurtureCutoff },
    },
    select: {
      id: true, name: true, displayName: true, level: true, createdAt: true, settings: true,
      studentLinks: { select: { parent: { select: { id: true, name: true, email: true } } } },
    },
    orderBy: { createdAt: "asc" },
  });
  // Pull the papers count once per kid via a separate group-by query.
  const kidIds = nurtureKids.map(k => k.id);
  const startedPapers = await prisma.examPaper.findMany({
    where: {
      assignedToId: { in: kidIds },
      markingStatus: { in: ["complete", "released"] },
      NOT: { paperType: "eval" },
    },
    select: { assignedToId: true, metadata: true },
  });
  const startedSet = new Set<string>();
  for (const p of startedPapers) {
    const meta = p.metadata as { revisionMode?: string } | null;
    if (meta?.revisionMode) continue;
    if (p.assignedToId) startedSet.add(p.assignedToId);
  }

  type NurtureRow = {
    kidId: string; kidName: string; kidFirst: string; kidLevel: number | null;
    daysOld: number;
    parentId: string; parentName: string; parentEmail: string; parentFirst: string;
  };
  const nurtureEligible: NurtureRow[] = [];
  const nurtureSkip = { excludedName: 0, alreadyStarted: 0, noLinkedParent: 0, noParentEmail: 0, allParentsService: 0, alreadyNudged: 0 };
  for (const k of nurtureKids) {
    if (NURTURE_EXCLUDED_NAMES.has((k.name ?? "").toLowerCase())) { nurtureSkip.excludedName++; continue; }
    if (startedSet.has(k.id)) { nurtureSkip.alreadyStarted++; continue; }
    if (k.studentLinks.length === 0) { nurtureSkip.noLinkedParent++; continue; }
    const withEmail = k.studentLinks.map(l => l.parent).filter(p => p.email);
    if (withEmail.length === 0) { nurtureSkip.noParentEmail++; continue; }
    const nonService = withEmail.find(p => p.email && !NURTURE_SERVICE_EMAILS.has(p.email.toLowerCase()));
    if (!nonService) { nurtureSkip.allParentsService++; continue; }
    const sentFlag = (k.settings as { activationNudgeSent?: string | boolean } | null)?.activationNudgeSent;
    if (sentFlag) { nurtureSkip.alreadyNudged++; continue; }
    const daysOld = Math.floor((Date.now() - (k.createdAt?.getTime() ?? 0)) / 86_400_000);
    const kidName = k.displayName ?? k.name;
    nurtureEligible.push({
      kidId: k.id, kidName, kidFirst: (kidName.split(/\s+/)[0] ?? kidName),
      kidLevel: k.level, daysOld,
      parentId: nonService.id,
      parentName: nonService.name ?? "Parent",
      parentEmail: nonService.email!,
      parentFirst: (nonService.name ?? "Parent").split(/\s+/)[0] ?? "Parent",
    });
  }
  const nurtureBatch = nurtureEligible.slice(0, NURTURE_PER_TICK_CAP);

  console.log(`  total eligible: ${nurtureEligible.length}, batch this tick: ${nurtureBatch.length}`);
  console.log(`  skipped — already-started: ${nurtureSkip.alreadyStarted}, no-linked-parent: ${nurtureSkip.noLinkedParent}, no-parent-email: ${nurtureSkip.noParentEmail}, service-only: ${nurtureSkip.allParentsService}, already-nudged: ${nurtureSkip.alreadyNudged}, excluded-name: ${nurtureSkip.excludedName}`);

  if (nurtureBatch.length > 0) {
    console.log(`\n  ── batch (oldest first) ──`);
    for (const r of nurtureBatch.slice(0, 20)) {
      console.log(`    ${r.kidName.padEnd(28)} P${r.kidLevel ?? "?"}  ${String(r.daysOld).padStart(2)}d ago  → ${r.parentEmail}`);
    }
    if (nurtureBatch.length > 20) console.log(`    … and ${nurtureBatch.length - 20} more`);
  }

  if (!DRY && nurtureBatch.length > 0) {
    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey) {
      console.error(`  [nurture] SENDGRID_API_KEY missing — cannot send`);
    } else {
      sgMail.setApiKey(apiKey);
      // Admin session cookie for the auto-quiz creation. Prod cron
      // reads EVAL_SESSION_COOKIE env var; local runs fall back to
      // eval/cookie.txt.
      const cookie = process.env.EVAL_SESSION_COOKIE ?? (() => {
        try { return readFileSync(path.join(__dirname, "..", "eval", "cookie.txt"), "utf-8").trim(); }
        catch { return null; }
      })();
      if (!cookie) {
        console.error(`  [nurture] no admin cookie (EVAL_SESSION_COOKIE or eval/cookie.txt) — cannot create quizzes`);
      } else {
        console.log(`\n  fanning out nurture emails…`);
        const lastSendAt = new Map<string, number>();
        let sent = 0, failed = 0;
        for (const r of nurtureBatch) {
          try {
            // Step 1: create the 15-question Grammar+Vocab quiz for the kid.
            const res = await fetch(`${NURTURE_APP_URL}/api/daily-quiz`, {
              method: "POST",
              headers: { "Content-Type": "application/json", cookie: `yuna_session=${cookie}` },
              body: JSON.stringify({
                userId: r.parentId,
                studentId: r.kidId,
                quizType: "mcq",
                subject: "english",
                englishSections: ["grammar-mcq", "vocab-mcq"],
                firstQuiz: true,
              }),
            });
            if (!res.ok) {
              console.warn(`  [nurture] daily-quiz API ${res.status} for ${r.kidName}: ${await res.text()}`);
              failed++;
              continue;
            }
            const qr = await res.json() as { paperId?: string; id?: string; examId?: string };
            const paperId = qr.paperId ?? qr.id ?? qr.examId;
            if (!paperId) { console.warn(`  [nurture] no paperId for ${r.kidName}`); failed++; continue; }

            const quizUrl = `${NURTURE_APP_URL}/quiz/${paperId}?userId=${r.kidId}`;
            const childHomepage = `${NURTURE_APP_URL}/home/${r.kidId}`;
            const parentHomepage = `${NURTURE_APP_URL}/home/${r.parentId}`;

            // Step 2: throttle per-recipient
            const key = r.parentEmail.toLowerCase();
            const last = lastSendAt.get(key);
            if (last) {
              const wait = NURTURE_PER_RECIPIENT_GAP_MS - (Date.now() - last);
              if (wait > 0) await new Promise(rr => setTimeout(rr, wait));
            }
            lastSendAt.set(key, Date.now());

            // Step 3: render + send email (matches the test send v8 the user approved)
            const subject = `Quick check-in: Here's a 5mins Grammar + Vocab quiz for ${r.kidFirst}`;
            const html = `<div style="font-family:${NURTURE_FONT};color:#1F2A37;max-width:640px;margin:24px auto;padding:0 16px;line-height:1.55;font-size:16px;background:#FFFFFF;">
<p style="font-family:${NURTURE_FONT};margin:0 0 14px 0;">Hi ${r.parentFirst},</p>
<p style="font-family:${NURTURE_FONT};margin:0 0 14px 0;">Quick check-in from us. We noticed ${r.kidFirst} hasn't done a quiz yet, so we've teed one up to make it easy.</p>
<p style="font-family:${NURTURE_FONT};margin:0 0 14px 0;">We've already assigned a <strong style="font-weight:700;color:#0E1F2A;">short Grammar + Vocab quiz</strong> to ${r.kidFirst} — takes about 5 minutes on the phone/tablet/desktop.</p>
<div style="font-family:${NURTURE_FONT};background:#E5EEFF;border:2px dashed #003366;padding:14px 18px;border-radius:6px;color:#003366;margin:18px 0;font-size:18px;">📌 <b style="font-family:${NURTURE_FONT};font-weight:700;">Start the quiz here:</b> <a href="${quizUrl}" style="font-family:${NURTURE_FONT};color:#003366;font-weight:700;">Open ${r.kidFirst}'s quiz itself</a>.</div>
<p style="font-family:${NURTURE_FONT};margin:0 0 14px 0;">That's all ${r.kidFirst} needs to do today. It will be instantly marked and any mistakes will have explanations on grammar rules etc.</p>
<p style="font-family:${NURTURE_FONT};font-size:15px;color:#4B5563;margin:14px 0;">Prefer a different quiz first? <a href="${parentHomepage}" style="font-family:${NURTURE_FONT};color:#0E6B6B;font-weight:600;">Open your parent dashboard here</a> — you can browse Math, Science, English, Chinese or set a Focused Practice on a specific topic. Once assigned, your child can access the quiz on his <a href="${childHomepage}" style="font-family:${NURTURE_FONT};color:#0E6B6B;font-weight:600;">homepage here</a>. And if anything's blocking you, just hit reply — we'd love to help.</p>
<p style="font-family:${NURTURE_FONT};margin:18px 0 4px 0;">Warmly,</p>
<p style="font-family:${NURTURE_FONT};font-weight:600;margin:0;">Jessica</p>
<p style="font-family:${NURTURE_FONT};color:#6B7280;font-style:italic;font-size:14px;margin:0;">Co-Founder, MarkForYou</p>
</div>`;
            const text = `Hi ${r.parentFirst},\n\nQuick check-in from us. We noticed ${r.kidFirst} hasn't done a quiz yet, so we've teed one up to make it easy.\n\nWe've already assigned a short Grammar + Vocab quiz to ${r.kidFirst} — takes about 5 minutes.\n\n📌 Start the quiz here: ${quizUrl}\n\nPrefer a different quiz first? Open your parent dashboard: ${parentHomepage}. Once assigned, ${r.kidFirst} can access the quiz on his homepage: ${childHomepage}.\n\nWarmly,\nJessica\nCo-Founder, MarkForYou`;

            const [resp] = await sgMail.send({
              to: r.parentEmail,
              from: NURTURE_FROM,
              replyTo: NURTURE_TEAM_REPLY,
              subject, html, text,
              trackingSettings: {
                clickTracking: { enable: false, enableText: false },
                openTracking: { enable: false },
                subscriptionTracking: { enable: false },
              },
            });
            console.log(`  sent to=${r.parentEmail} kid=${r.kidName} status=${resp.statusCode}`);
            sent++;

            // Step 4: mark sent (idempotency flag)
            const current = await prisma.user.findUnique({ where: { id: r.kidId }, select: { settings: true } });
            const settings = (current?.settings as Record<string, unknown> | null) ?? {};
            await prisma.user.update({
              where: { id: r.kidId },
              data: { settings: { ...settings, activationNudgeSent: new Date().toISOString() } },
            });

            // Step 5: external mailer log
            const mailerUrl = process.env.MAILER_URL;
            const mailerToken = process.env.MAILER_LOG_TOKEN ?? process.env.NURTURE_API_TOKEN;
            if (mailerUrl && mailerToken) {
              fetch(`${mailerUrl.replace(/\/$/, "")}/api/events/email-sent`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${mailerToken}` },
                body: JSON.stringify({
                  to: r.parentEmail,
                  to_name: r.parentName,
                  subject,
                  body: html,
                  event_type: "activation_nudge",
                }),
              }).catch(err => console.warn(`  mailer log failed: ${err?.message ?? err}`));
            }
          } catch (err) {
            const e = err as { response?: { statusCode?: number; body?: unknown } } & Error;
            console.error(`  [nurture] FAILED to=${r.parentEmail} kid=${r.kidName} status=${e.response?.statusCode ?? "?"} msg=${e.message}`);
            failed++;
          }
        }
        console.log(`  result: sent=${sent} failed=${failed} backlog-remaining=${Math.max(0, nurtureEligible.length - sent)}`);
      }
    }
  }

  console.log(`\n──── done ${new Date().toISOString()} ────`);
  await prisma.$disconnect();
})().catch(async e => {
  console.error("cron crashed:", e);
  await prisma.$disconnect();
  process.exit(1);
});
