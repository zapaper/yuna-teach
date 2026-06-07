// Clean question count by subject, master rows only.
//
// Rules:
//   · Only master papers (sourceExamId = null, paperType = null).
//     Student-attempt clones don't count toward bank size.
//   · For Math + Science, each labelled OEQ subpart counts as a
//     separate question. Sentinel labels (_drawable, _subref-*)
//     are excluded. A row with no real subparts counts as 1.
//   · For English / Chinese / other subjects, each row counts as 1
//     regardless of subpart structure (their "parts" are paragraphs
//     of a single rewrite or comp answer, not separate questions).

import { prisma } from "../src/lib/db";

type SubpartRow = { label: string; text?: string };

function countSubparts(rawSubparts: unknown): number {
  if (!Array.isArray(rawSubparts) || rawSubparts.length === 0) return 0;
  const real = (rawSubparts as SubpartRow[]).filter(
    sp => typeof sp?.label === "string"
      && !sp.label.startsWith("_")
      && !sp.label.startsWith("_subref-")
      && sp.label !== "_drawable",
  );
  return real.length;
}

function bucketForSubject(subject: string | null | undefined): string {
  const s = (subject ?? "").toLowerCase();
  if (s.includes("math")) return "Mathematics";
  if (s.includes("science")) return "Science";
  if (s.includes("english")) return "English";
  if (s.includes("chinese") || s.includes("华文")) return "Chinese";
  return (subject ?? "?").trim() || "?";
}

async function main() {
  const qs = await prisma.examQuestion.findMany({
    where: {
      examPaper: { sourceExamId: null, paperType: null },
    },
    select: {
      transcribedSubparts: true, syllabusTopic: true,
      examPaper: { select: { subject: true, level: true } },
    },
  });

  type Bucket = { rows: number; questions: number; bySubpart: number };
  const totals = new Map<string, Bucket>();

  for (const q of qs) {
    const subj = bucketForSubject(q.examPaper.subject);
    const subpartCount = countSubparts(q.transcribedSubparts);
    const splitForSubparts = subj === "Mathematics" || subj === "Science";
    const questionCount = splitForSubparts && subpartCount > 0 ? subpartCount : 1;
    const cur = totals.get(subj) ?? { rows: 0, questions: 0, bySubpart: 0 };
    cur.rows++;
    cur.questions += questionCount;
    if (splitForSubparts) cur.bySubpart += subpartCount;
    totals.set(subj, cur);
  }

  console.log(`Master question bank (sourceExamId=null, paperType=null):\n`);
  console.log(`Subject         rows    questions   (subpart contribution)`);
  console.log(`-`.repeat(70));
  const order = ["Mathematics", "Science", "English", "Chinese"];
  const ordered = [
    ...order.filter(o => totals.has(o)),
    ...[...totals.keys()].filter(k => !order.includes(k)).sort(),
  ];
  let totalRows = 0, totalQs = 0;
  for (const k of ordered) {
    const b = totals.get(k)!;
    const subpartNote = (k === "Mathematics" || k === "Science") ? `(${b.bySubpart} subparts on top of base rows)` : "";
    console.log(`${k.padEnd(15)} ${b.rows.toString().padStart(5)}      ${b.questions.toString().padStart(6)}   ${subpartNote}`);
    totalRows += b.rows;
    totalQs += b.questions;
  }
  console.log(`-`.repeat(70));
  console.log(`${"TOTAL".padEnd(15)} ${totalRows.toString().padStart(5)}      ${totalQs.toString().padStart(6)}`);

  // Level split for the splitting subjects, since that's where the
  // subpart inflation actually matters.
  console.log(`\nMath + Science split by level (after subpart expansion):\n`);
  type LvlBucket = { rows: number; questions: number };
  const byLevel = new Map<string, LvlBucket>();
  for (const q of qs) {
    const subj = bucketForSubject(q.examPaper.subject);
    if (subj !== "Mathematics" && subj !== "Science") continue;
    const subpartCount = countSubparts(q.transcribedSubparts);
    const qc = subpartCount > 0 ? subpartCount : 1;
    const lvl = (q.examPaper.level ?? "?").trim();
    const key = `${subj} · ${lvl}`;
    const cur = byLevel.get(key) ?? { rows: 0, questions: 0 };
    cur.rows++;
    cur.questions += qc;
    byLevel.set(key, cur);
  }
  for (const [k, v] of [...byLevel.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${k.padEnd(30)} rows=${v.rows.toString().padStart(4)}   questions=${v.questions}`);
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
