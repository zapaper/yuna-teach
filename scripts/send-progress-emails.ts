// Auto-send progress reports.
//
// Usage:
//   DATABASE_URL=… SENDGRID_API_KEY=… npx tsx scripts/send-progress-emails.ts <mode> [studentName]
//
//   <mode>:
//     --dry-run                    : render PNG + HTML to eval/ for review, no send
//     --send-one <studentName>     : actually email the named child's parent, mark sent
//     --send-all                   : email every eligible (child, subject) that hasn't received one yet
//
// Eligibility:
//   - Math/Science: ≥3 completed daily quizzes (paperType=quiz, title contains "Daily Quiz")
//   - English/Chinese: ≥3 completed focused practices (paperType=focused)
//   - ≥5 distinct topics in that subject
//   - linked parent has an email on file
//   - student.settings.progressReportsSent[subject] is not set yet (one-time per child × subject)
//
// Weak-topic threshold: ≥5 attempts AND ≥10pp below subject average.
// Top 2 weak topics surface as "Recommended next steps" — each is a
// deep link into /home/{parentId}?focused=1&studentId=…&subject=…&topic=…
// which auto-opens the Focused Practice modal pre-filled.

import { prisma } from "../src/lib/db";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "fs";
import path from "path";
import { createCanvas } from "@napi-rs/canvas";
import sgMail from "@sendgrid/mail";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://www.markforyou.com";
const FROM_ADDRESS = process.env.SENDGRID_FROM_ADDRESS ?? "hello@markforyou.com";
const TEAM_BCC = "jessica@markforyou.com";

const EXCLUDED_NAMES = new Set(["admin", "student555", "student666"]);
const EXCLUDED_FAMILIES = ["mark lim", "david lim", "emily lim"];
const MIN_QUIZZES = 3;
const MIN_TOPICS = 5;
const WEAK_GAP_PP = 10;
const WEAK_MIN_ATTEMPTS = 5;

function classifySubject(s: string | null | undefined): string | null {
  const t = (s ?? "").toLowerCase();
  if (t.includes("english")) return "English";
  if (t.includes("math")) return "Math";
  if (t.includes("science")) return "Science";
  if (t.includes("chinese") || (s ?? "").includes("华文") || (s ?? "").includes("中文")) return "Chinese";
  return null;
}

type TopicRow = { topic: string; attempts: number; awarded: number; available: number; pct: number };

function drawTopicChart(topics: TopicRow[], avg: number, subject: string, studentName: string): Buffer {
  // Font scale: chart text doubled vs the web app's 10-13px palette,
  // title doubled again so it dominates without crowding the bars.
  // Title sits in its own header strip above padT; padT pushed down
  // far enough that the larger title + subtitle can never overlap
  // the plot. Bar labels above each bar use the doubled stack too,
  // and padB grows to fit the wider rotated x-axis labels.
  const FONT_AXIS = 20;          // y-tick labels, n=attempts
  const FONT_BAR_PCT = 28;       // bar % label above each bar (bold)
  const FONT_XLABEL = 24;        // rotated topic labels under the x-axis
  const FONT_SUBTITLE = 22;      // student/subject summary line
  const FONT_TITLE = 44;         // bold heading
  const FONT_AVG = 22;           // "avg N%" label on the dashed line

  const W = 1400;
  const longest = topics.reduce((m, t) => Math.max(m, t.topic.length), 0);
  // Rotated -40° label vertical footprint ≈ char-width × sin(40°)
  // per char. Char-width at 24px ≈ 14px. Plus a bottom buffer.
  const labelHeight = Math.ceil(longest * 14 * 0.64) + 36;
  const padL = 80, padR = 30;
  // Header strip (title + subtitle). Need at least:
  //   topMargin (10) + title (44) + gap (10) + subtitle (22) + descender (4)
  //   = 90 px down to the bottom of the subtitle.
  // Then the per-bar % label above a bar at 100% extends UP from
  // padT by FONT_BAR_PCT + FONT_AXIS + 6 ≈ 54 px, so padT must sit
  // at least 90 + 54 + safety = ~160 below the canvas top to keep
  // the bar label off the subtitle.
  const subtitleBottom = 10 + FONT_TITLE + 10 + FONT_SUBTITLE + 4; // ≈ 90
  const barLabelStackH = FONT_BAR_PCT + FONT_AXIS + 14; // % bold + n=attempts + buffer
  const padT = subtitleBottom + barLabelStackH + 16;
  const padB = Math.max(150, labelHeight);
  // Plot needs enough vertical room for the per-bar % + n labels at
  // top AND a visible bar; bump base plot height to compensate for
  // the larger bar-label stack.
  const plotHTarget = 380;
  const H = padT + plotHTarget + padB;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#DDD6FE"; ctx.lineWidth = 2; ctx.strokeRect(1, 1, W - 2, H - 2);

  // Title — student name + subject. Bold and dominant.
  ctx.fillStyle = "#001E40";
  ctx.font = `bold ${FONT_TITLE}px sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(`${studentName} — ${subject}`, padL, FONT_TITLE + 10);
  // Subtitle — topic count, total attempts, subject avg.
  const totalAttempts = topics.reduce((s, t) => s + t.attempts, 0);
  ctx.font = `${FONT_SUBTITLE}px sans-serif`;
  ctx.fillStyle = "#43474F";
  ctx.fillText(
    `${topics.length} topic${topics.length === 1 ? "" : "s"} · ${totalAttempts.toLocaleString()} attempts · subject average ${avg.toFixed(1)}%`,
    padL, FONT_TITLE + 10 + FONT_SUBTITLE + 6,
  );

  const minTopicPct = Math.min(...topics.map(t => t.pct));
  const yMin = (minTopicPct >= 50 && avg >= 50) ? 50 : 0;
  const yStep = yMin === 50 ? 10 : 25;
  const yTicks: number[] = [];
  for (let v = yMin; v <= 100; v += yStep) yTicks.push(v);
  const y = (pct: number) => {
    const clamped = Math.max(yMin, Math.min(100, pct));
    return padT + plotH - ((clamped - yMin) / (100 - yMin)) * plotH;
  };

  ctx.strokeStyle = "#E5E7EB"; ctx.lineWidth = 1;
  ctx.font = `${FONT_AXIS}px sans-serif`;
  ctx.fillStyle = "#737780"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (const pct of yTicks) {
    const py = y(pct);
    ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(padL + plotW, py); ctx.stroke();
    ctx.fillText(`${pct}%`, padL - 12, py);
  }
  ctx.textBaseline = "alphabetic";

  const n = topics.length;
  const slot = plotW / Math.max(1, n);
  const barW = Math.min(96, slot * 0.9);
  for (let i = 0; i < topics.length; i++) {
    const t = topics[i];
    const x = padL + slot * i + (slot - barW) / 2;
    const by = y(t.pct);
    const h = (padT + plotH) - by;
    ctx.fillStyle = t.pct >= avg ? "#10B981" : "#94A3B8";
    const r = 4;
    ctx.beginPath();
    ctx.moveTo(x, by + r);
    ctx.quadraticCurveTo(x, by, x + r, by);
    ctx.lineTo(x + barW - r, by);
    ctx.quadraticCurveTo(x + barW, by, x + barW, by + r);
    ctx.lineTo(x + barW, by + h);
    ctx.lineTo(x, by + h);
    ctx.closePath();
    ctx.fill();
    // % label above bar — needs ~ FONT_BAR_PCT + FONT_AXIS px clearance
    // above the bar top. With padT-protected title strip there's
    // always room even for a bar hitting 100%.
    ctx.fillStyle = "#001E40";
    ctx.font = `bold ${FONT_BAR_PCT}px sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText(`${t.pct.toFixed(0)}%`, x + barW / 2, by - FONT_AXIS - 6);
    ctx.fillStyle = "#737780";
    ctx.font = `${FONT_AXIS}px sans-serif`;
    ctx.fillText(`n=${t.attempts}`, x + barW / 2, by - 6);
    ctx.save();
    ctx.translate(x + barW / 2, padT + plotH + 16);
    ctx.rotate(-Math.PI * 40 / 180);
    ctx.fillStyle = "#43474F";
    ctx.font = `600 ${FONT_XLABEL}px sans-serif`;
    ctx.textAlign = "right";
    ctx.fillText(t.topic, 0, 0);
    ctx.restore();
  }

  ctx.strokeStyle = "#DC2626"; ctx.lineWidth = 3; ctx.setLineDash([12, 8]);
  ctx.beginPath(); ctx.moveTo(padL, y(avg)); ctx.lineTo(padL + plotW, y(avg)); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#DC2626";
  ctx.font = `bold ${FONT_AVG}px sans-serif`;
  ctx.textAlign = "right";
  ctx.fillText(`avg ${avg.toFixed(1)}%`, padL + plotW - 8, y(avg) - 12);

  return canvas.toBuffer("image/png");
}

function pickWeakTopics(topics: TopicRow[], avg: number, maxOut = 2): TopicRow[] {
  return topics
    .filter(t => t.attempts >= WEAK_MIN_ATTEMPTS && t.pct < avg - WEAK_GAP_PP)
    .sort((a, b) => a.pct - b.pct)
    .slice(0, maxOut);
}

const SUBJECT_LABEL: Record<string, string> = {
  Math: "Mathematics",
  Science: "Science",
  English: "English",
  Chinese: "Chinese",
};

const SUBJECT_QUIZ_NOUN: Record<string, string> = {
  Math: "daily quiz",
  Science: "daily quiz",
  English: "focused practice",
  Chinese: "focused practice",
};

function firstName(full: string): string {
  return (full ?? "").trim().split(/\s+/)[0] ?? full;
}

function buildEmailHtml(args: {
  parentFirstName: string;
  parentId: string;
  studentName: string;
  studentId: string;
  subject: string;
  subjectLabel: string;
  quizzes: number;
  avg: number;
  weak: TopicRow[];
  chartCid: string;
}): { html: string; text: string; subject: string } {
  // "Full Report" link → /progress/<studentId>?userId=<parentId>.
  // Per-topic CTAs → /home/<parentId>?focused=1&studentId=…&subject=…
  // &topic=…. Page+ParentDashboard read those query params on mount
  // and auto-open the Focused Practice modal pre-filled with the
  // weak topic, so the parent lands one click away from creating
  // the practice. Wiring lives at:
  //   src/app/home/[userId]/page.tsx (emailFocused* prop passthrough)
  //   src/app/home/[userId]/ParentDashboard.tsx (mount useEffect)
  const progressLink = `${BASE_URL}/progress/${args.studentId}?userId=${args.parentId}`;
  const focusedLink = (topic: string) =>
    `${BASE_URL}/home/${args.parentId}?focused=1&studentId=${args.studentId}&subject=${encodeURIComponent(args.subject.toLowerCase())}&topic=${encodeURIComponent(topic)}`;
  const overallVerdict = args.avg >= 85 ? "really impressive" : args.avg >= 70 ? "very solid" : args.avg >= 55 ? "coming along" : "an area we can lean into together";
  const quizNoun = SUBJECT_QUIZ_NOUN[args.subject] ?? "practice";
  const childFirst = firstName(args.studentName);

  const weakBlock = args.weak.length === 0
    ? `<p style="margin:16px 0 0 0;color:#43474f;font-size:14px;line-height:1.5;">
        Nothing screams out as a weak spot this round — everything's within a healthy band of the average. Keep the practice rhythm going!
       </p>`
    : `<h3 style="margin:24px 0 8px 0;font-size:16px;color:#001e40;">A couple of spots worth a closer look</h3>
       <p style="margin:0 0 12px 0;color:#43474f;font-size:14px;line-height:1.55;">
         In our experience, the most efficient and effective way to pull up ${childFirst}'s average is to do <strong>Focused Practice</strong> on those weak areas.
         You should be able to see results within a few practices. Each <strong>Focused Practice</strong> is just 10 questions and only takes ${childFirst} ~15 minutes a session.
       </p>
       ${args.weak.map(w => `
         <div style="border:1px solid #b6f0ce;border-radius:12px;padding:14px;margin-bottom:10px;background:#ecfdf5;">
           <p style="margin:0;font-weight:700;color:#047857;font-size:14px;">${w.topic}</p>
           <p style="margin:4px 0 10px 0;color:#43474f;font-size:13px;">
             ${w.attempts} attempts so far · ${w.pct.toFixed(0)}% — about ${Math.round(args.avg - w.pct)} percentage points below ${childFirst}'s ${args.subjectLabel.toLowerCase()} average.
           </p>
           <a href="${focusedLink(w.topic)}" style="display:inline-block;padding:9px 16px;background:#047857;color:#ffffff;text-decoration:none;border-radius:999px;font-weight:700;font-size:13px;">
             Create focused practice on ${w.topic} →
           </a>
         </div>
       `).join("")}`;

  const html = `<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#001e40;background:#f4f6fb;margin:0;padding:24px 12px;">
  <div style="max-width:680px;margin:0 auto;background:#ffffff;border-radius:16px;padding:28px;border:1px solid #e5eeff;">
    <p style="margin:0 0 4px 0;font-size:13px;color:#43474f;">Hi ${args.parentFirstName},</p>
    <h1 style="font-size:22px;margin:8px 0 8px 0;color:#001e40;">${childFirst}'s Progress Report — ${args.subjectLabel}</h1>
    <p style="margin:0 0 18px 0;color:#43474f;font-size:14px;line-height:1.55;">
      Hope you're having a good week! ${childFirst} has now completed <strong>${args.quizzes} ${quizNoun}${args.quizzes === 1 ? "" : "s"}</strong> in ${args.subjectLabel} on MarkForYou,
      which gives us enough signal to share a real picture of how things are going. ${args.subjectLabel} average:
      <strong style="color:#001e40;">${args.avg.toFixed(1)}%</strong> — that's ${overallVerdict}.
    </p>

    <img src="cid:${args.chartCid}" alt="${childFirst} — ${args.subjectLabel} per-topic accuracy" style="width:100%;max-width:680px;display:block;border-radius:12px;border:1px solid #ddd6fe;" />

    <p style="margin:14px 0 0 0;color:#737780;font-size:12px;font-style:italic;">
      Green bars are at or above ${childFirst}'s ${args.subjectLabel.toLowerCase()} average; grey bars sit below it. The red dashed line marks the average.
    </p>

    ${weakBlock}

    <p style="margin:24px 0 8px 0;color:#43474f;font-size:13px;line-height:1.5;">
      You can also see the full picture anytime on ${childFirst}'s
      <a href="${progressLink}" style="color:#003366;font-weight:700;">Full Report</a>.
    </p>

    <p style="margin:24px 0 4px 0;color:#737780;font-size:11px;line-height:1.5;">
      This report is generated the first time a child completes at least ${MIN_QUIZZES} ${quizNoun}s
      covering at least ${MIN_TOPICS} distinct topics in a subject. Weak spots come from topics with at
      least ${WEAK_MIN_ATTEMPTS} attempts that sit at least ${WEAK_GAP_PP} percentage points below the
      subject average.
    </p>
    <p style="margin:6px 0 0 0;color:#737780;font-size:12px;">— The MarkForYou team</p>
  </div>
</body></html>`;

  const text = `Hi ${args.parentFirstName},

${childFirst}'s Progress Report — ${args.subjectLabel}

${childFirst} has completed ${args.quizzes} ${quizNoun}${args.quizzes === 1 ? "" : "s"} in ${args.subjectLabel}. ${args.subjectLabel} average: ${args.avg.toFixed(1)}% (${overallVerdict}).

${args.weak.length > 0 ? `In our experience, the most efficient and effective way to pull up ${childFirst}'s average is to do Focused Practice on those weak areas. You should be able to see results within a few practices. Each Focused Practice is 10 questions and takes ~15 minutes.\n\nA couple of spots worth a closer look:\n${args.weak.map(w => `- ${w.topic}: ${w.attempts} attempts, ${w.pct.toFixed(0)}% (about ${Math.round(args.avg - w.pct)}pp below ${args.subjectLabel.toLowerCase()} avg)\n  Create focused practice: ${focusedLink(w.topic)}`).join("\n")}` : "No clear weak spots this round — keep the practice rhythm going."}

Full Report: ${progressLink}

— The MarkForYou team`;

  return {
    html,
    text,
    subject: `${childFirst}'s Progress Report and Recommended Next Steps`,
  };
}

async function loadCandidates(args: { onlyStudentName?: string }) {
  const allUsers = await prisma.user.findMany({
    select: { id: true, name: true, email: true, settings: true, level: true },
  });
  const excludedIds = new Set(
    allUsers
      .filter(u => {
        const lower = (u.name ?? "").toLowerCase();
        if (EXCLUDED_NAMES.has(lower)) return true;
        if (EXCLUDED_FAMILIES.some(f => lower.includes(f))) return true;
        const s = u.settings as { admin?: unknown } | null;
        if (s?.admin === true) return true;
        return false;
      })
      .map(u => u.id),
  );
  const userById = new Map(allUsers.map(u => [u.id, u]));
  const links = await prisma.parentStudent.findMany({
    select: { parentId: true, studentId: true },
  });
  const parentOfStudent = new Map<string, string[]>();
  for (const l of links) {
    if (!parentOfStudent.has(l.studentId)) parentOfStudent.set(l.studentId, []);
    parentOfStudent.get(l.studentId)!.push(l.parentId);
  }

  // Pull every completed/released paper assigned to a non-excluded
  // student — mirrors /api/student-progress so the email's chart +
  // average match the Full Report page exactly. Eligibility (≥3
  // daily quizzes / focused practices) is a SUBSET counted alongside;
  // the chart and average always use the full set so the parent sees
  // one consistent number across the email and the page.
  const papers = await prisma.examPaper.findMany({
    where: {
      markingStatus: { in: ["complete", "released"] },
      assignedToId: { not: null },
      NOT: { assignedToId: { in: [...excludedIds] } },
    },
    select: {
      id: true, title: true, subject: true, assignedToId: true, paperType: true,
      completedAt: true, metadata: true,
      questions: { select: { syllabusTopic: true, marksAwarded: true, marksAvailable: true, studentAnswer: true } },
    },
  });

  type Agg = {
    studentId: string;
    subject: string;
    eligibilityCount: number;
    topics: Map<string, TopicRow>;
  };
  const byKey = new Map<string, Agg>();
  for (const p of papers) {
    // Revision-mode papers (curated past mistakes) are excluded by
    // /api/student-progress to avoid double-counting. Mirror that
    // here so the average matches.
    const meta = p.metadata as { revisionMode?: string } | null;
    if (meta?.revisionMode) continue;
    const subj = classifySubject(p.subject);
    if (!subj || !p.assignedToId) continue;
    const k = `${p.assignedToId}::${subj}`;
    let agg = byKey.get(k);
    if (!agg) {
      agg = { studentId: p.assignedToId, subject: subj, eligibilityCount: 0, topics: new Map() };
      byKey.set(k, agg);
    }
    // Eligibility counter — only daily quizzes (Math/Sci) and
    // focused practices (Eng/Ch) advance the milestone gate.
    const isMathSci = subj === "Math" || subj === "Science";
    const isEngCh = subj === "English" || subj === "Chinese";
    const isDailyQuiz = p.paperType === "quiz" && (p.title?.toLowerCase().includes("daily quiz") ?? false);
    const isFocused = p.paperType === "focused";
    if ((isMathSci && isDailyQuiz) || (isEngCh && isFocused)) agg.eligibilityCount++;
    // Chart + average data — every question on every paper in this
    // subject EXCEPT explicit "__SKIPPED__" rows (the canonical
    // skipped sentinel). /api/student-progress drops the same set,
    // so the email's average lines up with the Full Report page's.
    // Null studentAnswer is kept (could be in-flight marking or
    // legitimately blank canvas — counted at marksAwarded ?? 0).
    for (const q of p.questions) {
      if (q.studentAnswer === "__SKIPPED__") continue;
      const t = (q.syllabusTopic ?? "").trim();
      if (!t) continue;
      const aw = q.marksAwarded ?? 0, av = q.marksAvailable ?? 0;
      const cur = agg.topics.get(t) ?? { topic: t, attempts: 0, awarded: 0, available: 0, pct: 0 };
      cur.attempts++; cur.awarded += aw; cur.available += av;
      agg.topics.set(t, cur);
    }
  }

  type Candidate = {
    studentId: string; studentName: string; studentLevel: number | null;
    parentId: string; parentName: string; parentEmail: string;
    subject: string; subjectKey: string;
    quizzes: number; avg: number; topics: TopicRow[]; weak: TopicRow[];
    alreadySent: boolean; alreadySentAt: string | null;
  };
  const candidates: Candidate[] = [];
  for (const agg of byKey.values()) {
    if (agg.eligibilityCount < MIN_QUIZZES || agg.topics.size < MIN_TOPICS) continue;
    // Match AdminTopicChart on the Full Report page: only topics
    // with ≥3 attempts count toward the chart AND the average. This
    // produces the same number the parent sees on the page.
    const MIN_QS = 3;
    const topics = [...agg.topics.values()]
      .filter(t => t.available > 0 && t.attempts >= MIN_QS)
      .map(t => ({ ...t, pct: (t.awarded / t.available) * 100 }))
      .sort((a, b) => b.pct - a.pct);
    if (topics.length === 0) continue;
    const totalEarned = topics.reduce((s, t) => s + t.awarded, 0);
    const totalAvailable = topics.reduce((s, t) => s + t.available, 0);
    const avg = totalAvailable > 0 ? (totalEarned / totalAvailable) * 100 : 0;
    const weak = pickWeakTopics(topics, avg);

    const student = userById.get(agg.studentId);
    if (!student) continue;
    if (args.onlyStudentName && (student.name ?? "").toLowerCase() !== args.onlyStudentName.toLowerCase()) continue;
    const parentIds = parentOfStudent.get(agg.studentId) ?? [];
    let parent: { id: string; name: string; email: string | null } | null = null;
    for (const pid of parentIds) {
      const u = userById.get(pid);
      if (u?.email) { parent = { id: u.id, name: u.name, email: u.email }; break; }
    }
    if (!parent) continue;

    const subjectKey = agg.subject.toLowerCase();
    const sentMap = (student.settings as { progressReportsSent?: Record<string, string> } | null)?.progressReportsSent ?? {};
    const alreadySentAt = sentMap[subjectKey] ?? null;
    candidates.push({
      studentId: student.id, studentName: student.name, studentLevel: student.level,
      parentId: parent.id, parentName: parent.name, parentEmail: parent.email!,
      subject: agg.subject, subjectKey,
      quizzes: agg.eligibilityCount, avg, topics, weak,
      alreadySent: !!alreadySentAt, alreadySentAt,
    });
  }
  return candidates;
}

async function sendOne(c: Awaited<ReturnType<typeof loadCandidates>>[number], opts: { dryRun: boolean }) {
  const safeStu = c.studentName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const png = drawTopicChart(c.topics, c.avg, c.subject, c.studentName);
  const chartCid = `chart-${safeStu}-${c.subjectKey}`;
  const { html, text, subject } = buildEmailHtml({
    parentFirstName: firstName(c.parentName),
    parentId: c.parentId,
    studentName: c.studentName,
    studentId: c.studentId,
    subject: c.subject,
    subjectLabel: SUBJECT_LABEL[c.subject] ?? c.subject,
    quizzes: c.quizzes,
    avg: c.avg,
    weak: c.weak,
    chartCid,
  });

  if (opts.dryRun) {
    const evalDir = path.join(process.cwd(), "eval");
    if (!existsSync(evalDir)) mkdirSync(evalDir, { recursive: true });
    const pngPath = path.join(evalDir, `progress-email-${safeStu}-${c.subjectKey}.png`);
    const htmlPath = path.join(evalDir, `progress-email-${safeStu}-${c.subjectKey}.html`);
    writeFileSync(pngPath, png);
    // Swap cid: → relative PNG path so the file opens in a browser.
    writeFileSync(htmlPath, html.replace(`cid:${chartCid}`, path.basename(pngPath)));
    console.log(`  [dry-run] wrote ${pngPath} + ${htmlPath}`);
    return;
  }

  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) { console.warn(`  SENDGRID_API_KEY not set — skipping ${c.parentEmail}`); return; }
  sgMail.setApiKey(apiKey);
  try {
    const [resp] = await sgMail.send({
      to: c.parentEmail,
      bcc: TEAM_BCC,
      from: { email: FROM_ADDRESS, name: "MarkForYou" },
      replyTo: TEAM_BCC,
      subject,
      html,
      text,
      attachments: [{
        content: png.toString("base64"),
        filename: `${safeStu}-${c.subjectKey}.png`,
        type: "image/png",
        disposition: "inline",
        content_id: chartCid,
      }],
      trackingSettings: {
        clickTracking: { enable: false, enableText: false },
        openTracking: { enable: false },
        subscriptionTracking: { enable: false },
      },
    });
    console.log(`  sent to=${c.parentEmail} parent=${c.parentName} child=${c.studentName} subject=${c.subject} status=${resp.statusCode} messageId=${resp.headers?.["x-message-id"] ?? "n/a"}`);
    // Mark sent (one-time per child × subject). Read-modify-write the
    // student's settings.progressReportsSent map; if it already has
    // a timestamp for this subject we leave it alone.
    const student = await prisma.user.findUnique({ where: { id: c.studentId }, select: { settings: true } });
    const existing = (student?.settings as { progressReportsSent?: Record<string, string> } | null)?.progressReportsSent ?? {};
    if (!existing[c.subjectKey]) {
      const updated = { ...existing, [c.subjectKey]: new Date().toISOString() };
      await prisma.user.update({
        where: { id: c.studentId },
        data: { settings: { ...((student?.settings as Record<string, unknown>) ?? {}), progressReportsSent: updated } },
      });
    }
  } catch (err) {
    const e = err as { response?: { body?: unknown; statusCode?: number } } & Error;
    console.error(`  send failed to=${c.parentEmail} status=${e.response?.statusCode ?? "?"} msg=${e.message} body=${JSON.stringify(e.response?.body ?? null)}`);
  }
}

(async () => {
  const mode = process.argv[2] ?? "--dry-run";
  const arg = process.argv[3];

  if (mode === "--dry-run") {
    const candidates = await loadCandidates({ onlyStudentName: arg });
    console.log(`Dry-run: ${candidates.length} candidate (child, subject) pair${candidates.length === 1 ? "" : "s"}`);
    for (const c of candidates) {
      const flag = c.alreadySent ? ` [SKIP — already sent ${c.alreadySentAt}]` : "";
      console.log(`  ${c.parentName} <${c.parentEmail}> → ${c.studentName} · ${c.subject} · ${c.quizzes}q · ${c.avg.toFixed(1)}% · weak=[${c.weak.map(w => w.topic).join(" | ")}]${flag}`);
      if (!c.alreadySent) await sendOne(c, { dryRun: true });
    }
  } else if (mode === "--send-one") {
    if (!arg) throw new Error("Usage: --send-one <studentName>");
    const candidates = await loadCandidates({ onlyStudentName: arg });
    if (candidates.length === 0) throw new Error(`No eligible candidates for "${arg}"`);
    for (const c of candidates) {
      if (c.alreadySent) {
        console.log(`  ${c.studentName} ${c.subject} already sent ${c.alreadySentAt} — skipping`);
        continue;
      }
      await sendOne(c, { dryRun: false });
    }
  } else if (mode === "--send-all") {
    const candidates = await loadCandidates({});
    console.log(`Send-all: ${candidates.length} candidate (child, subject) pair${candidates.length === 1 ? "" : "s"}`);
    let sent = 0; let skipped = 0;
    for (const c of candidates) {
      if (c.alreadySent) { skipped++; continue; }
      await sendOne(c, { dryRun: false });
      sent++;
    }
    console.log(`\nSent ${sent}, skipped (already sent) ${skipped}`);
  } else {
    console.error(`Unknown mode "${mode}". Use --dry-run | --send-one <name> | --send-all`);
    process.exit(1);
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
