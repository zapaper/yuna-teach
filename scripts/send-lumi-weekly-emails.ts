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
import { formatStudentAnswerText } from "../src/lib/format-student-answer";
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
  subjectH:  `font-size: 18px; color: #001e40; font-weight: 800; margin: 32px 0 4px 0; border-bottom: 1px solid #ede9fe; padding-bottom: 8px;`,
  activity:  `font-size: 13px; color: #475569; margin: 0 0 14px 0; font-style: italic;`,
  preface:   `font-size: 14px; color: #1e293b; line-height: 1.55; margin: 0 0 14px 0;`,
  sectionH:  `font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.1px; margin: 18px 0 8px 0;`,
  // Wins: green (stays).
  winCard:   `background: #f0fdf4; border-left: 4px solid #10b981; border-radius: 0 8px 8px 0; padding: 10px 14px; margin: 8px 0;`,
  // Topic progress: light blue (was green — too similar to wins).
  topicCard: `background: #eff6ff; border-left: 4px solid #3b82f6; border-radius: 0 8px 8px 0; padding: 10px 14px; margin: 8px 0;`,
  newCard:   `background: #fff7ed; border-left: 4px solid #fb923c; border-radius: 0 8px 8px 0; padding: 10px 14px; margin: 8px 0;`,
  cardTitle: `font-size: 14px; font-weight: 700; margin: 0 0 4px 0;`,
  cardBody:  `font-size: 13px; color: #1e293b; margin: 4px 0 0 0; line-height: 1.5;`,
  chart:     `width: 100%; max-width: 640px; display: block; border-radius: 12px; border: 1px solid #ddd6fe; margin: 12px 0;`,
  cta:       `display: block; background: #7c3aed; color: #ffffff; text-decoration: none; padding: 14px 24px; border-radius: 12px; font-weight: 800; font-size: 15px; text-align: center; margin: 28px 0 12px 0;`,
};

type ReadyData = Extract<TutorData, { kind: "ready" }>;

// Short, parent-readable mistake summary. The marker's notes alone are
// often useless (MCQ canonical shape is just "Student: (X), Correct:
// (Y)"; OEQ notes can be empty), so this dispatches by source:
//   · MCQ → option text dereference + first sentence of elaboration
//   · OEQ → first sentence of markingNotes if it's substantive
//   · Fallback → student-wrote-X-correct-was-Y
// Returns null when there's genuinely nothing useful to surface (the
// caller drops the example line entirely rather than print "see below").
function summarizeMistake(ex: {
  markingNotes: string | null;
  studentAnswer: string | null;
  correctAnswer: string | null;
  elaboration: string | null;
  isMcq: boolean;
  options: string[];
}): string | null {
  const trim = (s: string) => {
    const first = (s.split(/[.!?]\s/)[0] ?? s).trim();
    return first.length > 180 ? first.slice(0, 177) + "…" : first;
  };
  const optionAt = (raw: string | null): string | null => {
    if (!raw) return null;
    const m = raw.match(/\d+/);
    if (!m) return null;
    const idx = parseInt(m[0], 10) - 1;
    return ex.options[idx] ?? null;
  };

  if (ex.isMcq) {
    const studentOpt = optionAt(ex.studentAnswer);
    const correctOpt = optionAt(ex.correctAnswer);
    if (studentOpt && correctOpt) {
      const pick = `picked “${studentOpt}” instead of “${correctOpt}”`;
      // Tack on a short why if elaboration is available — usually a
      // single-sentence rationale ("Cell B has the most charge because
      // …").
      if (ex.elaboration && ex.elaboration.length > 10) {
        return `${pick} — ${trim(ex.elaboration)}`;
      }
      return pick;
    }
    // MCQ but options didn't transcribe — fall back to elaboration alone.
    if (ex.elaboration) return trim(ex.elaboration);
  }

  // OEQ path — marking notes usually have the real explanation.
  // Canonical MCQ shape can leak here if isMcq was false-negative; drop it.
  const notes = ex.markingNotes ?? "";
  const isCanonicalMcq = /^Student\s*:\s*\(?\d+\)?\s*,\s*Correct\s*:\s*\(?\d+\)?/i.test(notes);
  if (notes && notes.length > 20 && !isCanonicalMcq) return trim(notes);

  // Last-resort: show what student wrote vs the expected answer —
  // BUT only when both look like real words, not raw option numbers.
  // For MCQs without transcribed options the answers are just digits
  // like "3" / "(2)" which read as nonsense in an email. Drop those.
  const looksLikeOptionDigit = (s: string) => /^\s*\(?\s*\d+\s*\)?\s*$/.test(s);
  if (ex.studentAnswer && ex.correctAnswer
      && !looksLikeOptionDigit(ex.studentAnswer)
      && !looksLikeOptionDigit(ex.correctAnswer)) {
    return `wrote “${trim(ex.studentAnswer)}” — answer was “${trim(ex.correctAnswer)}”`;
  }
  return null;
}

// Per-example detail block — only rendered for English where there's
// usually no diagram and the wrong-answer / marker-notes context is
// the whole point. Math + Science have diagrams that don't render
// reliably in email, so we keep those bodies minimal and let the
// Progress page show the visuals.
function renderEnglishDetails(childFirst: string, ex: {
  stem: string;
  studentAnswer: string | null;
  correctAnswer: string | null;
  markingNotes?: string | null;
  isMcq: boolean;
  options: string[];
}, isWin: boolean): string {
  const stemTrim = ex.stem.length > 400 ? ex.stem.slice(0, 397) + "…" : ex.stem;
  // Format JSON-shaped student answers (table cells, multi-line OEQ
  // writing pad) into readable text. Raw {"r1c1":"X","r2c1":"Y"} is
  // not parent-friendly; reuse the same formatter the page report does.
  let answerLine = "";
  if (ex.studentAnswer) {
    if (ex.isMcq && ex.options.length > 0) {
      const m = ex.studentAnswer.match(/\d+/);
      const idx = m ? parseInt(m[0], 10) - 1 : -1;
      const opt = ex.options[idx];
      answerLine = opt ? `<p style="font-size: 12px; color: #4b5563; margin: 4px 0;"><em>${esc(childFirst)} picked:</em> “${esc(opt)}”</p>` : "";
    } else {
      const formatted = formatStudentAnswerText(ex.studentAnswer);
      const trimmed = formatted.length > 400 ? formatted.slice(0, 397) + "…" : formatted;
      answerLine = `<p style="font-size: 12px; color: #4b5563; margin: 4px 0; white-space: pre-wrap;"><em>${esc(childFirst)} wrote:</em> ${esc(trimmed)}</p>`;
    }
  }
  // For wins, the kid's answer IS the correct answer — no point showing
  // the answer key separately. Only render the "Correct:" line for
  // mistakes.
  let correctLine = "";
  if (!isWin && ex.correctAnswer) {
    if (ex.isMcq && ex.options.length > 0) {
      const m = ex.correctAnswer.match(/\d+/);
      const idx = m ? parseInt(m[0], 10) - 1 : -1;
      const opt = ex.options[idx];
      correctLine = opt ? `<p style="font-size: 12px; color: #065f46; margin: 4px 0;"><em>Correct:</em> “${esc(opt)}”</p>` : "";
    } else {
      correctLine = `<p style="font-size: 12px; color: #065f46; margin: 4px 0;"><em>Correct:</em> ${esc(ex.correctAnswer.slice(0, 200))}${ex.correctAnswer.length > 200 ? "…" : ""}</p>`;
    }
  }
  const notesLine = ex.markingNotes
    ? `<p style="font-size: 12px; color: #4b5563; margin: 6px 0 0;"><em>Marker:</em> ${esc(ex.markingNotes.slice(0, 300))}${ex.markingNotes.length > 300 ? "…" : ""}</p>`
    : "";
  return `
    <div style="margin-top: 8px; padding: 8px 10px; background: #ffffff; border: 1px solid rgba(0,0,0,0.05); border-radius: 6px;">
      <p style="font-size: 12px; color: #1f2937; margin: 0; white-space: pre-wrap;"><em>Question:</em> ${esc(stemTrim)}</p>
      ${answerLine}
      ${correctLine}
      ${notesLine}
    </div>
  `;
}

function renderDelta(data: ReadyData, childFirst: string, subject: Subject, ctaUrl: string): string {
  const delta = data.weeklyDelta;
  if (!delta) return ""; // shouldn't happen (caller filters), but safety
  const isEnglish = subject === "English";
  const parts: string[] = [];
  // One-line activity summary so the parent immediately sees the
  // volume of work: "David has done 2 papers (37 questions) this week."
  parts.push(`<p style="${STYLES.activity}">${esc(childFirst)} has done <strong>${delta.papersThisWeek}</strong> paper${delta.papersThisWeek === 1 ? "" : "s"} (<strong>${delta.questionsThisWeek}</strong> question${delta.questionsThisWeek === 1 ? "" : "s"}) this week.</p>`);
  parts.push(`<p style="${STYLES.preface}">${esc(delta.prefaceText)} <a href="${ctaUrl}" style="color: #7c3aed; text-decoration: underline; font-weight: 600;">More details can be found on his Progress page.</a></p>`);

  if (delta.wins.length > 0) {
    parts.push(`<div style="${STYLES.sectionH} color: #065f46;">🎉 Wins this week</div>`);
    parts.push(`<p style="${STYLES.cardBody}">${esc(childFirst)} made progress on ${delta.wins.length} common mistake${delta.wins.length === 1 ? "" : "s"} he used to make. Great job!</p>`);
    for (const w of delta.wins) {
      const ex = w.exampleHit;
      parts.push(`
        <div style="${STYLES.winCard}">
          <div style="${STYLES.cardTitle} color: #065f46;">${esc(w.patternName)}</div>
          <div style="${STYLES.cardBody}">Example: ${esc(childFirst)} answered Q${esc(ex.questionNum)} of ${esc(ex.paperTitle)} correctly (${ex.aw}/${ex.av}).</div>
          ${isEnglish ? renderEnglishDetails(childFirst, ex, true) : ""}
        </div>`);
    }
  }

  if (delta.topicProgress.length > 0) {
    parts.push(`<div style="${STYLES.sectionH} color: #1d4ed8;">📈 Topic progress this week</div>`);
    for (const tp of delta.topicProgress) {
      parts.push(`
        <div style="${STYLES.topicCard}">
          <div style="${STYLES.cardTitle} color: #1d4ed8;">${esc(tp.topic)}</div>
          <div style="${STYLES.cardBody}">${esc(childFirst)} scored <strong>${tp.thisPct}%</strong> this week (${tp.attemptsThisWeek} questions) — up from his prior average of ${tp.prevPct}% (<strong>+${tp.delta}pp</strong> <span style="color: #10b981; font-weight: 800;">▲</span>). Nice work!</div>
        </div>`);
    }
  }

  if (delta.newMistakes.length > 0) {
    parts.push(`<div style="${STYLES.sectionH} color: #9a3412;">Something new to keep an eye on</div>`);
    for (const m of delta.newMistakes) {
      const ex = m.exampleWrong;
      const summary = ex ? summarizeMistake(ex) : null;
      parts.push(`
        <div style="${STYLES.newCard}">
          <div style="${STYLES.cardTitle} color: #9a3412;">${esc(m.patternName)}</div>
          ${m.patternWhat ? `<div style="${STYLES.cardBody}">${esc(m.patternWhat)}</div>` : ""}
          ${ex && summary ? `<div style="${STYLES.cardBody}"><em>Example: ${esc(childFirst)} lost ${ex.av - ex.aw}/${ex.av} marks — ${esc(summary)}</em></div>` : ""}
          ${ex && isEnglish ? renderEnglishDetails(childFirst, ex, false) : ""}
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

  // CTA URL — used both by the bottom button AND inline in the preface
  // line ("More details can be found on his Progress page"). Match the
  // intro email's shape: land on the parent homepage with the Lumi
  // view active. The bare /tutor/<parentId> route renders Lumi without
  // the dashboard shell + has a confusing "Tutor" header.
  const linkedParent = stu.parentLinks[0]?.parent ?? null;
  const ctaParentId = linkedParent?.id ?? stu.id;
  const ctaUrl = `${BASE_URL}/home/${ctaParentId}?userId=${ctaParentId}&view=lumi&student=${stu.id}`;

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
        ${renderDelta(data, childFirst, subj, ctaUrl)}
        <div style="${STYLES.sectionH} color: #475569;">Progress so far</div>
        <img src="cid:${chartCid}" alt="${esc(childFirst)} — ${label} per-topic accuracy" style="${STYLES.chart}" />
      `,
    });
  }
  if (sections.length === 0) return { status: "no-delta" };
  const parentFirst = linkedParent?.name?.split(/\s+/)[0] ?? "there";
  const subject = `Lumi's weekly update on ${childFirst} (${sections.length} subject${sections.length === 1 ? "" : "s"})`;
  // Compose, then squeeze whitespace — Gmail clips messages whose HTML
  // body exceeds ~102 KB ("[Message clipped]" link), and our template
  // literals are riddled with template-string indentation that bloats
  // the byte count for no visual benefit. Trim leading whitespace on
  // every line and collapse multi-newlines so the body stays under
  // the clip threshold.
  const rawHtml = `<!doctype html>
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
  const html = rawHtml
    .split(/\n/)
    .map(l => l.replace(/^\s+/, "")) // strip indentation
    .filter(l => l.length > 0)        // drop blank lines
    .join("\n");

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
