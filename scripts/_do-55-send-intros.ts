// One-time: send the Lumi intro email to every (kid × subject) pair
// that's now eligible. The vetting script (_send-lumi-intro-vet) ran
// for David Lim Science only; this scales it out to all 55. Email
// shape is identical — same chart, same Lumi inline mascot, same
// personalised closing, same trim-safe headings.
//
// Idempotent per (kid × subject): a successful send sets
// settings.lumiIntroSent[subjectKey] on the student row, so re-running
// only mails the pairs that haven't been sent yet. Use --force to
// resend (vetting / debug only).
//
// Recipient fan-out: every linked parent with an email, deduplicated
// by email. admin@yunateach.com is suppressed (service inbox).
//
// Throttle: 6-second per-recipient gap (same as progress emails) so
// Gmail doesn't drop a follow-up message to a parent of multiple kids.
//
// Usage:
//   npx tsx scripts/_do-55-send-intros.ts --dry        (list only)
//   npx tsx scripts/_do-55-send-intros.ts              (real send)
//   npx tsx scripts/_do-55-send-intros.ts --force      (resend already-marked)

import "dotenv/config";
import sgMail from "@sendgrid/mail";
import { readFileSync } from "fs";
import path from "path";
import sharp from "sharp";
import { prisma } from "../src/lib/db";
import { loadTutorData } from "../src/lib/tutor";
import { TUTOR_CACHE } from "../src/lib/tutor-cache";
import { tryOrQueue } from "../src/lib/mail-queue";
import { drawTopicChart } from "./send-progress-emails";

const DRY = process.argv.includes("--dry");
const FORCE = process.argv.includes("--force");
const FROM = { email: process.env.SENDGRID_FROM_ADDRESS ?? "hello@markforyou.com", name: "MarkForYou" };
const BASE_URL = "https://www.markforyou.com";
const SERVICE_EMAILS = new Set(["admin@yunateach.com"]);
const PER_RECIPIENT_GAP_MS = 6000;

const EXCLUDED_NAMES = new Set(["admin", "student555", "student666"]);

// Chinese intentionally excluded: there's no Lumi pathway shipped for
// Chinese yet, so the parent CTA would land on a page without the
// diagnosis view. Math / Science / English only.
function classifySubject(s: string | null | undefined): "Math" | "Science" | "English" | null {
  if (!s) return null;
  const lc = s.toLowerCase();
  if (lc.includes("math")) return "Math";
  if (lc.includes("science")) return "Science";
  if (lc.includes("english")) return "English";
  return null;
}

function safeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
}

function firstName(full: string): string {
  return (full ?? "").trim().split(/\s+/)[0] ?? full;
}

const STYLES = {
  body: `font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7fb; padding: 24px;`,
  container: `max-width: 640px; margin: 0 auto; background: #ffffff; border-radius: 16px; padding: 32px; box-shadow: 0 4px 20px rgba(11, 28, 48, 0.06);`,
  intro: `font-size: 15px; color: #1e293b; line-height: 1.6; margin: 0 0 16px 0;`,
  h1: `font-size: 20px; color: #001e40; margin: 0 0 6px 0;`,
  h2: `font-size: 13px; color: #7c3aed; text-transform: uppercase; letter-spacing: 1.2px; font-weight: 800; margin: 28px 0 12px 0;`,
  topline: `font-size: 14px; color: #43474f; margin: 0 0 18px 0;`,
  card: (accent: string) => `border: 1px solid ${accent === "violet" ? "#ede9fe" : "#fed7aa"}; background: ${accent === "violet" ? "#fbfaff" : "#fffbf5"}; border-radius: 12px; padding: 18px; margin-bottom: 14px;`,
  cardTitle: `font-size: 17px; font-weight: 800; color: #001e40; margin: 0 0 6px 0;`,
  cardMarks: (color: string) => `font-size: 12px; font-weight: 700; color: ${color === "violet" ? "#7c3aed" : "#ea580c"}; margin-bottom: 8px;`,
  cardWhat: `font-size: 14px; color: #1e293b; line-height: 1.6; margin: 0 0 12px 0;`,
  advice: (accent: string) => `background: ${accent === "violet" ? "#ecfdf5" : "#fff7ed"}; border: 1px solid ${accent === "violet" ? "#d1fae5" : "#fed7aa"}; border-radius: 8px; padding: 12px;`,
  adviceTitle: (color: string) => `font-size: 11px; font-weight: 800; color: ${color}; text-transform: uppercase; letter-spacing: 1.1px; margin-bottom: 6px;`,
  adviceText: `font-size: 13px; color: #064e3b; line-height: 1.6;`,
  cta: `display: block; background: #001e40; color: #ffffff; text-decoration: none; padding: 14px 24px; border-radius: 12px; font-weight: 800; font-size: 15px; text-align: center; margin: 28px 0 12px 0;`,
};

function adviceToHtml(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .split("\n")
    .filter(l => l.trim())
    .map(l => l.trim().match(/^[-•]\s+/) ? `<li>${l.replace(/^[-•]\s+/, "")}</li>` : `<p style="margin: 4px 0;">${l}</p>`)
    .reduce<string[]>((acc, line) => {
      if (line.startsWith("<li>")) {
        const last = acc[acc.length - 1];
        if (last && last.startsWith("<ul")) acc[acc.length - 1] = last.replace("</ul>", `${line}</ul>`);
        else acc.push(`<ul style="margin: 4px 0 4px 18px; padding: 0;">${line}</ul>`);
      } else acc.push(line);
      return acc;
    }, [])
    .join("");
}

function patternCard(p: { name: string; what: string; advice: string; marksLost: number }, totalMarks: number, kind: "mistake" | "gap"): string {
  const accent = kind === "mistake" ? "violet" : "orange";
  const pct = totalMarks > 0 ? Math.round((p.marksLost / totalMarks) * 100) : 0;
  const adviceTitleColor = kind === "mistake" ? "#065f46" : "#9a3412";
  const adviceLabel = kind === "mistake" ? "Lumi's Advice" : "Lumi's Explanation";
  return `
    <div style="${STYLES.card(accent)}">
      <div style="${STYLES.cardTitle}">${p.name}</div>
      <div style="${STYLES.cardMarks(accent)}">${p.marksLost} marks lost (${pct}% of subject)</div>
      <div style="${STYLES.cardWhat}">${p.what}</div>
      <div style="${STYLES.advice(accent)}">
        <div style="${STYLES.adviceTitle(adviceTitleColor)}">${adviceLabel}</div>
        <div style="${STYLES.adviceText}">${adviceToHtml(p.advice ?? "")}</div>
      </div>
    </div>`;
}

type Candidate = {
  studentId: string;
  studentName: string;
  childFirst: string;
  subject: "Math" | "Science" | "English";
  subjectKey: string;       // lowercased — settings flag key
  parents: Array<{ id: string; name: string; email: string }>;
  alreadySent: boolean;
};

async function loadCandidates(): Promise<Candidate[]> {
  // Excluded admin / test / settings-admin users.
  const allUsers = await prisma.user.findMany({ select: { id: true, name: true, email: true, settings: true } });
  const excludedIds = new Set<string>();
  for (const u of allUsers) {
    const lc = (u.name ?? "").toLowerCase();
    if (EXCLUDED_NAMES.has(lc) || lc === "admin") { excludedIds.add(u.id); continue; }
    const s = u.settings as { admin?: unknown } | null;
    if (s?.admin === true) excludedIds.add(u.id);
  }
  const userById = new Map(allUsers.map(u => [u.id, u]));

  // Parent links.
  const parentLinks = await prisma.parentStudent.findMany({ select: { parentId: true, studentId: true } });
  const parentsOfKid = new Map<string, string[]>();
  for (const l of parentLinks) {
    if (!parentsOfKid.has(l.studentId)) parentsOfKid.set(l.studentId, []);
    parentsOfKid.get(l.studentId)!.push(l.parentId);
  }

  // Eligibility scan — mirrors _lumi-eligibility-scan exactly:
  //   ≥ 3 non-revision completed/released papers
  //   ≥ 15 analysable wrong records (MCQ marker-shape or OEQ with ≥10-char markingNotes)
  //   parent has email
  const papers = await prisma.examPaper.findMany({
    where: { markingStatus: { in: ["complete", "released"] }, assignedToId: { not: null } },
    select: { assignedToId: true, subject: true, metadata: true,
      questions: { select: { marksAwarded: true, marksAvailable: true, studentAnswer: true, markingNotes: true, transcribedOptions: true } } },
  });

  type Acc = { papers: number; wrongs: number };
  const byKey = new Map<string, Acc>();
  for (const p of papers) {
    if (!p.assignedToId || excludedIds.has(p.assignedToId)) continue;
    const subj = classifySubject(p.subject);
    if (!subj) continue;
    const meta = p.metadata as { revisionMode?: string } | null;
    if (meta?.revisionMode) continue;
    const key = `${p.assignedToId}::${subj}`;
    const acc = byKey.get(key) ?? { papers: 0, wrongs: 0 };
    acc.papers++;
    const mcqMarkerRe = /Student\s*:\s*\(?\d+\)?\s*,\s*Correct\s*:\s*\(?\d+\)?/i;
    for (const q of p.questions) {
      const av = q.marksAvailable ?? 0, aw = q.marksAwarded ?? 0;
      if (av === 0 || aw >= av) continue;
      if (q.studentAnswer === "__SKIPPED__") continue;
      const opts = q.transcribedOptions as unknown;
      const optsArr: string[] = Array.isArray(opts) ? (opts as unknown[]).filter(Boolean).map(o => typeof o === "string" ? o : "") : [];
      const isMcq = optsArr.length >= 2 || mcqMarkerRe.test(q.markingNotes ?? "");
      if (!isMcq && (!q.markingNotes || q.markingNotes.trim().length < 10)) continue;
      acc.wrongs++;
    }
    byKey.set(key, acc);
  }

  const out: Candidate[] = [];
  for (const [key, acc] of byKey) {
    if (acc.papers < 3 || acc.wrongs < 15) continue;
    const [studentId, subject] = key.split("::") as [string, Candidate["subject"]];
    const student = userById.get(studentId);
    if (!student) continue;
    const parents = (parentsOfKid.get(studentId) ?? [])
      .map(pid => userById.get(pid))
      .filter((u): u is NonNullable<typeof u> => !!u && !!u.email);
    // Service-email suppression + dedup by lowercased email.
    const seen = new Set<string>();
    const filtered: Array<{ id: string; name: string; email: string }> = [];
    for (const p of parents) {
      const e = p.email!.toLowerCase();
      if (SERVICE_EMAILS.has(e)) continue;
      if (seen.has(e)) continue;
      seen.add(e);
      filtered.push({ id: p.id, name: p.name, email: p.email! });
    }
    if (filtered.length === 0) continue;
    const cacheKey = `${safeName(student.name ?? "")}:${subject.toLowerCase()}`;
    if (!TUTOR_CACHE[cacheKey]) continue; // cache must be bundled (so the parent's CTA lands on a real report)
    const sentMap = (student.settings as { lumiIntroSent?: Record<string, string> } | null)?.lumiIntroSent ?? {};
    const alreadySent = !!sentMap[subject.toLowerCase()];
    out.push({
      studentId,
      studentName: student.name ?? "?",
      childFirst: firstName(student.name ?? "?"),
      subject,
      subjectKey: subject.toLowerCase(),
      parents: filtered,
      alreadySent,
    });
  }
  // Sort by subject, then by parent count desc, then by name — stable
  // listing for the dry-run preview.
  out.sort((a, b) =>
    a.subject.localeCompare(b.subject) ||
    b.parents.length - a.parents.length ||
    a.studentName.localeCompare(b.studentName)
  );
  return out;
}

async function buildEmail(c: Candidate, parent: { id: string; name: string; email: string }): Promise<{
  subject: string; html: string; text: string;
  attachments: Array<{ content: string; filename: string; type: string; disposition: string; content_id: string }>;
}> {
  const data = await loadTutorData(c.studentId, c.subject);
  if (data.kind !== "ready") {
    throw new Error(`Tutor data not ready for ${c.studentName} ${c.subject}: ${data.kind}`);
  }
  const totalMarks = data.topline.totalAvailable;
  const childFirst = data.childFirst ?? c.childFirst;
  // CTA URL bootstraps the RECEIVING parent's session — earlier draft
  // hard-coded parents[0], which meant the second linked parent's CTA
  // logged them in as the first. ?student= still scopes to the correct
  // kid either way, but the dashboard chrome was wrong.
  const PARENT_LUMI_URL = `${BASE_URL}/home/${parent.id}?userId=${parent.id}&view=lumi&student=${c.studentId}`;

  const safeStu = (childFirst + "-" + c.studentId.slice(-6)).toLowerCase().replace(/[^a-z0-9-]/g, "");
  const chartPng = drawTopicChart(data.topline.allTopics, data.topline.avgPct, c.subject, childFirst);
  const chartCid = `chart-${safeStu}`;

  const lumiPngFull = readFileSync(path.join(process.cwd(), "public", "avatars", "lumi1.png"));
  const lumiPng = await sharp(lumiPngFull).resize({ height: 44 }).png().toBuffer();
  const lumiCid = `lumi-icon`;
  const lumiImg = `<img src="cid:${lumiCid}" alt="Lumi" width="22" style="height:22px;width:auto;vertical-align:middle;display:inline-block;margin:0 2px;" />`;

  const subject = `Lumi has your first read on ${childFirst}'s ${c.subject}`;
  const parentFirst = firstName(parent.name);
  const html = `<!doctype html>
<html>
<body style="${STYLES.body}">
  <div style="${STYLES.container}">
    <p style="${STYLES.intro}">Hi ${parentFirst},</p>
    <p style="${STYLES.intro}">Lumi ${lumiImg} — our owl assistant — has finished her first read of <strong>${childFirst}'s ${c.subject}</strong> work.</p>
    <p style="${STYLES.intro}">She studied all <strong>${data.topline.paperCount} quizzes</strong> ${childFirst} has done, each working step and mistake, and picked up <strong>mistake patterns</strong> and possible <strong>conceptual gaps</strong>. For each pattern, Lumi will pull out up to three concrete examples from ${childFirst}'s work in the <strong>full report</strong>. Lumi will also recommend practices for ${childFirst}.</p>
    <p style="${STYLES.intro}"><strong>Where to find Lumi:</strong> open MarkForYou → tap <strong>"Progress"</strong>. Each week Lumi will provide a short update — what's improved, what's still tricky, and what to work on next. We hope Lumi can be ${childFirst}'s super teaching assistant!</p>

    <h1 style="${STYLES.h1}">How ${childFirst} is doing in ${c.subject}</h1>
    <p style="${STYLES.topline}"><strong>${data.topline.paperCount} papers</strong> · ${childFirst}'s average <strong>${data.topline.avgPct}%</strong></p>

    <div style="${STYLES.h2}">${childFirst}'s Topic Accuracy</div>
    <img src="cid:${chartCid}" alt="${childFirst} — ${c.subject} per-topic accuracy" style="width:100%;max-width:640px;display:block;border-radius:12px;border:1px solid #ddd6fe;" />

    <p style="font-size: 13px; color: #475569; margin: 0 0 16px 0; line-height: 1.55;">Below: the patterns Lumi noticed ${childFirst} repeatedly slips on, and what to coach.</p>

    ${data.commonMistakes.length > 0 ? `<div style="${STYLES.h2}">${childFirst}'s Common Mistakes</div>${data.commonMistakes.map(m => patternCard(m, totalMarks, "mistake")).join("\n")}` : ""}

    ${data.conceptualGaps.length > 0 ? `<div style="${STYLES.h2}">${childFirst}'s Conceptual Gaps</div>${data.conceptualGaps.map(g => patternCard(g, totalMarks, "gap")).join("\n")}` : ""}

    <a href="${PARENT_LUMI_URL}" style="${STYLES.cta}">See Lumi's full report on ${childFirst} →</a>

    <p style="margin: 20px 0 0 0; color: #001e40; font-size: 14px; line-height: 1.55;">
      Cheering ${childFirst} on,<br/>
      <strong>The MarkForYou team</strong>
    </p>
  </div>
</body>
</html>`;

  const text = `Hi ${parentFirst},

Lumi — our owl assistant — has finished her first read of ${childFirst}'s ${c.subject} work.

She studied all ${data.topline.paperCount} quizzes ${childFirst} has done, each working step and mistake, and picked up mistake patterns and possible conceptual gaps. For each pattern, Lumi will pull out up to three concrete examples from ${childFirst}'s work.

Where to find Lumi: open MarkForYou → tap "Progress". Each week Lumi will provide a short update — what's improved, what's still tricky, and what to work on next.

HOW ${childFirst.toUpperCase()} IS DOING IN ${c.subject.toUpperCase()}
${data.topline.paperCount} papers · ${childFirst}'s average ${data.topline.avgPct}%

COMMON MISTAKES
${data.commonMistakes.map(p => `\n${p.name} — ${p.marksLost} marks lost\n${p.what}\nLumi's Advice: ${p.advice}`).join("\n")}

CONCEPTUAL GAPS
${data.conceptualGaps.map(p => `\n${p.name} — ${p.marksLost} marks lost\n${p.what}\nLumi's Explanation: ${p.advice}`).join("\n")}

See Lumi's full report: ${PARENT_LUMI_URL}

Cheering ${childFirst} on,
The MarkForYou team`;

  const attachments = [
    { content: chartPng.toString("base64"), filename: `${safeStu}-chart.png`, type: "image/png", disposition: "inline", content_id: chartCid },
    { content: lumiPng.toString("base64"),  filename: "lumi.png",              type: "image/png", disposition: "inline", content_id: lumiCid  },
  ];
  return { subject, html, text, attachments };
}

async function markSent(studentId: string, subjectKey: string) {
  const student = await prisma.user.findUnique({ where: { id: studentId }, select: { settings: true } });
  const settings = (student?.settings as Record<string, unknown> | null) ?? {};
  const existing = (settings.lumiIntroSent as Record<string, string> | undefined) ?? {};
  if (existing[subjectKey] && !FORCE) return;
  const updated = { ...existing, [subjectKey]: new Date().toISOString() };
  await prisma.user.update({
    where: { id: studentId },
    data: { settings: { ...settings, lumiIntroSent: updated } },
  });
}

// Exported for the replay sweeper. Takes the queued payload IDs
// (studentId + subject + parentId), reconstructs a Candidate, calls
// buildEmail + sgMail.send. Throws on transport failure (the replay
// caller decides whether to keep the row pending or abandon it).
//
// Caller is responsible for sgMail.setApiKey() being set.
export async function sendLumiIntroForReplay(args: {
  studentId: string;
  subject: "Math" | "Science" | "English";
  parentId: string;
}): Promise<void> {
  const student = await prisma.user.findUnique({
    where: { id: args.studentId },
    select: { id: true, name: true, displayName: true },
  });
  const parent = await prisma.user.findUnique({
    where: { id: args.parentId },
    select: { id: true, name: true, email: true },
  });
  if (!student) throw new Error(`student ${args.studentId} not found`);
  if (!parent?.email) throw new Error(`parent ${args.parentId} has no email`);
  const studentName = student.displayName ?? student.name;
  const childFirst = studentName.split(/\s+/)[0] ?? studentName;
  const candidate: Candidate = {
    studentId: student.id,
    studentName,
    childFirst,
    subject: args.subject,
    subjectKey: args.subject.toLowerCase(),
    parents: [{ id: parent.id, name: parent.name, email: parent.email }],
    alreadySent: false,
  };
  const { subject, html, text, attachments } = await buildEmail(candidate, { id: parent.id, name: parent.name, email: parent.email });
  await sgMail.send({
    to: parent.email,
    from: FROM,
    subject, html, text, attachments,
    trackingSettings: {
      clickTracking: { enable: false, enableText: false },
      openTracking: { enable: false },
      subscriptionTracking: { enable: false },
    },
  });
}

(async () => {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey && !DRY) {
    console.error("SENDGRID_API_KEY not set — re-run with --dry, or export the key first.");
    process.exit(1);
  }
  if (apiKey) sgMail.setApiKey(apiKey);

  const candidates = await loadCandidates();
  const toSend = FORCE ? candidates : candidates.filter(c => !c.alreadySent);

  console.log(`\nEligible (kid × subject) pairs: ${candidates.length}`);
  console.log(`To send now:                    ${toSend.length}${FORCE ? "  (--force: resending already-marked)" : "  (skipping already-marked)"}`);
  console.log(`Skipping (already marked):      ${candidates.length - toSend.length}`);

  console.log(`\n========== PLAN ==========`);
  let totalRecipients = 0;
  for (const c of toSend) {
    const tag = c.alreadySent ? "[FORCE]" : "[NEW  ]";
    const emails = c.parents.map(p => p.email).join(", ");
    console.log(`  ${tag} ${c.studentName.padEnd(22)} ${c.subject.padEnd(8)} → ${c.parents.length} parent(s): ${emails}`);
    totalRecipients += c.parents.length;
  }
  console.log(`\nTotal email sends (kid × subject × parent): ${totalRecipients}`);

  if (DRY) {
    console.log("\n--dry: not sending.");
    await prisma.$disconnect();
    return;
  }

  const lastSendAt = new Map<string, number>();
  let sent = 0, failed = 0;
  for (const c of toSend) {
    let anySucceeded = false;
    for (const parent of c.parents) {
      const key = parent.email.toLowerCase();
      const last = lastSendAt.get(key);
      if (last) {
        const wait = PER_RECIPIENT_GAP_MS - (Date.now() - last);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
      }
      lastSendAt.set(key, Date.now());
      try {
        const { subject, html, text, attachments } = await buildEmail(c, parent);
        const result = await tryOrQueue({
          eventType: "lumi_intro",
          toEmail: parent.email,
          toName: parent.name,
          // Replay re-derives the email from (studentId, subject, parentId) —
          // pulls fresh tutor data so the parent sees current patterns.
          payload: { studentId: c.studentId, subject: c.subject, parentId: parent.id },
          send: async () => {
            const [resp] = await sgMail.send({
              to: parent.email,
              from: FROM,
              subject, html, text, attachments,
              // SendGrid wrapper subdomain (url6296.markforyou.com) isn't
              // DNS-set; wrapped links 404 — keep tracking off so CTAs
              // land on the real dashboard URL.
              trackingSettings: {
                clickTracking:   { enable: false, enableText: false },
                openTracking:    { enable: false },
                subscriptionTracking: { enable: false },
              },
            });
            console.log(`  sent to=${parent.email} parent=${parent.name} child=${c.studentName} subject=${c.subject} status=${resp.statusCode} messageId=${resp.headers?.["x-message-id"] ?? "n/a"}`);
          },
        });
        if (result.queued) {
          console.warn(`  queued to=${parent.email} (${result.queueId}) — ${result.reason}`);
          failed++;
          continue;
        }
        if (!result.sent) {
          console.error(`  permanent failure to=${parent.email}: ${result.reason}`);
          failed++;
          continue;
        }
        sent++;
        anySucceeded = true;
        // Report to the markforyou-mailer audit so /users + /daily-emails
        // show this Lumi intro alongside the cron-sent nurture emails.
        // Fire-and-forget — never block the batch on the mailer log.
        const mailerUrl = process.env.MAILER_URL;
        const mailerToken = process.env.MAILER_LOG_TOKEN ?? process.env.NURTURE_API_TOKEN;
        if (mailerUrl && mailerToken) {
          fetch(`${mailerUrl.replace(/\/$/, "")}/api/events/email-sent`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${mailerToken}`,
            },
            body: JSON.stringify({
              to: parent.email,
              to_name: parent.name,
              subject,
              body: html,
              event_type: "lumi_intro_15_mistakes",
            }),
          }).catch((err) => {
            console.warn(`  mailer log failed: ${err?.message ?? err}`);
          });
        }
      } catch (err) {
        const e = err as { response?: { body?: unknown; statusCode?: number } } & Error;
        console.error(`  FAILED to=${parent.email} child=${c.studentName} subject=${c.subject} status=${e.response?.statusCode ?? "?"} msg=${e.message} body=${JSON.stringify(e.response?.body ?? null)}`);
        failed++;
      }
    }
    // Idempotency flag — only mark when at least one parent send
    // succeeded. If a SendGrid quota or auth failure took out every
    // parent for this (kid × subject), leave the flag clear so a
    // retry-run picks it up. Earlier draft marked unconditionally,
    // which silently buried 10 quota-failed Science pairs today.
    if (anySucceeded) {
      await markSent(c.studentId, c.subjectKey);
    }
  }
  console.log(`\nDone. Sent ${sent}, failed ${failed}.`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
