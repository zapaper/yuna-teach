// Progress report — per-child topic-level column charts with a
// horizontal line at the child's own subject average. Restricted to
// admin's linked students as the first test. Output:
//   eval/admin-progress-report.docx
//
// For each admin-linked student, the report shows one section per
// subject the student has marked papers in (English / Math / Science).
// Each section has a column chart with one bar per topic (sorted by
// the child's accuracy in that topic), plus a dashed horizontal line
// at the student's overall subject average. Below the chart sits the
// raw data table so the per-topic attempts and marks are inspectable.

import { PrismaClient } from "@prisma/client";
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow,
  TableCell, AlignmentType, WidthType, PageOrientation, ImageRun,
} from "docx";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { createCanvas } from "@napi-rs/canvas";

const prisma = new PrismaClient();

type Subject = "English" | "Math" | "Science";

interface TopicRow {
  topic: string;
  shortTopic: string;
  attempts: number;
  awarded: number;
  available: number;
  pct: number;
}

function classifySubject(s: string | null | undefined): Subject | null {
  const t = (s ?? "").toLowerCase();
  if (t.includes("english")) return "English";
  if (t.includes("math")) return "Math";
  if (t.includes("science")) return "Science";
  return null;
}

function shorten(title: string, max = 28): string {
  if (title.length <= max) return title;
  return title.slice(0, max - 1) + "…";
}

function drawChart(topics: TopicRow[], avg: number, subject: Subject, studentName: string, totalAttempts: number): Buffer {
  const W = 1400;
  const H = 600;
  const M = { top: 60, right: 40, bottom: 200, left: 80 };
  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  // Background.
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, W, H);

  // Title.
  ctx.fillStyle = "#001E40";
  ctx.font = "bold 22px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`${studentName} — ${subject}`, M.left, 36);

  // Subtitle with average.
  ctx.font = "14px sans-serif";
  ctx.fillStyle = "#43474F";
  ctx.fillText(`${topics.length} topic${topics.length === 1 ? "" : "s"} · ${totalAttempts.toLocaleString()} attempts · subject average ${avg.toFixed(1)}%`, M.left, 54);

  // Y-axis grid + labels (0, 25, 50, 75, 100).
  ctx.strokeStyle = "#E5E7EB";
  ctx.fillStyle = "#737780";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "right";
  for (const y of [0, 25, 50, 75, 100]) {
    const py = M.top + plotH - (y / 100) * plotH;
    ctx.beginPath();
    ctx.moveTo(M.left, py);
    ctx.lineTo(M.left + plotW, py);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillText(`${y}%`, M.left - 8, py + 4);
  }

  // Bars.
  const n = topics.length;
  const slot = plotW / Math.max(1, n);
  const barW = Math.min(60, slot * 0.7);
  for (let i = 0; i < n; i++) {
    const t = topics[i];
    const x = M.left + slot * i + (slot - barW) / 2;
    const h = (t.pct / 100) * plotH;
    const y = M.top + plotH - h;
    // Green ≥ average, slate < average — green is where the child
    // is at or above their own subject baseline.
    ctx.fillStyle = t.pct >= avg ? "#10B981" : "#94A3B8";
    ctx.fillRect(x, y, barW, h);
    // Value label above bar (% on top, attempts in small grey below).
    ctx.fillStyle = "#001E40";
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`${t.pct.toFixed(0)}%`, x + barW / 2, y - 18);
    ctx.fillStyle = "#737780";
    ctx.font = "10px sans-serif";
    ctx.fillText(`n=${t.attempts}`, x + barW / 2, y - 6);
    // X-axis label rotated.
    ctx.save();
    ctx.translate(x + barW / 2, M.top + plotH + 12);
    ctx.rotate(-Math.PI / 4);
    ctx.fillStyle = "#43474F";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(t.shortTopic, 0, 0);
    ctx.restore();
  }

  // Average line — dashed red, drawn after bars so it sits on top.
  const ay = M.top + plotH - (avg / 100) * plotH;
  ctx.strokeStyle = "#DC2626";
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.moveTo(M.left, ay);
  ctx.lineTo(M.left + plotW, ay);
  ctx.stroke();
  ctx.setLineDash([]);
  // Label on the right of the line.
  ctx.fillStyle = "#DC2626";
  ctx.font = "bold 12px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(`avg ${avg.toFixed(1)}%`, M.left + plotW - 80, ay - 6);

  return canvas.toBuffer("image/png");
}

async function main() {
  // Admin's linked students via ParentStudent.
  const adminLinks = await prisma.parentStudent.findMany({
    where: { parent: { name: { equals: "admin", mode: "insensitive" } } },
    select: { student: { select: { id: true, name: true } } },
  });
  if (adminLinks.length === 0) throw new Error("No students linked to admin");
  const students = adminLinks.map(l => l.student);
  console.log(`Admin's students (${students.length}): ${students.map(s => s.name).join(", ")}`);

  // Pull every marked QUESTION for those students. Aggregate per
  // syllabusTopic so the chart shows topic-level strengths/weaknesses
  // — that's what a parent actually wants to act on, not paper-level
  // totals (which mix topics together).
  const rows = await prisma.examQuestion.findMany({
    where: {
      marksAvailable: { not: null },
      marksAwarded: { not: null },
      examPaper: {
        assignedToId: { in: students.map(s => s.id) },
        markingStatus: { in: ["complete", "released"] },
      },
    },
    select: {
      syllabusTopic: true,
      marksAwarded: true,
      marksAvailable: true,
      studentAnswer: true,
      examPaper: { select: { subject: true, assignedToId: true } },
    },
  });
  console.log(`Loaded ${rows.length} marked question rows`);

  type Bucket = { attempts: number; awarded: number; available: number };
  const blank = (): Bucket => ({ attempts: 0, awarded: 0, available: 0 });
  type StudentBuckets = Record<Subject, { overall: Bucket; topics: Map<string, Bucket> }>;
  const byStudent = new Map<string, StudentBuckets>();
  for (const s of students) {
    byStudent.set(s.id, {
      English: { overall: blank(), topics: new Map() },
      Math: { overall: blank(), topics: new Map() },
      Science: { overall: blank(), topics: new Map() },
    });
  }

  for (const r of rows) {
    const studentId = r.examPaper.assignedToId;
    if (!studentId) continue;
    const buckets = byStudent.get(studentId);
    if (!buckets) continue;
    const subj = classifySubject(r.examPaper.subject);
    if (!subj) continue;
    const stu = (r.studentAnswer ?? "").trim();
    if (!stu || stu === "__SKIPPED__") continue;
    const topic = (r.syllabusTopic ?? "").trim();
    if (!topic) continue;
    const aw = r.marksAwarded ?? 0;
    const av = r.marksAvailable ?? 0;
    buckets[subj].overall.attempts += 1;
    buckets[subj].overall.awarded += aw;
    buckets[subj].overall.available += av;
    const t = buckets[subj].topics.get(topic) ?? blank();
    t.attempts += 1;
    t.awarded += aw;
    t.available += av;
    buckets[subj].topics.set(topic, t);
  }

  // ── Build the doc ─────────────────────────────────────────────
  const docChildren: Paragraph[] = [];
  docChildren.push(new Paragraph({
    heading: HeadingLevel.TITLE,
    children: [new TextRun({ text: "Progress report — admin's children", bold: true })],
  }));
  docChildren.push(new Paragraph({
    children: [new TextRun({
      text: `Generated ${new Date().toISOString().slice(0, 10)}. Each subject section shows one bar per marked paper (chronological). Dashed red line = that child's own average across the papers shown. Bars in green ≥ average; slate < average.`,
      italics: true,
      size: 18,
    })],
  }));

  const sections: Array<{ properties?: object; children: Paragraph[] }> = [];

  for (const s of students) {
    const buckets = byStudent.get(s.id);
    if (!buckets) continue;
    const totalAttempts = buckets.English.overall.attempts + buckets.Math.overall.attempts + buckets.Science.overall.attempts;
    if (totalAttempts === 0) {
      console.log(`  ${s.name}: 0 attempts — skipping`);
      continue;
    }
    console.log(`  ${s.name}: ${buckets.English.overall.attempts} Eng, ${buckets.Math.overall.attempts} Math, ${buckets.Science.overall.attempts} Sci`);

    const studentBlock: Paragraph[] = [];
    studentBlock.push(new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: s.name, bold: true })],
    }));

    for (const subj of ["English", "Math", "Science"] as const) {
      const b = buckets[subj];
      if (b.overall.attempts === 0) continue;
      const avg = (b.overall.awarded / b.overall.available) * 100;
      // Topic rows — sort by accuracy desc so strongest topics come
      // first. Filter out topics with too few attempts to be signal
      // (cutoff at 3 so we don't show "100% on a single fluke").
      const MIN_ATTEMPTS = 3;
      const topicList: TopicRow[] = [...b.topics.entries()]
        .filter(([, t]) => t.attempts >= MIN_ATTEMPTS)
        .map(([topic, t]) => ({
          topic,
          shortTopic: shorten(topic, 30),
          attempts: t.attempts,
          awarded: t.awarded,
          available: t.available,
          pct: (t.awarded / t.available) * 100,
        }))
        .sort((a, c) => c.pct - a.pct);

      if (topicList.length === 0) continue;

      studentBlock.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: `${subj} (avg ${avg.toFixed(1)}%, ${b.overall.attempts.toLocaleString()} attempts across ${topicList.length} topics with ≥${MIN_ATTEMPTS} attempts)`, bold: true })],
      }));

      const png = drawChart(topicList, avg, subj, s.name, b.overall.attempts);
      studentBlock.push(new Paragraph({
        children: [new ImageRun({
          data: png,
          transformation: { width: 700, height: 300 },
          type: "png",
        })],
      }));

      // Raw per-topic table.
      const headerCells = ["Topic", "Attempts", "Marks", "%", "Gap to subj avg (pp)"].map(h =>
        new TableCell({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: h, bold: true, size: 18 })],
          })],
          shading: { fill: "EFEFEF" },
        })
      );
      const dataRows = topicList.map(t => {
        const gap = t.pct - avg;
        return new TableRow({
          children: [
            new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t.topic, size: 16 })] })] }),
            new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: t.attempts.toLocaleString(), size: 16 })] })] }),
            new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `${Math.round(t.awarded)} / ${t.available}`, size: 16 })] })] }),
            new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `${t.pct.toFixed(1)}%`, size: 16, bold: t.pct >= avg })] })] }),
            new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `${gap >= 0 ? "+" : ""}${gap.toFixed(1)}`, size: 16, bold: Math.abs(gap) >= 10 })] })] }),
          ],
        });
      });
      const table = new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [new TableRow({ children: headerCells }), ...dataRows],
      });
      studentBlock.push(table as unknown as Paragraph);
      studentBlock.push(new Paragraph({ children: [new TextRun({ text: "" })] }));
    }

    sections.push({
      properties: { page: { size: { orientation: PageOrientation.LANDSCAPE } } },
      children: studentBlock,
    });
  }

  // Title section (portrait would be fine but landscape keeps everything
  // consistent).
  const titleSection = {
    properties: { page: { size: { orientation: PageOrientation.LANDSCAPE } } },
    children: docChildren,
  };
  const doc = new Document({
    creator: "MarkForYou",
    title: "Admin progress report",
    sections: [titleSection, ...sections],
  });
  const buf = await Packer.toBuffer(doc);
  const outDir = path.join(__dirname, "..", "eval");
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "admin-progress-report.docx");
  writeFileSync(outPath, buf);
  console.log(`Wrote ${outPath}`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
