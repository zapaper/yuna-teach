// Dump everything we know about a question's submission state, with
// emphasis on canvas drawings the student may have written. Shows the
// presence/absence of canvas data per-subpart, total bytes, and the
// AI's stored marking notes — so we can tell whether the AI was
// shown the canvas image at marking time or not.
//
// Usage:
//   npx tsx scripts/dump-q-canvas.ts <paperId> <qNum>

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const paperId = process.argv[2];
  const qNum = process.argv[3];
  if (!paperId || !qNum) {
    console.error("Usage: npx tsx scripts/dump-q-canvas.ts <paperId> <qNum>");
    process.exit(1);
  }

  const q = await prisma.examQuestion.findFirst({
    where: { examPaperId: paperId, questionNum: qNum },
    select: {
      id: true,
      questionNum: true,
      pageIndex: true,
      // Don't dump the full base64 — just sizes
      transcribedSubparts: true,
      studentAnswer: true,
      markingNotes: true,
      marksAwarded: true,
      marksAvailable: true,
      flagged: true,
    },
  });
  if (!q) {
    console.log("No matching question.");
    return;
  }

  console.log(`Q${q.questionNum} — id=${q.id}  page=${q.pageIndex}`);
  console.log(`Marks: ${q.marksAwarded ?? "?"}/${q.marksAvailable ?? "?"}   flagged=${q.flagged}`);
  console.log("");
  console.log("STUDENT ANSWER (text):");
  console.log(q.studentAnswer ?? "(none)");
  console.log("");

  // Canvas data lives on a separate table — submissions per page or
  // per-subpart canvas. Let's surface what's there.
  // Try canvas-per-page first
  type CanvasRow = { kind: string; subpartLabel: string | null; pageIndex: number | null; len: number };
  const rows: CanvasRow[] = [];

  // The canvas drawings are typically stored under
  // ExamPaperCanvasPage or similar. Probe likely model names by
  // querying via raw SQL since the model name varies between repos.
  try {
    const probe: { table_name: string }[] = await prisma.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND (table_name ILIKE '%canvas%' OR table_name ILIKE '%submission%' OR table_name ILIKE '%answer%')`,
    );
    console.log("Probed tables that may contain canvas data:");
    for (const r of probe) console.log("  -", r.table_name);
    console.log("");
  } catch (e) {
    console.log("table probe failed:", e);
  }

  console.log("SUBPARTS shape (no base64 contents — just sizes):");
  if (Array.isArray(q.transcribedSubparts)) {
    for (const sp of q.transcribedSubparts as Array<Record<string, unknown>>) {
      const label = String(sp.label ?? "?");
      const text = typeof sp.text === "string" ? sp.text.slice(0, 80) : "(no text)";
      const refImg = typeof sp.refImageBase64 === "string" ? sp.refImageBase64.length : 0;
      const diagImg = typeof sp.diagramBase64 === "string" ? sp.diagramBase64.length : 0;
      console.log(`  (${label}) ${text}${text.length === 80 ? "…" : ""}`);
      if (refImg) console.log(`        refImageBase64: ${refImg} chars`);
      if (diagImg) console.log(`        diagramBase64:  ${diagImg} chars`);
    }
  } else {
    console.log("  (no subparts)");
  }
  console.log("");

  console.log("MARKING NOTES:");
  console.log(q.markingNotes ?? "(none)");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
