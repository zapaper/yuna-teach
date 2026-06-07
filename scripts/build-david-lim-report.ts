// David Lim vs other students — side-by-side accuracy comparison for
// English, Math and Science. Output: eval/david-lim-report.docx.
//
//   David's column = aggregate across every "david" account in the DB.
//   "Other students" = everyone else, minus throwaway/admin accounts.
//
// Per subject, we show:
//   - overall accuracy (sum awarded / sum available)
//   - attempts (# answered questions)
//   - per-topic accuracy with the gap vs "other students" baseline
//     so the report can highlight where David is ahead / behind.

import { PrismaClient } from "@prisma/client";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, AlignmentType, WidthType, PageOrientation } from "docx";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";

const prisma = new PrismaClient();

type Bucket = { attempts: number; awarded: number; available: number };
const blank = (): Bucket => ({ attempts: 0, awarded: 0, available: 0 });
const pct = (b: Bucket) => (b.available > 0 ? (b.awarded / b.available) * 100 : 0);

async function main() {
  // "David Lim" — strictly the David Lim account(s). The bare "David"
  // user is a separate person; keep it out of David Lim's column AND
  // out of the Others baseline so neither side gets muddied.
  const davidLims = await prisma.user.findMany({
    where: { name: { contains: "david lim", mode: "insensitive" } },
    select: { id: true, name: true },
  });
  const davidLimIds = new Set(davidLims.map(u => u.id));
  console.log(`David Lim accounts (${davidLimIds.size}): ${davidLims.map(u => u.name).join(", ")}`);

  // Baseline excludes throwaways + admin + Mark + every "David"-name
  // account (including the bare "David" we're NOT counting as Lim) so
  // they don't pollute the "other students" line.
  const baselineExcluded = await prisma.user.findMany({
    where: {
      OR: [
        { name: { contains: "student666", mode: "insensitive" } },
        { name: { contains: "student555", mode: "insensitive" } },
        { name: { equals: "admin", mode: "insensitive" } },
        { name: { contains: "mark", mode: "insensitive" } },
        { name: { contains: "david", mode: "insensitive" } },
      ],
    },
    select: { id: true, name: true },
  });
  const excludedIds = new Set(baselineExcluded.map(u => u.id));
  console.log(`Baseline excludes (${baselineExcluded.length}): ${baselineExcluded.map(u => u.name).join(", ")}`);

  const rows = await prisma.examQuestion.findMany({
    where: {
      marksAvailable: { not: null },
      marksAwarded: { not: null },
      examPaper: {
        markingStatus: { in: ["complete", "released"] },
        assignedToId: { not: null },
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
  console.log(`Loaded ${rows.length} marked rows`);

  type Subject = "English" | "Math" | "Science";
  type Side = { overall: Bucket; topics: Map<string, Bucket> };
  const empty = (): Side => ({ overall: blank(), topics: new Map() });
  const data: Record<Subject, { david: Side; others: Side }> = {
    English: { david: empty(), others: empty() },
    Math: { david: empty(), others: empty() },
    Science: { david: empty(), others: empty() },
  };

  for (const r of rows) {
    const assignedTo = r.examPaper.assignedToId;
    if (!assignedTo) continue;
    const stu = (r.studentAnswer ?? "").trim();
    if (!stu || stu === "__SKIPPED__") continue;
    const subj = (r.examPaper.subject ?? "").toLowerCase();
    let key: Subject | null = null;
    if (subj.includes("english")) key = "English";
    else if (subj.includes("math")) key = "Math";
    else if (subj.includes("science")) key = "Science";
    if (!key) continue;

    let side: Side | null = null;
    if (davidLimIds.has(assignedTo)) side = data[key].david;
    else if (!excludedIds.has(assignedTo)) side = data[key].others;
    if (!side) continue;

    side.overall.attempts += 1;
    side.overall.awarded += r.marksAwarded ?? 0;
    side.overall.available += r.marksAvailable ?? 0;
    const topic = (r.syllabusTopic ?? "").trim();
    if (!topic) continue;
    const t = side.topics.get(topic) ?? blank();
    t.attempts += 1;
    t.awarded += r.marksAwarded ?? 0;
    t.available += r.marksAvailable ?? 0;
    side.topics.set(topic, t);
  }

  // ── Build the doc ─────────────────────────────────────────────
  const sections = [
    {
      // Landscape orientation: 6 columns in portrait letter looked
      // squashed in Gmail's inline .docx preview. Landscape gives every
      // column room to breathe so the table is readable both in Word
      // and in the inline preview.
      properties: {
        page: {
          size: { orientation: PageOrientation.LANDSCAPE },
        },
      },
      children: [
        new Paragraph({
          heading: HeadingLevel.TITLE,
          children: [new TextRun({ text: "David Lim — Math & Science vs other students", bold: true })],
        }),
        new Paragraph({
          children: [new TextRun({
            text: `Generated ${new Date().toISOString().slice(0, 10)}. "David Lim" includes only accounts whose name contains "David Lim" (${davidLimIds.size} found); other "David"-named accounts and the founder accounts (Mark) plus student555/666 / admin are all excluded from "Other students". Only attempted questions on marked papers counted. Accuracy = sum(marksAwarded) / sum(marksAvailable).`,
            italics: true,
            size: 18,
          })],
        }),
        new Paragraph({ children: [new TextRun({ text: "" })] }),
        ...subjectSection("English", data.English),
        new Paragraph({ children: [new TextRun({ text: "" })] }),
        ...subjectSection("Math", data.Math),
        new Paragraph({ children: [new TextRun({ text: "" })] }),
        ...subjectSection("Science", data.Science),
      ],
    },
  ];

  const doc = new Document({
    creator: "MarkForYou",
    title: "David Lim report",
    sections,
  });
  const buf = await Packer.toBuffer(doc);
  const outDir = path.join(__dirname, "..", "eval");
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "david-lim-report.docx");
  writeFileSync(outPath, buf);
  console.log(`Wrote ${outPath}`);

  // Also dump a quick console summary so the result is visible in the log.
  for (const subj of ["English", "Math", "Science"] as const) {
    const d = data[subj].david.overall;
    const o = data[subj].others.overall;
    console.log(`\n${subj}:`);
    console.log(`  David  : ${pct(d).toFixed(1)}%  (${d.attempts.toLocaleString()} attempts, ${Math.round(d.awarded)}/${d.available})`);
    console.log(`  Others : ${pct(o).toFixed(1)}%  (${o.attempts.toLocaleString()} attempts, ${Math.round(o.awarded)}/${o.available})`);
    console.log(`  Gap    : ${(pct(d) - pct(o)).toFixed(1)}pp`);
  }

  await prisma.$disconnect();
}

function subjectSection(name: string, sides: { david: Side; others: Side }) {
  type Side = { overall: Bucket; topics: Map<string, Bucket> };
  const dPct = pct(sides.david.overall);
  const oPct = pct(sides.others.overall);
  const header = new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun({ text: `${name}`, bold: true })],
  });
  const summary = new Paragraph({
    children: [new TextRun({
      text: `David ${dPct.toFixed(1)}% (${sides.david.overall.attempts.toLocaleString()} attempts)  vs  Others ${oPct.toFixed(1)}% (${sides.others.overall.attempts.toLocaleString()} attempts).  Gap: ${(dPct - oPct).toFixed(1)}pp.`,
      italics: true,
      size: 20,
    })],
  });

  // Per-topic table. Union of David's topics and Others' topics so any
  // gap is visible from either side. Sort by David's accuracy desc so
  // his strongest topics surface first; topics he hasn't attempted
  // (no David data) fall to the bottom but still appear so the gap is
  // explicit.
  const topicNames = new Set([...sides.david.topics.keys(), ...sides.others.topics.keys()]);
  const sortedTopics = [...topicNames].sort((a, b) => {
    const da = sides.david.topics.get(a);
    const db = sides.david.topics.get(b);
    // Topics David hasn't attempted sink to the bottom.
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return pct(db) - pct(da);
  });

  const headerCells = ["Topic", "David attempts", "David %", "Others attempts", "Others %", "Gap (pp)"].map(h =>
    new TableCell({
      children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: h, bold: true, size: 20 })],
      })],
      shading: { fill: "EFEFEF" },
    })
  );

  const dataRows = sortedTopics.map(topic => {
    const d = sides.david.topics.get(topic);
    const o = sides.others.topics.get(topic);
    const dP = d ? pct(d) : null;
    const oP = o ? pct(o) : null;
    const gap = dP != null && oP != null ? dP - oP : null;
    return new TableRow({
      children: [
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: topic, size: 18 })] })] }),
        new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: d ? d.attempts.toLocaleString() : "—", size: 18 })] })] }),
        new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: dP != null ? `${dP.toFixed(1)}%` : "—", size: 18 })] })] }),
        new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: o ? o.attempts.toLocaleString() : "—", size: 18 })] })] }),
        new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: oP != null ? `${oP.toFixed(1)}%` : "—", size: 18 })] })] }),
        new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: gap != null ? `${gap >= 0 ? "+" : ""}${gap.toFixed(1)}` : "—", size: 18, bold: gap != null && Math.abs(gap) >= 10 })] })] }),
      ],
    });
  });

  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ children: headerCells }), ...dataRows],
  });

  return [header, summary, new Paragraph({ children: [new TextRun({ text: "" })] }), table];
}

type Side = { overall: Bucket; topics: Map<string, Bucket> };

main().catch(e => { console.error(e); process.exit(1); });
