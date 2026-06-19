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
import sharp from "sharp";
import sgMail from "@sendgrid/mail";

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://www.markforyou.com";
const FROM_ADDRESS = process.env.SENDGRID_FROM_ADDRESS ?? "hello@markforyou.com";
const TEAM_BCC = "jessica@markforyou.com";

const EXCLUDED_NAMES = new Set(["admin", "student555", "student666"]);
const EXCLUDED_FAMILIES = ["mark lim", "david lim", "emily lim"];
const MIN_QUIZZES = 3;
const MIN_TOPICS = 5;
const WEAK_GAP_PP = 8;
const WEAK_MIN_ATTEMPTS = 5;

export function classifySubject(s: string | null | undefined): string | null {
  const t = (s ?? "").toLowerCase();
  if (t.includes("english")) return "English";
  if (t.includes("math")) return "Math";
  if (t.includes("science")) return "Science";
  if (t.includes("chinese") || (s ?? "").includes("华文") || (s ?? "").includes("中文")) return "Chinese";
  return null;
}

// Each attempt = one marked question on a paper, timestamped by the
// paper's completedAt. Used downstream for the "last 5 vs overall"
// improvement trend on weak topics with ≥10 attempts.
type Attempt = { ts: Date; awarded: number; available: number };
type TopicRow = {
  topic: string; attempts: number; awarded: number; available: number; pct: number;
  // Optional enrichment populated for the email's chart/CTA logic:
  attemptsLog?: Attempt[];           // chronological attempts (sorted ascending)
  alreadyPracticed?: boolean;        // true if a paperType="focused" paper exists with this topic for this student
  reviewLink?: string | null;        // /exam/<paperId>/review for the most recent focused practice on this topic
  recentPct?: number | null;         // last 5 attempts' pct (null if < 10 attempts total)
  trendImproving?: boolean;          // recentPct > overall pct + 5 AND ≥ 10 attempts
  trendChartCid?: string;            // CID of the inline trend chart PNG, when one was generated
  paperCount?: number;               // distinct papers (by completedAt) that touched this topic
};

export function drawTopicChart(topics: TopicRow[], avg: number, subject: string, studentName: string): Buffer {
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
  // Truncate over-long topic labels (Science's
  // "Interaction of forces (Frictional force, …)" is the worst
  // offender at 78 chars — at 24px rotated -40° its diagonal
  // footprint exceeded 700 px, dominating padB and leaving every
  // other label with a giant white strip below it). Cap at 36
  // chars + ellipsis — still readable, keeps the chart compact.
  const MAX_TOPIC_LABEL = 36;
  const displayTopic = (t: string) => t.length > MAX_TOPIC_LABEL ? `${t.slice(0, MAX_TOPIC_LABEL - 1)}…` : t;
  const longest = topics.reduce((m, t) => Math.max(m, displayTopic(t.topic).length), 0);
  // Rotated -40° label vertical footprint ≈ char-width × sin(40°)
  // per char. Char-width at 24px sans-serif ≈ 12 px (was 14 —
  // wider than reality, which pushed padB further than needed).
  const labelHeight = Math.ceil(longest * 12 * 0.64) + 24;
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
    ctx.fillText(displayTopic(t.topic), 0, 0);
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

// Per-topic trend chart — visual port of SelectedTopicPanel on the
// Full Report page (src/app/progress/[studentId]/page.tsx:871).
// Each per-paper dot is a faint purple circle; when ≥6 papers worth
// of data, we overlay a 3-paper rolling-average line + darker dots
// (the "main signal"). Subject-average line in dashed red.
function drawTopicTrendChart(
  perPaperPoints: Array<{ ts: Date; awarded: number; available: number; pct: number; count: number }>,
  topicLabel: string,
  topicAvg: number,
): Buffer {
  // Drop papers that didn't contribute to this topic (defensive — the
  // caller already filters).
  const series = perPaperPoints.filter(p => p.available > 0);
  if (series.length === 0) return Buffer.alloc(0);

  // 3-paper rolling bucket when ≥6 papers; per-paper otherwise.
  // bucket.count = total questions across the bucket's papers — shown
  // as `n=N` next to each dot so the parent sees the scale behind
  // each rolling-average value (mirrors the main chart's per-bar
  // n=X annotation).
  const BUCKET = 3;
  const bucketed = series.length >= 2 * BUCKET;
  const buckets: Array<{ from: number; to: number; pct: number; count: number }> = [];
  if (bucketed) {
    for (let i = 0; i < series.length; i += BUCKET) {
      const window = series.slice(i, i + BUCKET);
      const e = window.reduce((s, p) => s + p.awarded, 0);
      const a = window.reduce((s, p) => s + p.available, 0);
      const n = window.reduce((s, p) => s + p.count, 0);
      if (a <= 0) continue;
      buckets.push({ from: i, to: Math.min(i + BUCKET - 1, series.length - 1), pct: (e / a) * 100, count: n });
    }
  } else {
    series.forEach((p, i) => buckets.push({ from: i, to: i, pct: p.pct, count: p.count }));
  }

  const W = 800, H = 280;
  const padL = 56, padR = 16, padT = 50, padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Background + soft border (matches the chart card style).
  ctx.fillStyle = "#FFFFFF"; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "#DDD6FE"; ctx.lineWidth = 2; ctx.strokeRect(1, 1, W - 2, H - 2);

  // Title.
  ctx.fillStyle = "#5B21B6"; ctx.font = "bold 16px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.fillText(`${topicLabel} — trend`, padL, 22);
  ctx.font = "14px sans-serif"; ctx.fillStyle = "#43474F";
  const latest = series[series.length - 1];
  const latestLabel = bucketed
    ? `last ${Math.min(BUCKET, series.length)} papers avg ${buckets[buckets.length - 1].pct.toFixed(0)}%`
    : `latest paper ${latest.pct.toFixed(0)}%`;
  ctx.fillText(`${series.length} papers · topic avg ${topicAvg.toFixed(1)}% · ${latestLabel}`, padL, 40);

  // y-axis: same shape as SelectedTopicPanel (yMin = min(50, ⌊min/10⌋*10)).
  const allPcts = [...buckets.map(b => b.pct), ...series.map(s => s.pct), topicAvg];
  const yMin = Math.min(50, Math.floor(Math.min(...allPcts) / 10) * 10);
  const y = (pct: number) =>
    padT + plotH - ((Math.max(yMin, Math.min(100, pct)) - yMin) / (100 - yMin)) * plotH;

  // Gridlines + labels at yMin, midpoint, 100. No topic-average
  // dashed line here — the parent flagged it as visual clutter on
  // the per-topic scatter (the top-of-email chart already carries
  // the same line at the subject level).
  ctx.strokeStyle = "#E5E7EB"; ctx.lineWidth = 1; ctx.font = "12px sans-serif"; ctx.fillStyle = "#43474F"; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (const pct of [yMin, Math.round((yMin + 100) / 2), 100]) {
    const py = y(pct);
    ctx.beginPath(); ctx.moveTo(padL, py); ctx.lineTo(padL + plotW, py); ctx.stroke();
    ctx.fillText(`${pct}%`, padL - 8, py);
  }
  ctx.textBaseline = "alphabetic";

  // X-positions.
  const seriesLast = Math.max(1, series.length - 1);
  const xForSeriesIdx = (idx: number) =>
    series.length === 1 ? padL + plotW / 2 : padL + (idx / seriesLast) * plotW;
  const xForBucket = (b: { from: number; to: number }) => xForSeriesIdx((b.from + b.to) / 2);

  // Faint per-paper dots (the source data).
  ctx.fillStyle = "#C4B5FD";
  for (let i = 0; i < series.length; i++) {
    const p = series[i];
    ctx.beginPath(); ctx.arc(xForSeriesIdx(i), y(p.pct), 5, 0, Math.PI * 2); ctx.fill();
  }

  // Darker rolling-average dots + connecting line.
  if (buckets.length > 1) {
    ctx.strokeStyle = "#7C3AED"; ctx.lineWidth = 3.5; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath();
    buckets.forEach((b, i) => {
      const bx = xForBucket(b), by = y(b.pct);
      if (i === 0) ctx.moveTo(bx, by); else ctx.lineTo(bx, by);
    });
    ctx.stroke();
  }
  ctx.fillStyle = "#7C3AED"; ctx.strokeStyle = "#FFFFFF"; ctx.lineWidth = 2.5;
  for (const b of buckets) {
    ctx.beginPath(); ctx.arc(xForBucket(b), y(b.pct), 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }

  return canvas.toBuffer("image/png");
}

function pickWeakTopics(topics: TopicRow[], _avg: number, maxOut = 2): TopicRow[] {
  // Just the two lowest-scoring topics. Earlier we required a topic
  // to be ≥ WEAK_GAP_PP below the subject average (and ≥
  // WEAK_MIN_ATTEMPTS attempts) before surfacing it, but on
  // strong-overall children that filter zeroed out and the email
  // had nothing to recommend. The bottom-2-by-pct rule always
  // produces actionable rows. We still want enough attempts to
  // trust the number — the chart already only shows topics with
  // ≥ 3 attempts, so the topics array reaching us is pre-filtered.
  return [...topics].sort((a, b) => a.pct - b.pct).slice(0, maxOut);
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
  strong: TopicRow[];
  chartCid: string;
  lumiCid: string;
  totalAttempts: number;
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
  const focusedLink = (topic: string, opts?: { revise?: boolean }) =>
    `${BASE_URL}/home/${args.parentId}?focused=1&studentId=${args.studentId}&subject=${encodeURIComponent(args.subject.toLowerCase())}&topic=${encodeURIComponent(topic)}${opts?.revise ? "&revise=1" : ""}`;
  // Warmer verdicts. Earlier "coming along" / "lean into together"
  // language read as a polite way of saying "below" — replaced with
  // explicitly encouraging phrasing that opens the door rather than
  // labelling the result.
  const overallVerdict = args.avg >= 85
    ? "really impressive"
    : args.avg >= 70
    ? "very solid"
    : args.avg >= 55
    ? "a strong foundation to build on"
    : "ready for some focused work — we'll get there together";
  const quizNoun = SUBJECT_QUIZ_NOUN[args.subject] ?? "practice";
  const childFirst = firstName(args.studentName);

  // Top "strong" topics first — celebrate before we talk about
  // areas to improve. Wins set the tone for the rest of the email.
  const strongBlock = args.strong.length === 0
    ? ""
    : `<h3 style="margin:22px 0 6px 0;font-size:16px;color:#047857;">${args.strong.length === 1 ? "Something to celebrate" : "Some things to celebrate"}</h3>
       <p style="margin:0 0 12px 0;color:#43474f;font-size:14px;line-height:1.55;">
         ${childFirst} is doing especially well on ${args.strong.map((s, i, arr) => `<strong style="color:#047857;">${s.topic}</strong> (${s.pct.toFixed(0)}%${arr.length > 1 && i === arr.length - 2 ? ")" : i < arr.length - 1 ? "), " : ")"}`).join("")}${args.strong.length > 1 ? " — " : " — "}well above the ${args.subjectLabel.toLowerCase()} average. Worth a little high-five.
       </p>`;

  // Weak-topic block. Per-row CTA branches on whether the student
  // has ALREADY done a Focused Practice on that topic before:
  //   - First time → "Create focused practice on X" (links to the
  //     parent dashboard with the modal pre-filled).
  //   - Already practiced → "Review past mistakes on X" (links to
  //     the most recent focused-practice review page). Reviewing
  //     mistakes BEFORE assigning another round usually beats
  //     doing the same kind of practice on autopilot.
  // Improvement trend: if there are ≥ 10 attempts and the last 5
  // outperform the overall topic pct by ≥ 5 pp, we flag it with a
  // small "improving" badge in the topic row so the parent sees
  // movement before being asked to act.
  const weakBlock = args.weak.length === 0
    ? `<p style="margin:16px 0 0 0;color:#43474f;font-size:14px;line-height:1.5;">
        Nothing screams out as a weak spot this round — everything's within a healthy band of the average. Keep the practice rhythm going!
       </p>`
    : `<h3 style="margin:24px 0 8px 0;font-size:16px;color:#001e40;">A couple of spots worth a closer look</h3>
       <p style="margin:0 0 12px 0;color:#43474f;font-size:14px;line-height:1.55;">
         In our experience, the most efficient and effective way to pull up ${childFirst}'s average is to do <strong>Focused Practice</strong> on those weak areas.
         You should be able to see results within a few practices. Each <strong>Focused Practice</strong> is just 10 questions and only takes ${childFirst} ~15 minutes a session.
       </p>
       ${args.weak.map(w => {
         const trendBadge = w.trendImproving && w.recentPct != null
           ? `<span style="display:inline-block;background:#bbf7d0;color:#065f46;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;margin-left:8px;"><span style="color:#047857;">▲</span> improving — last 5: ${w.recentPct.toFixed(0)}%</span>`
           : "";
         // Celebratory praise — only when an improving trend was
         // detected. Keeps the weak-area block from reading as pure
         // bad news when the child is actually trending up.
         const improvingPraise = w.trendImproving
           ? `<p style="margin:4px 0 0 0;color:#047857;font-size:13px;font-weight:700;">Well done! ${childFirst} is making good progress on this topic!</p>`
           : "";
         const trendChartImg = w.trendChartCid
           ? `<img src="cid:${w.trendChartCid}" alt="${w.topic} trend over time" style="width:100%;max-width:680px;display:block;border-radius:10px;border:1px solid #ddd6fe;margin:8px 0 10px 0;" />`
           : w.paperCount === 1
             ? `<p style="margin:6px 0 10px 0;color:#737780;font-size:12px;font-style:italic;">Only 1 paper attempted on this topic so far — we'll be able to show a trend after the next focused practice.</p>`
             : "";
         // CTA branches three ways:
         //   1. High-volume but stuck (≥ 40 attempts AND not
         //      improving) — likely doing more new questions won't
         //      help; better to revise past mistakes first. CTA
         //      opens the focused-practice modal pre-set to revision
         //      mode (revise=1 → setRevisionMode(true)).
         //   2. Already did a Focused Practice on this topic before —
         //      surface a "review past mistakes" link to the most
         //      recent focused-practice review page above the
         //      standard "Create focused practice" CTA.
         //   3. Default — straight "Create focused practice" CTA.
         const stuckHighVolume = w.attempts >= 40 && !w.trendImproving;
         const ctaLabel = stuckHighVolume
           ? `Revise past mistakes — focused practice on ${w.topic} →`
           : `Create focused practice on ${w.topic} →`;
         const ctaHref = focusedLink(w.topic, { revise: stuckHighVolume });
         // Encouraging copy for the "lots of practice, still stuck"
         // case. Language vs Math/Science get different tails:
         //   - English/Chinese — exposure/quantity framing
         //   - Math/Science — point at the per-question explanations
         //     on the review page (concept clarification + trap notes)
         const isLanguageSubject = args.subject === "English" || args.subject === "Chinese";
         const stuckTail = isLanguageSubject
           ? ` Language is a quantity game — more exposure to different contexts is what starts to move the score.`
           : ` Read our explanations for the questions that ${childFirst} got wrong. They may help clarify some concepts and explain the traps in some of the tricky questions.`;
         const stuckCopy = `${childFirst} has been working hard at this. Let's review the past mistakes before jumping into another practice. Don't give up.${stuckTail}`;
         const ctaHint = stuckHighVolume
           ? `<p style="margin:4px 0 10px 0;color:#737780;font-size:12px;font-style:italic;">${stuckCopy}</p>`
           : w.alreadyPracticed
             ? `<p style="margin:4px 0 10px 0;color:#737780;font-size:12px;font-style:italic;">${childFirst} has done a Focused Practice on this topic before — ${
                 w.reviewLink
                   ? `<a href="${w.reviewLink}" style="color:#737780;text-decoration:underline;">review the past mistakes</a>`
                   : "review the past mistakes"
               } before you start another focus practice.</p>`
             : "";
         return `
         <div style="border:1px solid #b6f0ce;border-radius:12px;padding:14px;margin-bottom:10px;background:#ecfdf5;">
           <p style="margin:0;font-weight:700;color:#047857;font-size:14px;">${w.topic}${trendBadge}</p>
           ${improvingPraise}
           <p style="margin:4px 0 6px 0;color:#43474f;font-size:13px;">
             ${w.attempts} attempts so far · ${w.pct.toFixed(0)}% — about ${Math.round(args.avg - w.pct)} percentage points below ${childFirst}'s ${args.subjectLabel.toLowerCase()} average.
           </p>
           ${trendChartImg}
           ${ctaHint}
           <a href="${ctaHref}" style="display:inline-block;padding:9px 16px;background:#047857;color:#ffffff;text-decoration:none;border-radius:999px;font-weight:700;font-size:13px;">
             ${ctaLabel}
           </a>
         </div>`;
       }).join("")}`;

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

    ${strongBlock}

    ${weakBlock}

    <p style="margin:24px 0 8px 0;color:#43474f;font-size:13px;line-height:1.5;">
      You can also see the full picture anytime on ${childFirst}'s
      <a href="${progressLink}" style="color:#003366;font-weight:700;">Full Report</a>,
      or open your <a href="${BASE_URL}/home/${args.parentId}" style="color:#003366;font-weight:700;">parent homepage</a>.
    </p>

    <!-- Report-criteria disclaimer moved ABOVE the Lumi tease so the
         email doesn't end with small grey text + a generic team
         signature — that pattern triggers Gmail's "trimmed content"
         heuristic and folds the Lumi tease + close under "...". -->
    <p style="margin:16px 0 4px 0;color:#737780;font-size:11px;line-height:1.5;">
      This report is generated the first time a child completes at least ${MIN_QUIZZES} ${quizNoun}s
      covering at least ${MIN_TOPICS} distinct topics in a subject. The "spots worth a closer look" are
      simply the two lowest-scoring topics on the chart (each based on at least 3 attempts).${args.totalAttempts < 100 ? ` With more practices, we can also build a more accurate picture.` : ""}
    </p>

    <!-- Lumi tease — surfaces the Tier-2 (owl assistant) feature that
         kicks in once the child has enough wrongs for Gemini Pro to
         find patterns. Inline lumi1.png replaces the 🦉 emoji. -->
    <div style="margin:24px 0 0 0;padding:16px 18px;background:#faf5ff;border:1px solid #e9d5ff;border-radius:12px;">
      <p style="margin:0;color:#43474f;font-size:13px;line-height:1.55;">
        <strong style="color:#6b21a8;">About Lumi</strong>
        <img src="cid:${args.lumiCid}" alt="Lumi" width="22" style="height:22px;width:auto;vertical-align:middle;display:inline-block;margin:0 4px;" />
        <br/>
        As ${childFirst} does more practices, <strong>Lumi — our owl assistant — will start identifying ${childFirst}'s common mistakes and conceptual gaps</strong>. Look out for Lumi in a few more quizzes' time.
      </p>
    </div>

    <!-- Personalised closing: "Cheering ${childFirst} on" includes the
         child's name so Gmail's signature-detector doesn't recognise
         it as boilerplate. -->
    <p style="margin:24px 0 0 0;color:#001e40;font-size:14px;line-height:1.5;">
      Cheering ${childFirst} on,<br/>
      <strong>The MarkForYou team</strong>
    </p>
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
    // Subject line leads with the school subject so it shows up
    // before any inbox truncation on mobile — "Science Progress
    // Report for Benjamin ong" reads as a clear tagged report.
    // childName uses the DB-stored form (which may be lowercase
    // surname) to match what the parent calls the child.
    subject: `${args.subject} Progress Report for ${args.studentName}`,
  };
}

export async function loadCandidates(args: { onlyStudentName?: string; onlyStudentId?: string; asParentEmail?: string; includeExcluded?: boolean }) {
  const allUsers = await prisma.user.findMany({
    select: { id: true, name: true, email: true, settings: true, level: true },
  });
  // includeExcluded turns off the test-account / admin / lim-family
  // filter — used by the preview path so we can render the email for
  // a normally-excluded student (e.g. Mark Lim) before deciding
  // whether to send it.
  const excludedIds = args.includeExcluded
    ? new Set<string>()
    : new Set(
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
    // Eligibility counter — Math/Sci require "Daily Quiz" titled
    // papers (the mixed-topic diagnostic). Eng/Ch count any quiz or
    // focused practice — English daily quizzes are titled by format
    // ("P6 Grammar MCQ+", "P6 Compre Cloze+") and don't carry the
    // "Daily Quiz" label, so the title filter would zero out kids
    // doing the standard daily English flow.
    const isMathSci = subj === "Math" || subj === "Science";
    const isEngCh = subj === "English" || subj === "Chinese";
    const isDailyQuiz = p.paperType === "quiz" && (p.title?.toLowerCase().includes("daily quiz") ?? false);
    const isFocused = p.paperType === "focused";
    const isAnyQuiz = p.paperType === "quiz";
    if ((isMathSci && isDailyQuiz) || (isEngCh && (isFocused || isAnyQuiz))) agg.eligibilityCount++;
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
      const cur = agg.topics.get(t) ?? { topic: t, attempts: 0, awarded: 0, available: 0, pct: 0, attemptsLog: [] };
      cur.attempts++; cur.awarded += aw; cur.available += av;
      if (p.completedAt) cur.attemptsLog!.push({ ts: p.completedAt, awarded: aw, available: av });
      agg.topics.set(t, cur);
    }
  }

  // For per-student "already practiced this topic" detection we need
  // a list of focused-practice papers per student, keyed by syllabus
  // topic AND with a review URL pointing at the most recent one.
  // Pulled here so each (student, subject) candidate can resolve it
  // in O(1) below.
  type FocusedPracticeRef = { paperId: string; completedAt: Date | null };
  const focusedByStudentTopic = new Map<string, FocusedPracticeRef[]>();
  for (const p of papers) {
    if (p.paperType !== "focused" || !p.assignedToId) continue;
    const topics = new Set<string>();
    for (const q of p.questions) {
      const t = (q.syllabusTopic ?? "").trim();
      if (t) topics.add(t);
    }
    for (const t of topics) {
      const k = `${p.assignedToId}::${t}`;
      if (!focusedByStudentTopic.has(k)) focusedByStudentTopic.set(k, []);
      focusedByStudentTopic.get(k)!.push({ paperId: p.id, completedAt: p.completedAt });
    }
  }
  for (const list of focusedByStudentTopic.values()) {
    list.sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0));
  }

  type Candidate = {
    studentId: string; studentName: string; studentLevel: number | null;
    parentId: string; parentName: string; parentEmail: string;
    subject: string; subjectKey: string;
    quizzes: number; avg: number;
    topics: TopicRow[];
    weak: TopicRow[];
    strong: TopicRow[];
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
    // Top "strong" topics — top 2 topics at least 8 pp above the
    // subject average AND ≥ 5 attempts. Surface them BEFORE the
    // weak section so the email opens on a wins-first tone.
    const strong = topics
      .filter(t => t.attempts >= WEAK_MIN_ATTEMPTS && t.pct >= avg + WEAK_GAP_PP)
      .slice(0, 2);
    // Per-weak-topic enrichment: prior-practice flag + improvement
    // trend. Mutates each weak row in place.
    for (const w of weak) {
      const prior = focusedByStudentTopic.get(`${agg.studentId}::${w.topic}`) ?? [];
      w.alreadyPracticed = prior.length > 0;
      w.reviewLink = prior.length > 0 ? `${BASE_URL}/exam/${prior[0].paperId}/review` : null;
      const log = (w.attemptsLog ?? []).filter(a => a.available > 0).sort((a, b) => a.ts.getTime() - b.ts.getTime());
      const distinctPapers = new Set(log.map(a => a.ts.getTime())).size;
      w.paperCount = distinctPapers;
      // Improvement trend — only meaningful with ≥ 10 attempts AND
      // ≥ 2 distinct papers. A 12-question paper on a single topic
      // would otherwise compute a "last 5 vs overall" trend within
      // one sitting, which isn't a trend.
      if (log.length >= 10 && distinctPapers >= 2) {
        const last5 = log.slice(-5);
        const last5Earned = last5.reduce((s, a) => s + a.awarded, 0);
        const last5Avail = last5.reduce((s, a) => s + a.available, 0);
        const recentPct = last5Avail > 0 ? (last5Earned / last5Avail) * 100 : 0;
        w.recentPct = recentPct;
        w.trendImproving = recentPct >= w.pct + 5;
      }
    }

    const student = userById.get(agg.studentId);
    if (!student) continue;
    if (args.onlyStudentName && (student.name ?? "").toLowerCase() !== args.onlyStudentName.toLowerCase()) continue;
    if (args.onlyStudentId && student.id !== args.onlyStudentId) continue;
    const parentIds = parentOfStudent.get(agg.studentId) ?? [];

    // Build the recipient list. Default: every linked parent who
    // has an email on file — so a child linked to two parents
    // generates two candidate rows and both get a copy. (A parent
    // linked to two eligible kids naturally gets two emails the
    // same way — those come through as separate (child, subject)
    // candidates.) The preview path can narrow to a single
    // recipient via --as-parent <email>.
    type ResolvedParent = { id: string; name: string; email: string };
    const recipients: ResolvedParent[] = [];
    if (args.asParentEmail) {
      // Preview path — exactly one recipient. Either a linked
      // parent matching that email, or a synthesized one when no
      // linked parent matches.
      let matched: ResolvedParent | null = null;
      for (const pid of parentIds) {
        const u = userById.get(pid);
        if (u?.email?.toLowerCase() === args.asParentEmail.toLowerCase()) {
          matched = { id: u.id, name: u.name, email: u.email };
          break;
        }
      }
      if (!matched) {
        const local = args.asParentEmail.split("@")[0] ?? args.asParentEmail;
        const niceName = local.split(/[._-]+/)[0].replace(/^./, c => c.toUpperCase());
        // id "" is fine — only used for dashboard / progress-page
        // links, which are inert previews when no real account.
        matched = { id: "", name: niceName, email: args.asParentEmail };
      }
      recipients.push(matched);
    } else {
      // Real path — fan out to EVERY linked parent who has an
      // email. Deduplicated by email so a parent linked twice
      // doesn't get the report twice. Service / admin accounts are
      // suppressed — TEAM_BCC (jessica@markforyou.com) already
      // covers oversight, so no need to also email admin.
      const SERVICE_EMAILS = new Set(["admin@yunateach.com"]);
      const seenEmails = new Set<string>();
      for (const pid of parentIds) {
        const u = userById.get(pid);
        const e = u?.email?.toLowerCase();
        if (!u || !u.email || !e) continue;
        if (SERVICE_EMAILS.has(e)) continue;
        if (seenEmails.has(e)) continue;
        seenEmails.add(e);
        recipients.push({ id: u.id, name: u.name, email: u.email });
      }
    }
    if (recipients.length === 0) continue;

    const subjectKey = agg.subject.toLowerCase();
    const sentMap = (student.settings as { progressReportsSent?: Record<string, string> } | null)?.progressReportsSent ?? {};
    const alreadySentAt = sentMap[subjectKey] ?? null;
    for (const r of recipients) {
      candidates.push({
        studentId: student.id, studentName: student.name, studentLevel: student.level,
        parentId: r.id, parentName: r.name, parentEmail: r.email,
        subject: agg.subject, subjectKey,
        quizzes: agg.eligibilityCount, avg, topics, weak, strong,
        alreadySent: !!alreadySentAt, alreadySentAt,
      });
    }
  }
  return candidates;
}

export async function sendOne(c: Awaited<ReturnType<typeof loadCandidates>>[number], opts: { dryRun: boolean }) {
  const safeStu = c.studentName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const png = drawTopicChart(c.topics, c.avg, c.subject, c.studentName);
  const chartCid = `chart-${safeStu}-${c.subjectKey}`;

  // Per-weak-topic trend chart. Aggregate the topic's attemptsLog by
  // paper (= same completedAt) into per-paper points and render the
  // same line+dot chart the Full Report's SelectedTopicPanel shows.
  // Only generate when there are ≥ 2 paper points — a single dot
  // isn't a "trend".
  const trendAttachments: Array<{ content: string; filename: string; type: string; disposition: string; content_id: string }> = [];
  const trendPaths: Record<string, string> = {}; // cid → relative filename (dry-run)
  for (let i = 0; i < c.weak.length; i++) {
    const w = c.weak[i];
    const log = (w.attemptsLog ?? []).filter(a => a.available > 0);
    if (log.length === 0) continue;
    // Group attempts by completedAt timestamp (= per-paper).
    // count = how many questions on this paper were tagged to this
    // topic, so the trend chart can render n=N alongside each dot.
    const byTs = new Map<number, { ts: Date; awarded: number; available: number; count: number }>();
    for (const a of log) {
      const key = a.ts.getTime();
      const cur = byTs.get(key) ?? { ts: a.ts, awarded: 0, available: 0, count: 0 };
      cur.awarded += a.awarded; cur.available += a.available; cur.count += 1;
      byTs.set(key, cur);
    }
    const perPaperPoints = [...byTs.values()]
      .sort((a, b) => a.ts.getTime() - b.ts.getTime())
      .map(p => ({ ...p, pct: (p.awarded / p.available) * 100 }));
    if (perPaperPoints.length < 2) continue;
    const trendPng = drawTopicTrendChart(perPaperPoints, w.topic, w.pct);
    if (trendPng.length === 0) continue;
    const cid = `trend-${safeStu}-${c.subjectKey}-${i}`;
    w.trendChartCid = cid;
    const filename = `progress-email-${safeStu}-${c.subjectKey}-trend-${i}.png`;
    trendAttachments.push({
      content: trendPng.toString("base64"),
      filename,
      type: "image/png",
      disposition: "inline",
      content_id: cid,
    });
    if (opts.dryRun) {
      const evalDir = path.join(process.cwd(), "eval");
      if (!existsSync(evalDir)) mkdirSync(evalDir, { recursive: true });
      writeFileSync(path.join(evalDir, filename), trendPng);
      trendPaths[cid] = filename;
    }
  }

  // Lumi mascot — resized once per send for the tease block. 44px @ 2x
  // (rendered at 22px in the HTML) keeps the file ~3KB while staying
  // crisp on retina mail clients.
  const lumiPngFull = readFileSync(path.join(process.cwd(), "public", "avatars", "lumi1.png"));
  const lumiPng = await sharp(lumiPngFull).resize({ height: 44 }).png().toBuffer();
  const lumiCid = `lumi-icon-${safeStu}-${c.subjectKey}`;

  const totalAttempts = c.topics.reduce((s, t) => s + t.attempts, 0);
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
    strong: c.strong,
    chartCid,
    lumiCid,
    totalAttempts,
  });

  if (opts.dryRun) {
    const evalDir = path.join(process.cwd(), "eval");
    if (!existsSync(evalDir)) mkdirSync(evalDir, { recursive: true });
    const pngPath = path.join(evalDir, `progress-email-${safeStu}-${c.subjectKey}.png`);
    const htmlPath = path.join(evalDir, `progress-email-${safeStu}-${c.subjectKey}.html`);
    writeFileSync(pngPath, png);
    // Swap cid: → relative PNG paths so the file opens in a browser.
    let preview = html.replace(`cid:${chartCid}`, path.basename(pngPath));
    for (const [cid, fname] of Object.entries(trendPaths)) {
      preview = preview.replaceAll(`cid:${cid}`, fname);
    }
    writeFileSync(htmlPath, preview);
    console.log(`  [dry-run] wrote ${pngPath} + ${htmlPath} (+${trendAttachments.length} trend chart${trendAttachments.length === 1 ? "" : "s"})`);
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
      attachments: [
        {
          content: png.toString("base64"),
          filename: `${safeStu}-${c.subjectKey}.png`,
          type: "image/png",
          disposition: "inline",
          content_id: chartCid,
        },
        {
          content: lumiPng.toString("base64"),
          filename: "lumi.png",
          type: "image/png",
          disposition: "inline",
          content_id: lumiCid,
        },
        ...trendAttachments,
      ],
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

// Event-driven trigger: called from the marking API route the moment
// a paper's markingStatus flips to complete/released. Single-student,
// single-subject path — runs the same eligibility logic + email send
// as the CLI's --send-all, but scoped tightly so the marker doesn't
// pay for a whole-DB scan on every paper completion.
//
// Idempotent: the existing progressReportsSent[subject] flag means a
// student already mailed for this subject is a no-op here (no candidate
// is generated because alreadySent is set, and we skip those).
//
// Non-throwing — the marker should never fail because of this hook.
export async function triggerForStudentSubject(studentId: string, subjectRaw: string | null) {
  try {
    const subject = classifySubject(subjectRaw);
    if (!subject) return;
    const candidates = await loadCandidates({ onlyStudentId: studentId });
    const matching = candidates.filter(c => c.subject === subject && !c.alreadySent);
    if (matching.length === 0) return;
    console.log(`[progress-email trigger] firing for student=${studentId} subject=${subject} candidates=${matching.length}`);
    // Same per-recipient throttle as the CLI — if a single (student,
    // subject) fans out to 2 linked parents, space the sends so Gmail
    // doesn't drop the second.
    const PER_RECIPIENT_GAP_MS = 6000;
    const lastSendAt = new Map<string, number>();
    for (const c of matching) {
      const k = c.parentEmail.toLowerCase();
      const last = lastSendAt.get(k);
      if (last) {
        const wait = PER_RECIPIENT_GAP_MS - (Date.now() - last);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
      }
      lastSendAt.set(k, Date.now());
      await sendOne(c, { dryRun: false });
    }
  } catch (err) {
    console.error("[progress-email trigger] failed:", err);
  }
}

// CLI guard: only run the main IIFE when this file is invoked directly
// (via `tsx scripts/send-progress-emails.ts ...`). Importing the file
// from Next.js routes should NOT fire the CLI.
const isCli = !!process.argv[1] && /send-progress-emails\.(ts|js)$/.test(process.argv[1]);

if (isCli) (async () => {
  const argv = process.argv.slice(2);
  // Pull --as-parent <email> out, leave the positional args (mode +
  // student name) untouched. Used to preview an email as a specific
  // linked-parent inbox would receive it, when a student is linked
  // to more than one parent and the default first-with-email pick
  // isn't the one you want.
  let asParentEmail: string | undefined;
  const asIdx = argv.indexOf("--as-parent");
  if (asIdx >= 0) {
    asParentEmail = argv[asIdx + 1];
    argv.splice(asIdx, 2);
  }
  const includeExcluded = argv.includes("--include-excluded");
  if (includeExcluded) argv.splice(argv.indexOf("--include-excluded"), 1);
  const mode = argv[0] ?? "--dry-run";
  const arg = argv[1];

  if (mode === "--dry-run") {
    const candidates = await loadCandidates({ onlyStudentName: arg, asParentEmail, includeExcluded });
    console.log(`Dry-run: ${candidates.length} candidate (child, subject) pair${candidates.length === 1 ? "" : "s"}`);
    for (const c of candidates) {
      const flag = c.alreadySent ? ` [SKIP — already sent ${c.alreadySentAt}]` : "";
      console.log(`  ${c.parentName} <${c.parentEmail}> → ${c.studentName} · ${c.subject} · ${c.quizzes}q · ${c.avg.toFixed(1)}% · weak=[${c.weak.map(w => w.topic).join(" | ")}]${flag}`);
      if (!c.alreadySent) await sendOne(c, { dryRun: true });
    }
  } else if (mode === "--send-one") {
    if (!arg) throw new Error("Usage: --send-one <studentName>");
    const candidates = await loadCandidates({ onlyStudentName: arg, includeExcluded });
    if (candidates.length === 0) throw new Error(`No eligible candidates for "${arg}"`);
    // Per-recipient throttle: Gmail and other major receivers
    // sometimes drop the 2nd of 3 emails when they land within ~1s of
    // each other. A 6s gap between back-to-back sends to the same
    // address spaces them out enough that each appears as a separate
    // event in the receiver's pipeline. Tracked by recipient email
    // (lowercased) — different inboxes don't have to wait on each
    // other.
    const PER_RECIPIENT_GAP_MS = 6000;
    const lastSendAt = new Map<string, number>();
    const throttle = async (email: string) => {
      const k = email.toLowerCase();
      const last = lastSendAt.get(k);
      if (last) {
        const wait = PER_RECIPIENT_GAP_MS - (Date.now() - last);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
      }
      lastSendAt.set(k, Date.now());
    };
    for (const c of candidates) {
      if (c.alreadySent) {
        console.log(`  ${c.studentName} ${c.subject} already sent ${c.alreadySentAt} — skipping`);
        continue;
      }
      await throttle(c.parentEmail);
      await sendOne(c, { dryRun: false });
    }
  } else if (mode === "--send-all") {
    const candidates = await loadCandidates({});
    console.log(`Send-all: ${candidates.length} candidate (child, subject) pair${candidates.length === 1 ? "" : "s"}`);
    let sent = 0; let skipped = 0;
    const PER_RECIPIENT_GAP_MS = 6000;
    const lastSendAt = new Map<string, number>();
    const throttle = async (email: string) => {
      const k = email.toLowerCase();
      const last = lastSendAt.get(k);
      if (last) {
        const wait = PER_RECIPIENT_GAP_MS - (Date.now() - last);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
      }
      lastSendAt.set(k, Date.now());
    };
    for (const c of candidates) {
      if (c.alreadySent) { skipped++; continue; }
      await throttle(c.parentEmail);
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
