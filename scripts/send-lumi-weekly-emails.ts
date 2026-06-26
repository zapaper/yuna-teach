// Weekly Lumi email — per-subject delta + progress chart, with subjects
// where the kid has no new papers since the lastweek snapshot omitted
// entirely. Ends with a CTA back to the parent's Lumi homepage.
//
// One email per kid (subjects bundled), sent to a chosen recipient
// (default: each kid's linked parents). Use --to=<email> to override
// recipients for testing.
//
// Usage:
//   # Send the David Lim + Kaiyangnggg weekly emails to peter.lzy@gmail.com:
//   npx tsx scripts/send-lumi-weekly-emails.ts \
//     --kids=david-lim,kaiyangnggg \
//     --to=peter.lzy@gmail.com
//
//   # Dry-run (renders HTML to eval/lumi-weekly-<kid>.html, no send):
//   npx tsx scripts/send-lumi-weekly-emails.ts --kids=... --dry-run

import "dotenv/config";
import { writeFile } from "fs/promises";
import path from "path";
import sgMail from "@sendgrid/mail";
import { prisma } from "../src/lib/db";
import { loadTutorData, type TutorData } from "../src/lib/tutor";
import { tryOrQueue } from "../src/lib/mail-queue";
import { drawTopicChart } from "./send-progress-emails";

const BASE_URL = "https://www.markforyou.com";
const FROM = { email: process.env.SENDGRID_FROM_ADDRESS ?? "hello@markforyou.com", name: "MarkForYou Lumi" };

function parseArgs() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const kidsArg = args.find(a => a.startsWith("--kids="))?.split("=")[1];
  const toArg   = args.find(a => a.startsWith("--to="))?.split("=")[1];
  const kids = kidsArg ? kidsArg.split(",").map(s => s.trim().toLowerCase()).filter(Boolean) : ["david-lim", "kaiyangnggg"];
  return { dryRun, kids, toOverride: toArg ?? null };
}

function safeSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Subject key passed to loadTutorData (must be one of these short
// names — subjectWhere() matches them exactly to derive the SQL
// `contains` predicate). Display labels are separate (LABEL).
const SUBJECTS = ["Math", "Science", "English"] as const;
type Subject = (typeof SUBJECTS)[number];
const SUBJECT_LABEL: Record<Subject, string> = { Math: "Mathematics", Science: "Science", English: "English" };
const SUBJECT_EMOJI: Record<Subject, string> = { Math: "🧮", Science: "🔬", English: "✍️" };

const STYLES = {
  body:      `font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7fb; padding: 24px;`,
  container: `max-width: 640px; margin: 0 auto; background: #ffffff; border-radius: 16px; padding: 32px; box-shadow: 0 4px 20px rgba(11, 28, 48, 0.06);`,
  intro:     `font-size: 15px; color: #1e293b; line-height: 1.6; margin: 0 0 16px 0;`,
  subjectH:  `font-size: 18px; color: #001e40; font-weight: 800; margin: 32px 0 8px 0; border-bottom: 1px solid #ede9fe; padding-bottom: 8px;`,
  preface:   `font-size: 14px; color: #1e293b; line-height: 1.55; margin: 0 0 14px 0;`,
  sectionH:  `font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.1px; margin: 18px 0 8px 0;`,
  winCard:   `background: #f0fdf4; border-left: 4px solid #10b981; border-radius: 0 8px 8px 0; padding: 10px 14px; margin: 8px 0;`,
  topicCard: `background: #ecfdf5; border-left: 4px solid #10b981; border-radius: 0 8px 8px 0; padding: 10px 14px; margin: 8px 0;`,
  newCard:   `background: #fff7ed; border-left: 4px solid #fb923c; border-radius: 0 8px 8px 0; padding: 10px 14px; margin: 8px 0;`,
  cardTitle: `font-size: 14px; font-weight: 700; margin: 0 0 4px 0;`,
  cardBody:  `font-size: 13px; color: #1e293b; margin: 4px 0 0 0; line-height: 1.5;`,
  chart:     `width: 100%; max-width: 640px; display: block; border-radius: 12px; border: 1px solid #ddd6fe; margin: 12px 0;`,
  cta:       `display: block; background: #7c3aed; color: #ffffff; text-decoration: none; padding: 14px 24px; border-radius: 12px; font-weight: 800; font-size: 15px; text-align: center; margin: 28px 0 12px 0;`,
};

type ReadyData = Extract<TutorData, { kind: "ready" }>;

function renderDelta(data: ReadyData, childFirst: string): string {
  const delta = data.weeklyDelta;
  if (!delta) return ""; // shouldn't happen (caller filters), but safety
  const parts: string[] = [];
  parts.push(`<p style="${STYLES.preface}">${esc(delta.prefaceText)}</p>`);

  if (delta.wins.length > 0) {
    parts.push(`<div style="${STYLES.sectionH} color: #065f46;">🎉 Wins this week</div>`);
    parts.push(`<p style="${STYLES.cardBody}">${esc(childFirst)} made progress on ${delta.wins.length} common mistake${delta.wins.length === 1 ? "" : "s"} he used to make. Great job!</p>`);
    for (const w of delta.wins) {
      const ex = w.exampleHit;
      parts.push(`
        <div style="${STYLES.winCard}">
          <div style="${STYLES.cardTitle} color: #065f46;">${esc(w.patternName)}</div>
          <div style="${STYLES.cardBody}">Example: ${esc(childFirst)} answered Q${esc(ex.questionNum)} of ${esc(ex.paperTitle)} correctly (${ex.aw}/${ex.av}).</div>
        </div>`);
    }
  }

  if (delta.topicProgress.length > 0) {
    parts.push(`<div style="${STYLES.sectionH} color: #047857;">📈 Topic progress this week</div>`);
    for (const tp of delta.topicProgress) {
      parts.push(`
        <div style="${STYLES.topicCard}">
          <div style="${STYLES.cardTitle} color: #047857;">${esc(tp.topic)}</div>
          <div style="${STYLES.cardBody}">${esc(childFirst)} scored <strong>${tp.thisPct}%</strong> this week (${tp.attemptsThisWeek} questions) — up from his prior average of ${tp.prevPct}% (<strong>+${tp.delta}pp</strong>). Nice work!</div>
        </div>`);
    }
  }

  if (delta.newMistakes.length > 0) {
    parts.push(`<div style="${STYLES.sectionH} color: #9a3412;">Something new to keep an eye on</div>`);
    for (const m of delta.newMistakes) {
      const ex = m.exampleWrong;
      parts.push(`
        <div style="${STYLES.newCard}">
          <div style="${STYLES.cardTitle} color: #9a3412;">${esc(m.patternName)}</div>
          ${m.patternWhat ? `<div style="${STYLES.cardBody}">${esc(m.patternWhat)}</div>` : ""}
          ${ex ? `<div style="${STYLES.cardBody}"><em>Example: ${esc(childFirst)} lost ${ex.av - ex.aw}/${ex.av} marks on Q${esc(ex.questionNum)} of ${esc(ex.paperTitle)}.</em></div>` : ""}
        </div>`);
    }
  }
  return parts.join("\n");
}

// Per-kid send. Exported so the replay sweeper can re-render and send a
// queued lumi_weekly row by ID. Caller is responsible for ensuring
// sgMail.setApiKey() has been called. Returns:
//   "sent"   — delivered (or queued by tryOrQueue when transport is down)
//   "no-delta" — no subject had a weeklyDelta this week (intentional skip)
//   "no-recipient" — kid has no linked parent email AND no override was passed
export async function sendLumiWeeklyForStudent(args: {
  studentId: string;
  toOverride?: string | null;
  /** When true, writes preview HTML to eval/ and skips transport. */
  dryRun?: boolean;
}): Promise<{ status: "sent" | "queued" | "no-delta" | "no-recipient"; queueId?: string; subjects?: Subject[]; reason?: string }> {
  const stu = await prisma.user.findUnique({
    where: { id: args.studentId },
    select: { id: true, name: true, parentLinks: { select: { parent: { select: { id: true, name: true, email: true } } } } },
  });
  if (!stu) return { status: "no-recipient", reason: "student not found" };
  const childFirst = stu.name.split(/\s+/)[0] ?? stu.name;

  const sections: Array<{ subject: Subject; chartBuf: Buffer; chartCid: string; html: string }> = [];
  for (const subj of SUBJECTS) {
    const data = await loadTutorData(stu.id, subj);
    if (data.kind !== "ready" || !data.weeklyDelta) continue;
    const label = SUBJECT_LABEL[subj];
    const chartBuf = drawTopicChart(data.topline.allTopics, data.topline.avgPct, label, childFirst);
    const chartCid = `chart-${stu.id.slice(-6)}-${subj.toLowerCase()}`;
    sections.push({
      subject: subj,
      chartBuf,
      chartCid,
      html: `
        <h2 style="${STYLES.subjectH}">${SUBJECT_EMOJI[subj]} ${label}</h2>
        ${renderDelta(data, childFirst)}
        <div style="${STYLES.sectionH} color: #475569;">Progress so far</div>
        <img src="cid:${chartCid}" alt="${esc(childFirst)} — ${label} per-topic accuracy" style="${STYLES.chart}" />
      `,
    });
  }
  if (sections.length === 0) return { status: "no-delta" };

  const linkedParent = stu.parentLinks[0]?.parent ?? null;
  const ctaParentId = linkedParent?.id ?? stu.id;
  // Match the intro email's CTA: land on the parent homepage with the
  // Lumi view active. The bare /tutor/<parentId> route renders Lumi
  // without the dashboard shell + has a confusing "Tutor" header.
  const ctaUrl = `${BASE_URL}/home/${ctaParentId}?userId=${ctaParentId}&view=lumi&student=${stu.id}`;
  const parentFirst = linkedParent?.name?.split(/\s+/)[0] ?? "there";
  const subject = `Lumi's weekly update on ${childFirst} (${sections.length} subject${sections.length === 1 ? "" : "s"})`;
  const html = `<!doctype html>
<html><body style="${STYLES.body}">
  <div style="${STYLES.container}">
    <p style="${STYLES.intro}">Hi ${esc(parentFirst)},</p>
    <p style="${STYLES.intro}">Here's Lumi's update on ${esc(childFirst)} for this week — wins, topic progress, and anything new worth keeping an eye on.</p>
    ${sections.map(s => s.html).join("\n")}
    <a href="${ctaUrl}" style="${STYLES.cta}">See Lumi's full report on ${esc(childFirst)} →</a>
    <p style="margin: 20px 0 0 0; color: #001e40; font-size: 14px; line-height: 1.55;">
      Cheering ${esc(childFirst)} on,<br/>
      <strong>Lumi &amp; the MarkForYou team</strong>
    </p>
  </div>
</body></html>`;

  if (args.dryRun) {
    let previewHtml = html;
    for (const s of sections) {
      const dataUri = `data:image/png;base64,${s.chartBuf.toString("base64")}`;
      previewHtml = previewHtml.replace(new RegExp(`cid:${s.chartCid}`, "g"), dataUri);
    }
    const out = path.join(__dirname, "..", "eval", `lumi-weekly-email-${safeSlug(stu.name)}.html`);
    await writeFile(out, previewHtml, "utf8");
    return { status: "sent", subjects: sections.map(s => s.subject) };
  }

  const recipient = args.toOverride ?? linkedParent?.email ?? null;
  if (!recipient) return { status: "no-recipient", reason: "no linked parent email + no override" };
  const attachments = sections.map(s => ({
    content: s.chartBuf.toString("base64"),
    filename: `${s.chartCid}.png`,
    type: "image/png",
    disposition: "inline",
    content_id: s.chartCid,
  }));
  const result = await tryOrQueue({
    eventType: "lumi_weekly",
    toEmail: recipient,
    toName: linkedParent?.name ?? null,
    payload: { studentId: stu.id, toOverride: args.toOverride ?? null },
    send: async () => {
      const [resp] = await sgMail.send({
        to: recipient,
        from: FROM,
        subject,
        html,
        attachments,
        trackingSettings: {
          clickTracking: { enable: false, enableText: false },
          openTracking: { enable: false },
          subscriptionTracking: { enable: false },
        },
      });
      console.log(`  ✓ sent to ${recipient} status=${resp.statusCode}`);
    },
  });
  if (result.queued) return { status: "queued", queueId: result.queueId, reason: result.reason, subjects: sections.map(s => s.subject) };
  if (!result.sent)  return { status: "no-recipient", reason: result.reason };
  return { status: "sent", subjects: sections.map(s => s.subject) };
}

// Only run the main loop when executed as the entry point. Importing
// this file from the replay sweeper used to kick off a dry-run for
// all kids as a side effect — guarding lets the export ship without
// the script running itself unexpectedly.
const IS_ENTRY = (process.argv[1] ?? "").replace(/\\/g, "/").endsWith("/scripts/send-lumi-weekly-emails.ts")
  || (process.argv[1] ?? "").replace(/\\/g, "/").endsWith("/scripts/send-lumi-weekly-emails.js");
if (IS_ENTRY) (async () => {
  const { dryRun, kids, toOverride } = parseArgs();
  console.log(`Lumi weekly email — kids=${kids.join(",")} to=${toOverride ?? "(linked parents)"} dry=${dryRun}\n`);

  if (!dryRun) {
    if (!process.env.SENDGRID_API_KEY) { console.error("SENDGRID_API_KEY missing"); process.exit(1); }
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  }

  // Resolve kid slugs → User rows
  const students = await prisma.user.findMany({
    where: { role: "STUDENT" },
    select: { id: true, name: true, parentLinks: { select: { parent: { select: { id: true, name: true, email: true } } } } },
  });
  const bySlug = new Map(students.map(s => [safeSlug(s.name), s] as const));
  const toProcess = kids.map(k => bySlug.get(k)).filter((s): s is NonNullable<typeof s> => !!s);
  if (toProcess.length === 0) { console.error(`No matching students for slugs: ${kids.join(",")}`); process.exit(1); }

  for (const stu of toProcess) {
    console.log(`──── ${stu.name} ────`);
    const result = await sendLumiWeeklyForStudent({
      studentId: stu.id,
      toOverride,
      dryRun,
    });
    if (result.status === "sent")          console.log(`  ${dryRun ? "wrote preview" : "delivered"} (${(result.subjects ?? []).join(", ")})`);
    else if (result.status === "queued")   console.log(`  queued for replay (${result.queueId}) — ${result.reason}`);
    else if (result.status === "no-delta") console.log(`  no subjects with new activity this week — skip`);
    else                                   console.log(`  ${result.reason}`);
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
