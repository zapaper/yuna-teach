// Count Math + Science PSLE MCQ questions without diagrams that still
// need AI elaboration. Scope mirrors the grammar batch runner — master
// papers only (sourceExamId=null, paperType=null), PSLE-tagged.

import { prisma } from "../src/lib/db";

type Q = {
  id: string; questionNum: string; subject: string | null; syllabusTopic: string | null;
  transcribedOptions: unknown; transcribedOptionImages: unknown; transcribedOptionTable: unknown;
  diagramImageData: string | null; diagramBounds: unknown;
  elaboration: string | null;
  paperTitle: string | null; level: string | null; year: string | null;
};

function isMcq(q: Q): boolean {
  const opts = q.transcribedOptions as unknown[] | null;
  const imgs = q.transcribedOptionImages as unknown[] | null;
  const tbl = q.transcribedOptionTable as { rows?: unknown } | null;
  if (Array.isArray(opts) && opts.length === 4) return true;
  if (Array.isArray(imgs) && imgs.some(o => !!o)) return true;
  if (tbl && Array.isArray(tbl.rows) && (tbl.rows as unknown[]).length === 4) return true;
  return false;
}

function hasDiagram(q: Q): boolean {
  if (q.diagramImageData && q.diagramImageData.length > 100) return true;
  // diagramBounds is non-null when the question has a referenced figure region.
  if (q.diagramBounds) return true;
  // Image-options count as having a diagram for our purposes (image MCQs).
  const imgs = q.transcribedOptionImages as unknown[] | null;
  if (Array.isArray(imgs) && imgs.some(o => !!o)) return true;
  return false;
}

async function main() {
  // Pull all master PSLE Math + Science questions.
  const rows = await prisma.examQuestion.findMany({
    where: {
      examPaper: {
        sourceExamId: null, paperType: null,
        OR: [
          { level: { equals: "PSLE", mode: "insensitive" } },
          { title: { contains: "PSLE", mode: "insensitive" } },
        ],
      },
      OR: [
        { examPaper: { subject: { contains: "math", mode: "insensitive" } } },
        { examPaper: { subject: { contains: "science", mode: "insensitive" } } },
      ],
    },
    select: {
      id: true, questionNum: true, syllabusTopic: true,
      transcribedOptions: true, transcribedOptionImages: true, transcribedOptionTable: true,
      diagramImageData: true, diagramBounds: true,
      elaboration: true,
      examPaper: { select: { subject: true, title: true, level: true, year: true } },
    },
  });

  type Cell = { mcqNoDiagTotal: number; mcqNoDiagPending: number; mcqWithDiag: number; oeq: number };
  function emptyCell(): Cell { return { mcqNoDiagTotal: 0, mcqNoDiagPending: 0, mcqWithDiag: 0, oeq: 0 }; }
  const bySubject = new Map<string, Cell>();
  const byYear = new Map<string, Map<string, Cell>>();

  function bucketSubject(s: string | null): string {
    const lc = (s ?? "").toLowerCase();
    if (lc.includes("math")) return "Math";
    if (lc.includes("science")) return "Science";
    return "Other";
  }

  for (const r of rows) {
    const subj = bucketSubject(r.examPaper.subject);
    if (subj === "Other") continue;
    const year = r.examPaper.year ?? "?";

    const q: Q = {
      id: r.id, questionNum: r.questionNum,
      subject: r.examPaper.subject, syllabusTopic: r.syllabusTopic,
      transcribedOptions: r.transcribedOptions,
      transcribedOptionImages: r.transcribedOptionImages,
      transcribedOptionTable: r.transcribedOptionTable,
      diagramImageData: r.diagramImageData, diagramBounds: r.diagramBounds,
      elaboration: r.elaboration,
      paperTitle: r.examPaper.title, level: r.examPaper.level, year: r.examPaper.year,
    };

    const cell = bySubject.get(subj) ?? emptyCell();
    const yearMap = byYear.get(subj) ?? new Map();
    const yearCell = yearMap.get(year) ?? emptyCell();
    const isMcqQ = isMcq(q);
    const hasDiag = hasDiagram(q);

    if (isMcqQ && !hasDiag) {
      cell.mcqNoDiagTotal++;
      yearCell.mcqNoDiagTotal++;
      if (!r.elaboration) {
        cell.mcqNoDiagPending++;
        yearCell.mcqNoDiagPending++;
      }
    } else if (isMcqQ) {
      cell.mcqWithDiag++;
      yearCell.mcqWithDiag++;
    } else {
      cell.oeq++;
      yearCell.oeq++;
    }
    bySubject.set(subj, cell);
    yearMap.set(year, yearCell);
    byYear.set(subj, yearMap);
  }

  for (const [subj, c] of bySubject) {
    console.log(`=== ${subj} PSLE ===`);
    console.log(`  MCQ no-diagram total:          ${c.mcqNoDiagTotal}`);
    console.log(`  MCQ no-diagram needing elab:   ${c.mcqNoDiagPending}`);
    console.log(`  MCQ with diagram/img options:  ${c.mcqWithDiag}`);
    console.log(`  OEQ:                            ${c.oeq}`);
    console.log();
    const yearMap = byYear.get(subj)!;
    console.log("  By year (pending / no-diag total):");
    for (const y of [...yearMap.keys()].sort()) {
      const yc = yearMap.get(y)!;
      console.log(`    ${y.padEnd(8)}  pending=${String(yc.mcqNoDiagPending).padStart(3)} / total no-diag=${String(yc.mcqNoDiagTotal).padStart(3)}   (oeq=${yc.oeq}, mcq-diag=${yc.mcqWithDiag})`);
    }
    console.log();
  }

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
