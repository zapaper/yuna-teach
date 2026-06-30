// One-off "new feature" email: tells parents we now show personalised
// grammar + synthesis sub-topic radars for their kid, then reuses the
// existing English Lumi delta body so the parent has both the
// announcement AND the latest analysis in one place.
//
// CTA lands on the Lumi view with English pre-selected via the
// `?subject=English` deep link added to ParentDashboard.LumiViewBody.
//
// Usage:
//   npx tsx scripts/_send-grammar-radar-feature-email.ts          # sends
//   npx tsx scripts/_send-grammar-radar-feature-email.ts --dry-run # writes eval/*.html

import "dotenv/config";
import { writeFile } from "fs/promises";
import path from "path";
import sgMail from "@sendgrid/mail";
import { createCanvas } from "@napi-rs/canvas";
import { prisma } from "../src/lib/db";
import { loadTutorData, type TutorData } from "../src/lib/tutor";
import { drawTopicChart } from "./send-progress-emails";
import { renderDelta, STYLES, esc, SUBJECT_LABEL } from "./send-lumi-weekly-emails";

const TO = "peter.lzy@gmail.com";
const BASE_URL = "https://www.markforyou.com";
const FROM = { email: process.env.SENDGRID_FROM_ADDRESS ?? "hello@markforyou.com", name: "MarkForYou Lumi" };

// Same labels as the live radar (api/tutor/[studentId]/grammar-fluency).
// Newlines drive the wrap when rendered to canvas.
const GRAMMAR_SUBTOPICS: Array<{ id: string; label: string }> = [
  { id: "connectors-tenses",       label: "Connectors &\ntenses" },
  { id: "verb-forms",              label: "Verb forms" },
  { id: "idiomatic-prepositions",  label: "Prepositions" },
  { id: "tag-questions",           label: "Tag questions" },
  { id: "countable/uncountable",   label: "Countable /\nuncountable" },
  { id: "subject-verb-agreement",  label: "Subject-verb\nagreement" },
  { id: "pronouns",                label: "Pronouns" },
];
const SYNTHESIS_SUBTOPICS: Array<{ id: string; label: string }> = [
  { id: "reported-speech",         label: "Reported speech" },
  { id: "correlative-preference",  label: "Correlative /\npreference" },
  { id: "subordinator",            label: "Subordinator" },
  { id: "participle-clauses",      label: "Participle clauses" },
  { id: "substitution-inversion",  label: "Substitution /\ninversion" },
  { id: "noun-phrase",             label: "Noun phrase" },
];

type FluencyRow = { id: string; label: string; awarded: number; available: number; pct: number | null };
type FluencyBundle = { subTopics: FluencyRow[]; overall: number | null; totalAwarded: number; totalAvailable: number };

// Mirrors fluencyFor() in src/app/api/tutor/[studentId]/grammar-fluency/route.ts
// — same revision/eval filter, same bucketing. Re-implemented inline so
// the script doesn't need an HTTP roundtrip into the running app.
async function fluencyFor(studentId: string, syllabusTopics: string[], buckets: typeof GRAMMAR_SUBTOPICS): Promise<FluencyBundle> {
  const rows = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        assignedToId: studentId,
        subject: { contains: "english", mode: "insensitive" },
        markingStatus: { in: ["complete", "released"] },
        NOT: { paperType: "eval" },
      },
      syllabusTopic: { in: syllabusTopics },
      marksAwarded: { not: null },
      marksAvailable: { not: null, gt: 0 },
      subTopic: { not: null },
    },
    select: { subTopic: true, marksAwarded: true, marksAvailable: true, examPaper: { select: { metadata: true } } },
  });
  const byId = new Map<string, { awarded: number; available: number }>();
  for (const r of rows) {
    const meta = (r.examPaper.metadata ?? {}) as { revisionMode?: string };
    if (meta.revisionMode) continue;
    if (!r.subTopic) continue;
    const cur = byId.get(r.subTopic) ?? { awarded: 0, available: 0 };
    cur.awarded += r.marksAwarded ?? 0;
    cur.available += r.marksAvailable ?? 0;
    byId.set(r.subTopic, cur);
  }
  const subTopics: FluencyRow[] = buckets.map(s => {
    const cur = byId.get(s.id) ?? { awarded: 0, available: 0 };
    const pct = cur.available > 0 ? Math.round(cur.awarded / cur.available * 100) : null;
    return { id: s.id, label: s.label, awarded: cur.awarded, available: cur.available, pct };
  });
  const totalAwarded = subTopics.reduce((s, x) => s + x.awarded, 0);
  const totalAvailable = subTopics.reduce((s, x) => s + x.available, 0);
  const overall = totalAvailable > 0 ? Math.round(totalAwarded / totalAvailable * 100) : null;
  return { subTopics, overall, totalAwarded, totalAvailable };
}

// Column-chart variant of the fluency view — parents who don't read
// radars at a glance get a familiar bar chart: one bar per sub-topic,
// y-axis 0-100%, green ≥ overall average, yellow < average, dashed red
// avg line. Sub-topic labels rotated below the x-axis (multi-line
// labels are pre-joined since rotation makes wraps awkward). n=attempts
// inside the bar foot, pct on top.
function drawColumnChart(title: string, subtitle: string, subTopics: FluencyRow[], avgPct: number | null): Buffer {
  const W = 1100, H = 760;
  const FONT_TITLE = 38;
  const FONT_SUBTITLE = 24;
  const FONT_AXIS = 22;
  const FONT_BAR_PCT = 30;
  const FONT_N = 18;
  const FONT_XLABEL = 24;
  const FONT_AVG = 22;
  const padL = 80, padR = 40;
  const subtitleBottom = 16 + FONT_TITLE + 10 + FONT_SUBTITLE + 6; // ≈ 100
  const barLabelStackH = FONT_BAR_PCT + 14;
  const padT = subtitleBottom + barLabelStackH + 12;
  // Max label width when rotated -35° — sub-topic labels can be quite
  // long ("Subject-verb agreement" ~ 22 chars). Treat each char as
  // ~13 px at 24 px font, sin(35°) ≈ 0.57 vertical footprint.
  const maxLabelChars = subTopics.reduce((m, s) => Math.max(m, s.label.replace(/\n/g, " ").length), 0);
  const padB = Math.max(140, Math.ceil(maxLabelChars * 13 * 0.57) + 30);
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#DDD6FE"; ctx.lineWidth = 2; ctx.strokeRect(1, 1, W - 2, H - 2);

  // Title + subtitle.
  ctx.fillStyle = "#001E40";
  ctx.font = `bold ${FONT_TITLE}px sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(title, padL, FONT_TITLE + 14);
  ctx.font = `${FONT_SUBTITLE}px sans-serif`;
  ctx.fillStyle = "#43474F";
  ctx.fillText(subtitle, padL, FONT_TITLE + 14 + FONT_SUBTITLE + 6);

  // Y-axis grid + tick labels (0, 25, 50, 75, 100).
  const y = (pct: number) => padT + plotH - (Math.max(0, Math.min(100, pct)) / 100) * plotH;
  ctx.strokeStyle = "#E5E7EB"; ctx.lineWidth = 1;
  ctx.font = `${FONT_AXIS}px sans-serif`;
  ctx.fillStyle = "#737780"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (const t of [0, 25, 50, 75, 100]) {
    const py = y(t);
    ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(padL + plotW, py); ctx.stroke();
    ctx.fillText(`${t}%`, padL - 12, py);
  }
  ctx.textBaseline = "alphabetic";

  // Bars.
  const n = subTopics.length;
  const slot = plotW / n;
  const barW = Math.min(110, slot * 0.65);
  for (let i = 0; i < subTopics.length; i++) {
    const s = subTopics[i];
    const bx = padL + slot * i + (slot - barW) / 2;
    const pct = s.pct ?? 0;
    const by = y(pct);
    const h = (padT + plotH) - by;
    // Colour: green ≥ avg, yellow < avg. Null (no data) renders slate.
    const colour = s.pct === null
      ? "#cbd5e1"
      : (avgPct !== null && s.pct >= avgPct) ? "#10B981" : "#facc15";
    ctx.fillStyle = colour;
    const r = 6;
    ctx.beginPath();
    ctx.moveTo(bx, by + r);
    ctx.quadraticCurveTo(bx, by, bx + r, by);
    ctx.lineTo(bx + barW - r, by);
    ctx.quadraticCurveTo(bx + barW, by, bx + barW, by + r);
    ctx.lineTo(bx + barW, by + h);
    ctx.lineTo(bx, by + h);
    ctx.closePath();
    ctx.fill();
    // % above bar.
    ctx.fillStyle = "#001E40";
    ctx.font = `bold ${FONT_BAR_PCT}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(s.pct === null ? "—" : `${s.pct}%`, bx + barW / 2, by - 10);
    // n=attempts at the foot of the bar (skip when no data so we don't
    // print "n=0" inside a zero-height bar).
    if (s.available > 0) {
      ctx.fillStyle = "#001E40";
      ctx.font = `${FONT_N}px sans-serif`;
      ctx.fillText(`n=${s.available}`, bx + barW / 2, padT + plotH - 8);
    }
    // Rotated x-axis label (join \n labels back to single line for
    // rotation — multi-line tilted text becomes unreadable).
    const label = s.label.replace(/\n/g, " ");
    ctx.save();
    ctx.translate(bx + barW / 2, padT + plotH + 14);
    ctx.rotate(-Math.PI * 35 / 180);
    ctx.fillStyle = "#43474F";
    ctx.font = `600 ${FONT_XLABEL}px sans-serif`;
    ctx.textAlign = "right";
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }

  // Dashed average line.
  if (avgPct !== null) {
    ctx.strokeStyle = "#DC2626"; ctx.lineWidth = 3; ctx.setLineDash([12, 8]);
    ctx.beginPath(); ctx.moveTo(padL, y(avgPct)); ctx.lineTo(padL + plotW, y(avgPct)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#DC2626";
    ctx.font = `bold ${FONT_AVG}px sans-serif`;
    ctx.textAlign = "right";
    ctx.fillText(`avg ${avgPct}%`, padL + plotW - 8, y(avgPct) - 10);
  }

  return canvas.toBuffer("image/png");
}

// Canvas port of the React RadarSvg in src/app/tutor/[parentId]/page.tsx.
// 1100×1200 image — canvas + fonts roughly doubled from the first pass
// so the per-axis pct labels and rule names stay legible at Gmail's
// rescaled width (~360 px). Same colour palette and zone bands
// (green ≥75 / yellow 50-74 / red <50). Bottom strip is a small
// colour-band legend so the chart is self-explanatory.
function drawRadar(title: string, subtitle: string, subTopics: FluencyRow[]): Buffer {
  const W = 1100, H = 1200;
  const TITLE_STRIP = 90;
  const LEGEND_STRIP = 60;
  const CX = W / 2;
  const CY = TITLE_STRIP + (H - TITLE_STRIP - LEGEND_STRIP) / 2;
  const R = 290;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Background.
  ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, W, H);

  // Title strip.
  ctx.fillStyle = "#001E40";
  ctx.font = "bold 38px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(title, CX, 32);
  ctx.font = "24px sans-serif";
  ctx.fillStyle = "#666";
  ctx.fillText(subtitle, CX, 70);

  // Zone bands (green ≥75 / yellow 50-74 / red <50).
  const drawRing = (pctOuter: number, pctInner: number, fill: string) => {
    const ro = (pctOuter / 100) * R;
    const ri = (pctInner / 100) * R;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(CX, CY, ro, 0, Math.PI * 2);
    if (ri > 0) {
      ctx.arc(CX, CY, ri, 0, Math.PI * 2, true);
    }
    ctx.fill("evenodd");
  };
  ctx.globalAlpha = 0.55;
  drawRing(100, 75, "#bbf7d0");
  drawRing(75, 50, "#fde68a");
  ctx.globalAlpha = 0.40;
  drawRing(50, 0, "#fecaca");
  ctx.globalAlpha = 1;

  // Concentric grid circles.
  ctx.strokeStyle = "#cccccc";
  ctx.lineWidth = 1.4;
  for (const p of [20, 40, 60, 80, 100]) {
    ctx.beginPath();
    ctx.arc(CX, CY, (p / 100) * R, 0, Math.PI * 2);
    ctx.stroke();
  }

  const subs = subTopics;
  const angles = subs.map((_, i) => (i / subs.length) * 2 * Math.PI - Math.PI / 2);
  const point = (angle: number, pct: number): [number, number] => {
    const r = (pct / 100) * R;
    return [CX + r * Math.cos(angle), CY + r * Math.sin(angle)];
  };

  // Spokes + axis labels.
  ctx.font = "600 30px sans-serif";
  ctx.fillStyle = "#001E40";
  for (let i = 0; i < subs.length; i++) {
    const a = angles[i];
    const [ax, ay] = point(a, 100);
    ctx.strokeStyle = "#cccccc"; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.moveTo(CX, CY); ctx.lineTo(ax, ay); ctx.stroke();

    const [lx, ly] = point(a, 118);          // label sits outside the polygon
    const lines = subs[i].label.split("\n");
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const lineH = 34;
    const offsetY = -((lines.length - 1) / 2) * lineH;
    for (let j = 0; j < lines.length; j++) {
      ctx.fillText(lines[j], lx, ly + offsetY + j * lineH);
    }
  }

  // Data polygon (uses 0 for null buckets so the polygon stays closed).
  ctx.beginPath();
  for (let i = 0; i < subs.length; i++) {
    const [x, y] = point(angles[i], subs[i].pct ?? 0);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(59, 130, 246, 0.30)";
  ctx.fill();
  ctx.strokeStyle = "#1e40af";
  ctx.lineWidth = 4;
  ctx.stroke();

  // Per-axis dots + pct label.
  for (let i = 0; i < subs.length; i++) {
    const s = subs[i];
    const [x, y] = point(angles[i], s.pct ?? 0);
    const colour = s.pct === null ? "#999" : s.pct >= 75 ? "#16a34a" : s.pct >= 50 ? "#ca8a04" : "#dc2626";
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(x, y, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "white";
    ctx.lineWidth = 3;
    ctx.stroke();
    if (s.pct !== null) {
      ctx.fillStyle = "#001E40";
      ctx.font = "bold 30px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`${s.pct}%`, x, y - 26);
    }
  }

  // Bottom legend strip: three coloured swatches with their pct band.
  // Centred horizontally, sits below the radar — matches the chart's
  // own zone colours so the parent can read accuracy at a glance.
  const legendY = H - LEGEND_STRIP / 2;
  const legendItems = [
    { label: "Strong (≥75%)",  fill: "#bbf7d0", border: "#16a34a" },
    { label: "Mid (50–74%)",   fill: "#fde68a", border: "#ca8a04" },
    { label: "Weak (<50%)",    fill: "#fecaca", border: "#dc2626" },
  ];
  ctx.font = "600 26px sans-serif";
  ctx.textBaseline = "middle";
  // Measure each item (swatch + gap + label) and the gaps between
  // them, then offset so the whole row centres on CX.
  const SWATCH = 28, SWATCH_GAP = 12, ITEM_GAP = 40;
  const widths = legendItems.map(it => SWATCH + SWATCH_GAP + ctx.measureText(it.label).width);
  const totalW = widths.reduce((s, w) => s + w, 0) + ITEM_GAP * (legendItems.length - 1);
  let x = CX - totalW / 2;
  for (let i = 0; i < legendItems.length; i++) {
    const it = legendItems[i];
    ctx.fillStyle = it.fill;
    ctx.fillRect(x, legendY - SWATCH / 2, SWATCH, SWATCH);
    ctx.strokeStyle = it.border;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x, legendY - SWATCH / 2, SWATCH, SWATCH);
    ctx.fillStyle = "#001E40";
    ctx.textAlign = "left";
    ctx.fillText(it.label, x + SWATCH + SWATCH_GAP, legendY);
    x += widths[i] + ITEM_GAP;
  }

  return canvas.toBuffer("image/png");
}

type Kid = { studentId: string; parentId: string; parentFirst: string };
const KIDS: Kid[] = [
  // Mark Lim — parent Papa (peter.lzy@gmail.com)
  { studentId: "cmmbbyvs30004qa9yinn3drl6", parentId: "cmm4tl0f300001ixb254szmg4", parentFirst: "Peter" },
  // David Lim — same parent
  { studentId: "cmm5wf91d000ryrxwaddlo6xh", parentId: "cmm4tl0f300001ixb254szmg4", parentFirst: "Peter" },
];

function safeSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function buildAndSendForKid(kid: Kid, dryRun: boolean): Promise<void> {
  const stu = await prisma.user.findUnique({
    where: { id: kid.studentId },
    select: { id: true, name: true },
  });
  if (!stu) { console.log(`  ! student not found: ${kid.studentId}`); return; }
  const childFirst = stu.name.split(/\s+/)[0] ?? stu.name;

  const [grammar, synthesis, tutor] = await Promise.all([
    fluencyFor(stu.id, ["Grammar MCQ", "Grammar Cloze"], GRAMMAR_SUBTOPICS),
    fluencyFor(stu.id, ["Synthesis / Transformation", "Synthesis & Transformation"], SYNTHESIS_SUBTOPICS),
    loadTutorData(stu.id, "English"),
  ]);

  const ctaUrl = `${BASE_URL}/home/${kid.parentId}?userId=${kid.parentId}&view=lumi&student=${stu.id}&subject=English`;

  // Email visualisation is now two side-by-side HTML tables — rows
  // ≥75% in light green, rows <75% in light yellow, "no data" rows
  // in dim slate. Canvas chart renderers (drawColumnChart / drawRadar)
  // stay in the script for the web toggle, just not used here.
  const fluencyTable = (heading: string, bundle: FluencyBundle): string => {
    const headerCell = (text: string, align: "left" | "right") =>
      `<th style="font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px; color: #475569; padding: 6px 10px; text-align: ${align}; border-bottom: 1px solid #e2e8f0;">${esc(text)}</th>`;
    const sorted = [...bundle.subTopics].sort((a, b) => {
      // Null pcts (no attempts yet) sink to the bottom; the rest go
      // strongest → weakest so the parent's eye lands on the green
      // band first and the yellow gaps cluster underneath.
      if (a.pct === null && b.pct === null) return 0;
      if (a.pct === null) return 1;
      if (b.pct === null) return -1;
      return b.pct - a.pct;
    });
    const rows = sorted.map(s => {
      const noData = s.pct === null;
      const bg = noData ? "#f8fafc" : (s.pct! >= 80 ? "#dcfce7" : "#fef9c3");
      const colour = noData ? "#94a3b8" : "#0f172a";
      const labelText = s.label.replace(/\n/g, " ");
      const pctCell = noData
        ? `<span style="color: #94a3b8;">—</span>`
        : `<strong>${s.pct}%</strong>`;
      const nText = noData
        ? `<span style="color: #94a3b8;">no data</span>`
        : `<span style="color: #64748b; font-size: 11px;">n=${s.available}</span>`;
      return `
        <tr style="background: ${bg};">
          <td style="font-size: 13px; padding: 8px 10px; color: ${colour};">${esc(labelText)}</td>
          <td style="font-size: 13px; padding: 8px 10px; color: ${colour}; text-align: right; white-space: nowrap;">${pctCell}</td>
          <td style="font-size: 12px; padding: 8px 10px; text-align: right; white-space: nowrap;">${nText}</td>
        </tr>`;
    }).join("");
    const overallLine = bundle.totalAvailable > 0
      ? `Overall <strong>${bundle.overall ?? 0}%</strong> (${bundle.totalAwarded}/${bundle.totalAvailable} marks)`
      : `<span style="color: #94a3b8; font-style: italic;">No attempts yet</span>`;
    return `
      <div style="font-size: 15px; font-weight: 800; color: #001e40; margin: 0 0 4px 0;">${esc(heading)}</div>
      <div style="font-size: 12px; color: #475569; margin: 0 0 8px 0;">${overallLine}</div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="width: 100%; border-collapse: collapse; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
        <thead>
          <tr>${headerCell("Sub-topic", "left")}${headerCell("Score", "right")}${headerCell("Attempts", "right")}</tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  };
  const grammarTableHtml   = fluencyTable(`${childFirst}'s Grammar fluency`,   grammar);
  const synthesisTableHtml = fluencyTable(`${childFirst}'s Synthesis fluency`, synthesis);

  // Topic bar chart (re-using the same renderer as the weekly email).
  let chartPng: Buffer | null = null;
  if (tutor.kind === "ready" && tutor.topline.allTopics.length > 0) {
    chartPng = drawTopicChart(tutor.topline.allTopics, tutor.topline.avgPct, SUBJECT_LABEL.English, childFirst);
  }

  // English Lumi delta body — only when the kid has new activity this week.
  // suppressEnglishDetails strips the per-example stem/answer/marker-notes
  // blocks (the biggest body-size hog) so Gmail doesn't clip the email
  // after the tables. Headline cards still render so the parent sees
  // wins / topic progress / new mistakes by name.
  let deltaHtml = "";
  if (tutor.kind === "ready" && tutor.weeklyDelta) {
    deltaHtml = renderDelta(tutor as Extract<TutorData, { kind: "ready" }>, childFirst, "English", ctaUrl, { suppressEnglishDetails: true });
  }

  const chartCid      = `chart-english-${stu.id.slice(-6)}`;

  // Subject deliberately reworded — the previous "Personalised practice
  // targeting ..." string was sent ~10 times in a row to peter.lzy and
  // Gmail bundled every send into a single thread, so the top of each
  // new message rendered with a "..." collapse marker for the earlier
  // copies. Fresh wording → fresh thread → clean read.
  const subject = `${childFirst}'s personalised English practice is ready (grammar + synthesis)`;

  // Body layout (post-revision — feature announcement, not weekly update):
  //   1. Opening intro
  //   2. "Child's strengths and weaknesses on grammar and synthesis:"
  //   3. Grammar + Synthesis radar images side-by-side (legend baked in)
  //   4. "Lumi has handcrafted two personalised quizzes … Click here to assign them."
  //
  // Deliberately drops the weekly delta block + topic bar chart + secondary
  // CTA — this email is a one-off feature announcement, not the recurring
  // weekly update. Single CTA so there's no ambiguity about where to click.
  // Gmail mangles <p style="..."> prose in emails (sees "..." mid-body
  // even when the body is well under the 102 KB clip threshold). Every
  // prose block here uses <div> instead, and the multi-block layout
  // sits inside <table role="presentation"> wrappers — the most
  // reliable email-client primitive for spacing.
  const rawHtml = `<!doctype html>
<html><body style="${STYLES.body}">
  <div style="${STYLES.container}">
    <div style="${STYLES.intro}">Hi ${esc(kid.parentFirst)},</div>
    <div style="${STYLES.intro}"><strong>New on MarkForYou:</strong> personalised practice for ${esc(childFirst)} now drills the exact PSLE grammar rules and synthesis tricks ${esc(childFirst)} keeps losing marks on.</div>

    <div style="${STYLES.intro}">${esc(childFirst)}'s strengths and weaknesses on grammar and synthesis:</div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 14px 0;">
      <tr>
        <td valign="top" style="padding: 6px; width: 50%;">${grammarTableHtml}</td>
        <td valign="top" style="padding: 6px; width: 50%;">${synthesisTableHtml}</td>
      </tr>
    </table>
    <div style="font-size: 12px; color: #64748b; margin: 0 0 4px 0;">
      <span style="display: inline-block; width: 12px; height: 12px; background: #dcfce7; border: 1px solid #86efac; vertical-align: middle; margin-right: 6px;"></span>
      Strong (≥80%)
      <span style="display: inline-block; width: 12px; height: 12px; background: #fef9c3; border: 1px solid #fde047; vertical-align: middle; margin: 0 6px 0 18px;"></span>
      Needs work (&lt;80%)
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 18px 0;">
      <tr>
        <td style="background: #f5f3ff; border: 1px solid #ddd6fe; border-left: 4px solid #7c3aed; border-radius: 10px; padding: 16px 18px;">
          <div style="font-size: 15px; color: #1e293b; line-height: 1.55; margin: 0 0 12px 0;">Lumi has <strong>handcrafted two personalised quizzes</strong> on the sub-topics (above) that ${esc(childFirst)} has been weak on.</div>
          <a href="${ctaUrl}" style="display: inline-block; background: #7c3aed; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 8px; font-weight: 800; font-size: 14px;">Click here to assign them →</a>
        </td>
      </tr>
    </table>

    <h2 style="${STYLES.subjectH}">✍️ ${SUBJECT_LABEL.English} — this week's Lumi update</h2>
    ${deltaHtml || `<div style="${STYLES.intro}">No new English papers since the last snapshot — the tables above still reflect ${esc(childFirst)}'s cumulative fluency, and the next Lumi update will follow as soon as a new paper is marked.</div>`}
    ${chartPng ? `<div style="${STYLES.sectionH} color: #475569;">Progress so far</div><img src="cid:${chartCid}" alt="${esc(childFirst)} — English per-topic accuracy" style="${STYLES.chart}" />` : ""}

    <div style="margin: 24px 0 0 0; color: #001e40; font-size: 14px; line-height: 1.55;">
      Cheering ${esc(childFirst)} on,<br/>
      <strong>Lumi &amp; the MarkForYou team</strong>
    </div>
  </div>
</body></html>`;
  const html = rawHtml
    .split(/\n/).map(l => l.replace(/^\s+/, "")).filter(l => l.length > 0).join("\n");

  const attachments: Array<{ content: string; filename: string; type: string; disposition: string; content_id: string }> = [];
  if (chartPng) {
    attachments.push({ content: chartPng.toString("base64"), filename: `${chartCid}.png`, type: "image/png", disposition: "inline", content_id: chartCid });
  }

  if (dryRun) {
    let previewHtml = html;
    if (chartPng) {
      previewHtml = previewHtml.replace(new RegExp(`cid:${chartCid}`, "g"), `data:image/png;base64,${chartPng.toString("base64")}`);
    }
    const out = path.join(__dirname, "..", "eval", `grammar-feature-email-${safeSlug(stu.name)}.html`);
    await writeFile(out, previewHtml, "utf8");
    console.log(`  wrote preview → ${out}`);
    return;
  }

  const [resp] = await sgMail.send({
    to: TO,
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
  console.log(`  ✓ sent for ${stu.name} → ${TO} status=${resp.statusCode}`);
}

(async () => {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`Grammar/Synthesis feature email — to=${TO} dry=${dryRun}\n`);
  if (!dryRun) {
    if (!process.env.SENDGRID_API_KEY) { console.error("SENDGRID_API_KEY missing"); process.exit(1); }
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  }
  for (const kid of KIDS) {
    console.log(`──── ${kid.studentId} ────`);
    await buildAndSendForKid(kid, dryRun);
  }
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
