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

// Canvas port of the React RadarSvg in src/app/tutor/[parentId]/page.tsx.
// 800×800 image (was 320×320 in the React component) so the labels stay
// crisp when Gmail rescales the inline attachment. Same colour palette
// and zone bands (green ≥75 / yellow 50-74 / red <50).
function drawRadar(title: string, subtitle: string, subTopics: FluencyRow[]): Buffer {
  const W = 800, H = 820;          // extra 20 px for the title strip on top
  const TITLE_STRIP = 60;
  const CX = W / 2;
  const CY = TITLE_STRIP + (H - TITLE_STRIP) / 2;
  const R = 230;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Background.
  ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, W, H);

  // Title strip.
  ctx.fillStyle = "#001E40";
  ctx.font = "bold 26px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(title, CX, 22);
  ctx.font = "16px sans-serif";
  ctx.fillStyle = "#666";
  ctx.fillText(subtitle, CX, 46);

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
  ctx.font = "600 17px sans-serif";
  ctx.fillStyle = "#001E40";
  for (let i = 0; i < subs.length; i++) {
    const a = angles[i];
    const [ax, ay] = point(a, 100);
    ctx.strokeStyle = "#cccccc"; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(CX, CY); ctx.lineTo(ax, ay); ctx.stroke();

    const [lx, ly] = point(a, 116);          // label sits outside the polygon
    const lines = subs[i].label.split("\n");
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const lineH = 20;
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
  ctx.lineWidth = 3;
  ctx.stroke();

  // Per-axis dots + pct label.
  for (let i = 0; i < subs.length; i++) {
    const s = subs[i];
    const [x, y] = point(angles[i], s.pct ?? 0);
    const colour = s.pct === null ? "#999" : s.pct >= 75 ? "#16a34a" : s.pct >= 50 ? "#ca8a04" : "#dc2626";
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.arc(x, y, 8.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "white";
    ctx.lineWidth = 2.5;
    ctx.stroke();
    if (s.pct !== null) {
      ctx.fillStyle = "#001E40";
      ctx.font = "bold 17px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`${s.pct}%`, x, y - 18);
    }
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

  // Pull both fluency bundles in parallel with the English tutor data.
  const [grammar, synthesis, tutor] = await Promise.all([
    fluencyFor(stu.id, ["Grammar MCQ", "Grammar Cloze"], GRAMMAR_SUBTOPICS),
    fluencyFor(stu.id, ["Synthesis / Transformation", "Synthesis & Transformation"], SYNTHESIS_SUBTOPICS),
    loadTutorData(stu.id, "English"),
  ]);

  const ctaUrl = `${BASE_URL}/home/${kid.parentId}?userId=${kid.parentId}&view=lumi&student=${stu.id}&subject=English`;

  // Radar PNGs.
  const grammarPng = drawRadar(
    `${childFirst}'s Grammar fluency`,
    grammar.totalAvailable > 0 ? `Overall ${grammar.overall ?? 0}% (${grammar.totalAwarded}/${grammar.totalAvailable} marks)` : "No attempts yet",
    grammar.subTopics,
  );
  const synthesisPng = drawRadar(
    `${childFirst}'s Synthesis fluency`,
    synthesis.totalAvailable > 0 ? `Overall ${synthesis.overall ?? 0}% (${synthesis.totalAwarded}/${synthesis.totalAvailable} marks)` : "No attempts yet",
    synthesis.subTopics,
  );

  // Topic bar chart (re-using the same renderer as the weekly email).
  let chartPng: Buffer | null = null;
  if (tutor.kind === "ready" && tutor.topline.allTopics.length > 0) {
    chartPng = drawTopicChart(tutor.topline.allTopics, tutor.topline.avgPct, SUBJECT_LABEL.English, childFirst);
  }

  // English Lumi delta body — only when the kid has new activity this week.
  let deltaHtml = "";
  if (tutor.kind === "ready" && tutor.weeklyDelta) {
    deltaHtml = renderDelta(tutor as Extract<TutorData, { kind: "ready" }>, childFirst, "English", ctaUrl);
  }

  const grammarCid    = `radar-grammar-${stu.id.slice(-6)}`;
  const synthesisCid  = `radar-synthesis-${stu.id.slice(-6)}`;
  const chartCid      = `chart-english-${stu.id.slice(-6)}`;

  const subject = `Personalised practice targeting ${childFirst}'s gaps in grammar and synthesis`;

  // Body layout:
  //   1. Feature announcement intro (the "what's new")
  //   2. Grammar + Synthesis radar images side-by-side (stacked on mobile)
  //   3. The standard English Lumi delta block (wins, topic progress, new mistakes)
  //   4. Topic bar chart "Progress so far"
  //   5. CTA → Lumi English
  const rawHtml = `<!doctype html>
<html><body style="${STYLES.body}">
  <div style="${STYLES.container}">
    <p style="${STYLES.intro}">Hi ${esc(kid.parentFirst)},</p>
    <p style="${STYLES.intro}"><strong>New on MarkForYou:</strong> personalised practice for ${esc(childFirst)} now drills the exact PSLE rule families and synthesis tricks ${esc(childFirst)} keeps losing marks on — not just generic Grammar / Synthesis sections.</p>
    <p style="${STYLES.intro}">The two charts below show ${esc(childFirst)}'s fluency on every PSLE Grammar rule (7) and Synthesis trick (6) — based on every marked English paper to date. Green ≥75%, yellow 50–74%, red &lt;50%.</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 12px 0;">
      <tr>
        <td align="center" style="padding: 6px; vertical-align: top;">
          <img src="cid:${grammarCid}" alt="${esc(childFirst)} — Grammar fluency radar" style="width: 100%; max-width: 360px; display: block; border-radius: 12px; border: 1px solid #ddd6fe;" />
        </td>
        <td align="center" style="padding: 6px; vertical-align: top;">
          <img src="cid:${synthesisCid}" alt="${esc(childFirst)} — Synthesis fluency radar" style="width: 100%; max-width: 360px; display: block; border-radius: 12px; border: 1px solid #ddd6fe;" />
        </td>
      </tr>
    </table>

    <p style="${STYLES.intro}">Each week Lumi picks the weakest two sub-topics from these radars and builds ${esc(childFirst)}'s personalised quizzes around them — with watch-out bullets that name the rule, the trap, and the recurring mistake from ${esc(childFirst)}'s own papers.</p>

    <h2 style="${STYLES.subjectH}">✍️ ${SUBJECT_LABEL.English} — this week's Lumi update</h2>
    ${deltaHtml || `<p style="${STYLES.intro}">No new English papers since the last snapshot — the radars above still reflect ${esc(childFirst)}'s cumulative fluency, and the next Lumi update will follow as soon as a new paper is marked.</p>`}
    ${chartPng ? `<div style="${STYLES.sectionH} color: #475569;">Progress so far</div><img src="cid:${chartCid}" alt="${esc(childFirst)} — English per-topic accuracy" style="${STYLES.chart}" />` : ""}

    <a href="${ctaUrl}" style="${STYLES.cta}">See ${esc(childFirst)}'s full English report on Lumi →</a>

    <p style="margin: 20px 0 0 0; color: #001e40; font-size: 14px; line-height: 1.55;">
      Cheering ${esc(childFirst)} on,<br/>
      <strong>Lumi &amp; the MarkForYou team</strong>
    </p>
  </div>
</body></html>`;
  const html = rawHtml
    .split(/\n/).map(l => l.replace(/^\s+/, "")).filter(l => l.length > 0).join("\n");

  const attachments: Array<{ content: string; filename: string; type: string; disposition: string; content_id: string }> = [
    { content: grammarPng.toString("base64"),   filename: `${grammarCid}.png`,   type: "image/png", disposition: "inline", content_id: grammarCid },
    { content: synthesisPng.toString("base64"), filename: `${synthesisCid}.png`, type: "image/png", disposition: "inline", content_id: synthesisCid },
  ];
  if (chartPng) {
    attachments.push({ content: chartPng.toString("base64"), filename: `${chartCid}.png`, type: "image/png", disposition: "inline", content_id: chartCid });
  }

  if (dryRun) {
    let previewHtml = html;
    previewHtml = previewHtml.replace(new RegExp(`cid:${grammarCid}`, "g"),   `data:image/png;base64,${grammarPng.toString("base64")}`);
    previewHtml = previewHtml.replace(new RegExp(`cid:${synthesisCid}`, "g"), `data:image/png;base64,${synthesisPng.toString("base64")}`);
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
