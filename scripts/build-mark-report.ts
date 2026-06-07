// Mark vs other students — side-by-side accuracy comparison for
// English, Math and Science. Output: eval/mark-report.docx.
//
//   Mark's column = aggregate across every "mark" account in the DB
//                   (Mark, Mark lim, mark8mandy, etc.)
//   "Other students" = everyone else, minus throwaway/admin accounts
//                      and David (so the baseline is independent of
//                      either founder's traffic).
//
// Per subject, we show:
//   - overall accuracy (sum awarded / sum available)
//   - attempts (# answered questions)
//   - per-topic accuracy with the gap vs "other students" baseline
//     so the report can highlight where Mark is ahead / behind.

import { PrismaClient } from "@prisma/client";
import { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, AlignmentType, WidthType, PageOrientation } from "docx";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";

const prisma = new PrismaClient();

type Bucket = { attempts: number; awarded: number; available: number };
const blank = (): Bucket => ({ attempts: 0, awarded: 0, available: 0 });
const pct = (b: Bucket) => (b.available > 0 ? (b.awarded / b.available) * 100 : 0);

async function main() {
  // "Mark Lim" — strictly the Mark Lim student linked to admin (the
  // founder's test account). Other Mark-named users (e.g. mark8mandy
  // who's a separate parent) are kept out of Mark's column AND out of
  // the Others baseline so neither side gets muddied.
  const adminLinks = await prisma.parentStudent.findMany({
    where: { parent: { name: { equals: "admin", mode: "insensitive" } } },
    select: { student: { select: { id: true, name: true } } },
  });
  const markLim = adminLinks.find(l => /mark\s*lim/i.test(l.student.name ?? ""));
  if (!markLim) throw new Error("No 'Mark Lim' student linked to admin");
  const markLimIds = new Set([markLim.student.id]);
  console.log(`Mark Lim (admin-linked): ${markLim.student.name} (${markLim.student.id})`);

  // Baseline excludes throwaways + admin + every Mark-name account
  // (including the standalone "Mark" and mark8mandy which aren't the
  // founder's test account) and every David-name account so the
  // "other students" line stays clean.
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
  const data: Record<Subject, { mark: Side; others: Side }> = {
    English: { mark: empty(), others: empty() },
    Math: { mark: empty(), others: empty() },
    Science: { mark: empty(), others: empty() },
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
    if (markLimIds.has(assignedTo)) side = data[key].mark;
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
          children: [new TextRun({ text: "Mark — Math & Science vs other students", bold: true })],
        }),
        new Paragraph({
          children: [new TextRun({
            text: `Generated ${new Date().toISOString().slice(0, 10)}. "Mark Lim" = the single student account linked to admin (the founder's test account). Other "Mark"-named accounts and David, student555/666, admin are all excluded from "Other students". Only attempted questions on marked papers counted. Accuracy = sum(marksAwarded) / sum(marksAvailable).`,
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
    title: "Mark report",
    sections,
  });
  const buf = await Packer.toBuffer(doc);
  const outDir = path.join(__dirname, "..", "eval");
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "mark-report.docx");
  writeFileSync(outPath, buf);
  console.log(`Wrote ${outPath}`);

  for (const subj of ["English", "Math", "Science"] as const) {
    const m = data[subj].mark.overall;
    const o = data[subj].others.overall;
    console.log(`\n${subj}:`);
    console.log(`  Mark   : ${pct(m).toFixed(1)}%  (${m.attempts.toLocaleString()} attempts, ${Math.round(m.awarded)}/${m.available})`);
    console.log(`  Others : ${pct(o).toFixed(1)}%  (${o.attempts.toLocaleString()} attempts, ${Math.round(o.awarded)}/${o.available})`);
    console.log(`  Gap    : ${(pct(m) - pct(o)).toFixed(1)}pp`);
  }

  await prisma.$disconnect();
}

function subjectSection(name: string, sides: { mark: Side; others: Side }) {
  const mPct = pct(sides.mark.overall);
  const oPct = pct(sides.others.overall);
  const header = new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun({ text: `${name}`, bold: true })],
  });
  const summary = new Paragraph({
    children: [new TextRun({
      text: `Mark ${mPct.toFixed(1)}% (${sides.mark.overall.attempts.toLocaleString()} attempts)  vs  Others ${oPct.toFixed(1)}% (${sides.others.overall.attempts.toLocaleString()} attempts).  Gap: ${(mPct - oPct).toFixed(1)}pp.`,
      italics: true,
      size: 20,
    })],
  });

  // Union of Mark's topics and Others' topics. Sort by Mark's accuracy
  // desc so his strongest topics surface first; topics he hasn't
  // attempted fall to the bottom but still appear as "—" so blind
  // spots are visible.
  const topicNames = new Set([...sides.mark.topics.keys(), ...sides.others.topics.keys()]);
  const sortedTopics = [...topicNames].sort((a, b) => {
    const ma = sides.mark.topics.get(a);
    const mb = sides.mark.topics.get(b);
    if (!ma && !mb) return 0;
    if (!ma) return 1;
    if (!mb) return -1;
    return pct(mb) - pct(ma);
  });

  const headerCells = ["Topic", "Mark attempts", "Mark %", "Others attempts", "Others %", "Gap (pp)"].map(h =>
    new TableCell({
      children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: h, bold: true, size: 20 })],
      })],
      shading: { fill: "EFEFEF" },
    })
  );

  const dataRows = sortedTopics.map(topic => {
    const m = sides.mark.topics.get(topic);
    const o = sides.others.topics.get(topic);
    const mP = m ? pct(m) : null;
    const oP = o ? pct(o) : null;
    const gap = mP != null && oP != null ? mP - oP : null;
    return new TableRow({
      children: [
        new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: topic, size: 18 })] })] }),
        new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: m ? m.attempts.toLocaleString() : "—", size: 18 })] })] }),
        new TableCell({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: mP != null ? `${mP.toFixed(1)}%` : "—", size: 18 })] })] }),
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
