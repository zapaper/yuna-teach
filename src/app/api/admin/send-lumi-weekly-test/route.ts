// Admin-only test send for the weekly Lumi email. Runs server-side on
// Railway (where the SendGrid key + sender domain are properly set up
// — local sends 401 because of IP allowlisting on the key).
//
//   POST /api/admin/send-lumi-weekly-test
//     body: { kids: ["david-lim", "kaiyangnggg"], to: "peter.lzy@gmail.com" }
//
// Reuses the SAME compose logic as scripts/send-lumi-weekly-emails.ts —
// per-subject delta block + progress chart inline as CID attachment +
// CTA at the end. Subjects with 0 new papers since the lastweek
// snapshot are silently skipped.

import { NextRequest, NextResponse } from "next/server";
import sgMail from "@sendgrid/mail";
import { prisma } from "@/lib/db";
import { isSessionAdmin } from "@/lib/session";
import { loadTutorData, type TutorData } from "@/lib/tutor";
import { drawTopicChart } from "../../../../../scripts/send-progress-emails";

const BASE_URL = "https://www.markforyou.com";
const FROM = { email: process.env.SENDGRID_FROM_ADDRESS ?? "hello@markforyou.com", name: "MarkForYou Lumi" };

const SUBJECTS = ["Math", "Science", "English"] as const;
type Subject = (typeof SUBJECTS)[number];
const SUBJECT_LABEL: Record<Subject, string> = { Math: "Mathematics", Science: "Science", English: "English" };
const SUBJECT_EMOJI: Record<Subject, string> = { Math: "🧮", Science: "🔬", English: "✍️" };

function safeSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const STYLES = {
  body:      `font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7fb; padding: 24px;`,
  container: `max-width: 640px; margin: 0 auto; background: #ffffff; border-radius: 16px; padding: 32px; box-shadow: 0 4px 20px rgba(11, 28, 48, 0.06);`,
  intro:     `font-size: 15px; color: #1e293b; line-height: 1.6; margin: 0 0 16px 0;`,
  subjectH:  `font-size: 18px; color: #001e40; font-weight: 800; margin: 32px 0 4px 0; border-bottom: 1px solid #ede9fe; padding-bottom: 8px;`,
  activity:  `font-size: 13px; color: #475569; margin: 0 0 14px 0; font-style: italic;`,
  preface:   `font-size: 14px; color: #1e293b; line-height: 1.55; margin: 0 0 14px 0;`,
  sectionH:  `font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 1.1px; margin: 18px 0 8px 0;`,
  winCard:   `background: #f0fdf4; border-left: 4px solid #10b981; border-radius: 0 8px 8px 0; padding: 10px 14px; margin: 8px 0;`,
  topicCard: `background: #eff6ff; border-left: 4px solid #3b82f6; border-radius: 0 8px 8px 0; padding: 10px 14px; margin: 8px 0;`,
  newCard:   `background: #fff7ed; border-left: 4px solid #fb923c; border-radius: 0 8px 8px 0; padding: 10px 14px; margin: 8px 0;`,
  cardTitle: `font-size: 14px; font-weight: 700; margin: 0 0 4px 0;`,
  cardBody:  `font-size: 13px; color: #1e293b; margin: 4px 0 0 0; line-height: 1.5;`,
  chart:     `width: 100%; max-width: 640px; display: block; border-radius: 12px; border: 1px solid #ddd6fe; margin: 12px 0;`,
  cta:       `display: block; background: #7c3aed; color: #ffffff; text-decoration: none; padding: 14px 24px; border-radius: 12px; font-weight: 800; font-size: 15px; text-align: center; margin: 28px 0 12px 0;`,
};

type ReadyData = Extract<TutorData, { kind: "ready" }>;

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
      if (ex.elaboration && ex.elaboration.length > 10) return `${pick} — ${trim(ex.elaboration)}`;
      return pick;
    }
    if (ex.elaboration) return trim(ex.elaboration);
  }
  const notes = ex.markingNotes ?? "";
  const isCanonicalMcq = /^Student\s*:\s*\(?\d+\)?\s*,\s*Correct\s*:\s*\(?\d+\)?/i.test(notes);
  if (notes && notes.length > 20 && !isCanonicalMcq) return trim(notes);
  // Drop the wrote-vs-answer fallback when both are just option
  // digits — MCQs without transcribed options leave us with "3" /
  // "(2)" which reads as nonsense in an email.
  const looksLikeOptionDigit = (s: string) => /^\s*\(?\s*\d+\s*\)?\s*$/.test(s);
  if (ex.studentAnswer && ex.correctAnswer
      && !looksLikeOptionDigit(ex.studentAnswer)
      && !looksLikeOptionDigit(ex.correctAnswer)) {
    return `wrote “${trim(ex.studentAnswer)}” — answer was “${trim(ex.correctAnswer)}”`;
  }
  return null;
}

function renderDelta(data: ReadyData, childFirst: string): string {
  const delta = data.weeklyDelta;
  if (!delta) return "";
  const parts: string[] = [];
  parts.push(`<p style="${STYLES.activity}">${esc(childFirst)} has done <strong>${delta.papersThisWeek}</strong> paper${delta.papersThisWeek === 1 ? "" : "s"} (<strong>${delta.questionsThisWeek}</strong> question${delta.questionsThisWeek === 1 ? "" : "s"}) this week.</p>`);
  parts.push(`<p style="${STYLES.preface}">${esc(delta.prefaceText)}</p>`);
  if (delta.wins.length > 0) {
    parts.push(`<div style="${STYLES.sectionH} color: #065f46;">🎉 Wins this week</div>`);
    parts.push(`<p style="${STYLES.cardBody}">${esc(childFirst)} made progress on ${delta.wins.length} common mistake${delta.wins.length === 1 ? "" : "s"} he used to make. Great job!</p>`);
    for (const w of delta.wins) {
      const ex = w.exampleHit;
      parts.push(`<div style="${STYLES.winCard}">
        <div style="${STYLES.cardTitle} color: #065f46;">${esc(w.patternName)}</div>
        <div style="${STYLES.cardBody}">Example: ${esc(childFirst)} answered Q${esc(ex.questionNum)} of ${esc(ex.paperTitle)} correctly (${ex.aw}/${ex.av}).</div>
      </div>`);
    }
  }
  if (delta.topicProgress.length > 0) {
    parts.push(`<div style="${STYLES.sectionH} color: #1d4ed8;">📈 Topic progress this week</div>`);
    for (const tp of delta.topicProgress) {
      parts.push(`<div style="${STYLES.topicCard}">
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
      parts.push(`<div style="${STYLES.newCard}">
        <div style="${STYLES.cardTitle} color: #9a3412;">${esc(m.patternName)}</div>
        ${m.patternWhat ? `<div style="${STYLES.cardBody}">${esc(m.patternWhat)}</div>` : ""}
        ${ex && summary ? `<div style="${STYLES.cardBody}"><em>Example: ${esc(childFirst)} lost ${ex.av - ex.aw}/${ex.av} marks — ${esc(summary)}</em></div>` : ""}
      </div>`);
    }
  }
  return parts.join("\n");
}

export async function POST(req: NextRequest) {
  if (!(await isSessionAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => ({})) as { kids?: string[]; to?: string };
  const kidSlugs = (body.kids ?? []).map(s => s.toLowerCase().trim()).filter(Boolean);
  const to = body.to?.trim();
  if (kidSlugs.length === 0) return NextResponse.json({ error: "kids[] required" }, { status: 400 });
  if (!to) return NextResponse.json({ error: "to required" }, { status: 400 });
  if (!process.env.SENDGRID_API_KEY) return NextResponse.json({ error: "SENDGRID_API_KEY not set" }, { status: 500 });
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  const students = await prisma.user.findMany({
    where: { role: "STUDENT" },
    select: { id: true, name: true, parentLinks: { select: { parent: { select: { id: true, name: true, email: true } } } } },
  });
  const bySlug = new Map(students.map(s => [safeSlug(s.name), s] as const));

  const results: Array<{ slug: string; status: string; subjects: string[]; recipient?: string; error?: string }> = [];

  for (const slug of kidSlugs) {
    const stu = bySlug.get(slug);
    if (!stu) { results.push({ slug, status: "skip", subjects: [], error: "not found" }); continue; }
    const childFirst = stu.name.split(/\s+/)[0] ?? stu.name;

    const sections: Array<{ subject: Subject; chartBuf: Buffer; chartCid: string; html: string }> = [];
    for (const subj of SUBJECTS) {
      const data = await loadTutorData(stu.id, subj);
      if (data.kind !== "ready" || !data.weeklyDelta) continue;
      const label = SUBJECT_LABEL[subj];
      // drawTopicChart only reads topic/pct/attempts from each row, but
      // the type wants awarded/available too — pad with zeros so the
      // shape lines up without re-querying.
      const topicsForChart = data.topline.allTopics.map(t => ({ ...t, awarded: 0, available: 0 }));
      const chartBuf = drawTopicChart(topicsForChart, data.topline.avgPct, label, childFirst);
      const chartCid = `chart-${stu.id.slice(-6)}-${subj.toLowerCase()}`;
      const sectionHtml = `
        <h2 style="${STYLES.subjectH}">${SUBJECT_EMOJI[subj]} ${label}</h2>
        ${renderDelta(data, childFirst)}
        <div style="${STYLES.sectionH} color: #475569;">Progress so far</div>
        <img src="cid:${chartCid}" alt="${esc(childFirst)} — ${label} per-topic accuracy" style="${STYLES.chart}" />
      `;
      sections.push({ subject: subj, chartBuf, chartCid, html: sectionHtml });
    }
    if (sections.length === 0) {
      results.push({ slug, status: "no-delta", subjects: [] });
      continue;
    }

    const linkedParent = stu.parentLinks[0]?.parent ?? null;
    const ctaParentId = linkedParent?.id ?? stu.id;
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
    const attachments = sections.map(s => ({
      content: s.chartBuf.toString("base64"),
      filename: `${s.chartCid}.png`,
      type: "image/png",
      disposition: "inline",
      content_id: s.chartCid,
    }));
    try {
      const [resp] = await sgMail.send({
        to, from: FROM, subject, html, attachments,
        trackingSettings: {
          clickTracking: { enable: false, enableText: false },
          openTracking: { enable: false },
          subscriptionTracking: { enable: false },
        },
      });
      results.push({ slug, status: "sent", subjects: sections.map(s => s.subject), recipient: to });
      console.log(`[lumi-weekly-test] sent ${slug} → ${to} status=${resp.statusCode}`);
    } catch (err) {
      const e = err as { code?: number; message?: string };
      results.push({ slug, status: "fail", subjects: sections.map(s => s.subject), error: `${e.code ?? "?"}: ${e.message ?? "(no msg)"}` });
    }
  }

  return NextResponse.json({ results });
}
