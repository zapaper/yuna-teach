// Build a Word doc with per-subject tables: every topic + attempts +
// score + gap-to-average. One table per subject; subject overall is
// listed in the header above the table. User pipes the docx into a
// separate chart generator.
//
// Numbers are pulled live from the DB, with the same exclusions used
// in the social-post analysis:
//   - Mark + David variants
//   - student555 / student666 / student6666 / student5555 variants
//   - admin
//   - skipped/blank student answers
//   - only marked papers
//
// Usage:
//   npx tsx scripts/build-weakness-docx.ts
//   → writes eval/topic-weakness-by-subject.docx
import { PrismaClient } from "@prisma/client";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, HeadingLevel, AlignmentType, WidthType, BorderStyle } from "docx";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const prisma = new PrismaClient();

type Bucket = { attempts: number; awarded: number; available: number };
const blank = (): Bucket => ({ attempts: 0, awarded: 0, available: 0 });
const pct = (b: Bucket) => (b.available > 0 ? (b.awarded / b.available) * 100 : 0);

async function main() {
  // --include-team: keep Mark + David in the cohort, exclude only the
  // student555/666 throwaways and admin. Useful for an internal view
  // where the founders' real practice traffic is part of the dataset.
  const includeTeam = process.argv.includes("--include-team");
  const orFilters: Array<{ name: { contains?: string; equals?: string; mode: "insensitive" } }> = [
    { name: { contains: "student666", mode: "insensitive" } },
    { name: { contains: "student555", mode: "insensitive" } },
    { name: { equals: "admin", mode: "insensitive" } },
  ];
  if (!includeTeam) {
    orFilters.push({ name: { contains: "mark", mode: "insensitive" } });
    orFilters.push({ name: { contains: "david", mode: "insensitive" } });
  }
  const excluded = await prisma.user.findMany({
    where: { OR: orFilters },
    select: { id: true, name: true },
  });
  const excludedIds = new Set(excluded.map(u => u.id));
  console.log(`includeTeam=${includeTeam}. Excluded (${excluded.length}): ${excluded.map(u => u.name).join(", ")}`);

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
  const subjects: Record<Subject, { overall: Bucket; topics: Map<string, Bucket> }> = {
    English: { overall: blank(), topics: new Map() },
    Math: { overall: blank(), topics: new Map() },
    Science: { overall: blank(), topics: new Map() },
  };
  for (const r of rows) {
    if (!r.examPaper.assignedToId || excludedIds.has(r.examPaper.assignedToId)) continue;
    const stu = (r.studentAnswer ?? "").trim();
    if (!stu || stu === "__SKIPPED__") continue;
    const s = (r.examPaper.subject ?? "").toLowerCase();
    let key: Subject | null = null;
    if (s.includes("english")) key = "English";
    else if (s.includes("math")) key = "Math";
    else if (s.includes("science")) key = "Science";
    if (!key) continue;
    const slot = subjects[key];
    slot.overall.attempts += 1;
    slot.overall.awarded += r.marksAwarded ?? 0;
    slot.overall.available += r.marksAvailable ?? 0;
    const topic = (r.syllabusTopic ?? "").trim();
    if (!topic) continue;
    const t = slot.topics.get(topic) ?? blank();
    t.attempts += 1;
    t.awarded += r.marksAwarded ?? 0;
    t.available += r.marksAvailable ?? 0;
    slot.topics.set(topic, t);
  }

  // ── Build the doc ────────────────────────────────────────────
  const sections = [
    {
      children: [
        new Paragraph({
          heading: HeadingLevel.TITLE,
          children: [new TextRun({ text: "Topic-level weakness by subject", bold: true })],
        }),
        new Paragraph({
          children: [
            new TextRun({
              text: `Generated ${new Date().toISOString().slice(0, 10)}. Excludes ${includeTeam ? "test accounts (student555, student666, admin and variants). Includes Mark and David." : "test accounts (Mark, David, student555, student666, admin and variants)."} Only attempted questions on marked papers are counted. Per-subject overall is the weighted mark/available ratio across every attempt for that subject.`,
              italics: true,
              size: 18, // 9pt
            }),
          ],
        }),
        new Paragraph({ children: [new TextRun({ text: "" })] }),
        ...subjectSection("English", subjects.English),
        new Paragraph({ children: [new TextRun({ text: "" })] }),
        ...subjectSection("Math", subjects.Math),
        new Paragraph({ children: [new TextRun({ text: "" })] }),
        ...subjectSection("Science", subjects.Science),
      ],
    },
  ];

  const doc = new Document({
    creator: "MarkForYou",
    title: "Topic weakness by subject",
    sections,
  });
  const buf = await Packer.toBuffer(doc);
  const outDir = path.join(__dirname, "..", "eval");
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, includeTeam ? "topic-weakness-by-subject-incl-team.docx" : "topic-weakness-by-subject.docx");
  writeFileSync(outPath, buf);
  console.log(`Wrote ${outPath}`);
  await prisma.$disconnect();
}

function subjectSection(name: string, data: { overall: Bucket; topics: Map<string, Bucket> }) {
  const overall = pct(data.overall);
  const sorted = [...data.topics.entries()].sort((a, b) => pct(a[1]) - pct(b[1]));
  // Header line
  const header = new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun({ text: `${name} — overall ${overall.toFixed(1)}%`, bold: true })],
  });
  const sub = new Paragraph({
    children: [new TextRun({
      text: `${data.overall.attempts.toLocaleString()} attempted questions, ${Math.round(data.overall.awarded)} / ${data.overall.available} marks earned. Average line for charts: ${overall.toFixed(1)}%.`,
      italics: true,
      size: 18,
    })],
  });
  // Table with all topics (no min-attempts cutoff, so the chart program
  // can decide whether to suppress noise itself)
  const headerRow = new TableRow({
    children: ["Topic", "Attempts", "Marks awarded", "Marks available", "Accuracy %", "Gap to overall (pp)"].map(h =>
      new TableCell({
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: h, bold: true, size: 20 })],
        })],
        shading: { fill: "EFEFEF" },
      })
    ),
  });
  const dataRows = sorted.map(([topic, b]) => {
    const p = pct(b);
    const gap = p - overall;
    return new TableRow({
      children: [
        new TableCell({ children: [paragraph(topic)] }),
        new TableCell({ children: [paragraph(b.attempts.toString(), AlignmentType.RIGHT)] }),
        new TableCell({ children: [paragraph(b.awarded.toFixed(1), AlignmentType.RIGHT)] }),
        new TableCell({ children: [paragraph(b.available.toString(), AlignmentType.RIGHT)] }),
        new TableCell({ children: [paragraph(p.toFixed(1) + "%", AlignmentType.RIGHT)] }),
        new TableCell({ children: [paragraph((gap >= 0 ? "+" : "") + gap.toFixed(1), AlignmentType.RIGHT)] }),
      ],
    });
  });
  const table = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...dataRows],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 6, color: "999999" },
      bottom: { style: BorderStyle.SINGLE, size: 6, color: "999999" },
      left: { style: BorderStyle.SINGLE, size: 6, color: "999999" },
      right: { style: BorderStyle.SINGLE, size: 6, color: "999999" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
    },
  });
  return [header, sub, table];
}

function paragraph(text: string, alignment: AlignmentType = AlignmentType.LEFT): Paragraph {
  return new Paragraph({
    alignment,
    children: [new TextRun({ text, size: 20 })],
  });
}

main().catch(e => { console.error(e); process.exit(1); });
