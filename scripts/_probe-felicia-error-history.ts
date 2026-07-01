// Find every paper Felicia has ever uploaded for Caleb or Faith,
// with any error signal: markingStatus=failed, extractionStatus=
// failed, presence of metadata.validationIssues, or "error"/"failed"
// keywords in the metadata / paper title. Print timestamps so we
// can match her "submitted but it had an error" report to a date.

import "dotenv/config";
import { prisma } from "../src/lib/db";

(async () => {
  const kidIds = ["cmq4xj0vm0029apq234jrmrh6", "cmqj81mfb004m6rbdsgw8zobn"];
  const papers = await prisma.examPaper.findMany({
    where: {
      assignedToId: { in: kidIds },
      // Only user-uploaded submissions (paperType null = clone of a
      // master via scanned-paper upload). Excludes quiz/focused which
      // are auto-generated and can't "have an error" in her sense.
      OR: [{ paperType: null }, { paperType: "master" }],
    },
    select: {
      id: true, title: true, subject: true,
      paperType: true, sourceExamId: true,
      markingStatus: true, extractionStatus: true,
      createdAt: true, completedAt: true,
      metadata: true, assignedToId: true,
      _count: { select: { questions: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  console.log(`Uploaded papers for Caleb+Faith: ${papers.length}\n`);

  for (const p of papers) {
    const kid = p.assignedToId === kidIds[0] ? "Caleb" : "Faith";
    const meta = (p.metadata ?? {}) as Record<string, unknown>;
    const vIssues = Array.isArray(meta.validationIssues) ? (meta.validationIssues as unknown[]).length : 0;
    const hasError = p.markingStatus === "failed"
      || p.extractionStatus === "failed"
      || !!meta.error
      || !!meta.errorMessage
      || vIssues > 0
      || (p.markingStatus === null && p.extractionStatus === null && (p.completedAt === null || p.completedAt === undefined) && (p._count.questions === 0 || (Date.now() - p.createdAt.getTime()) > 24 * 3600_000 && !p.completedAt));
    const flag = hasError ? "  ⚠" : "";
    const mstatus = p.markingStatus ?? "null";
    const estatus = p.extractionStatus ?? "null";
    console.log(`  ${p.createdAt.toISOString().slice(0, 16)}  M=${mstatus.padEnd(11)}  E=${estatus.padEnd(11)}  ${kid.padEnd(6)}  qs=${p._count.questions.toString().padStart(3)}  → ${p.title.slice(0, 55)}${flag}`);
    if (hasError) {
      if (meta.error) console.log(`      metadata.error: ${String(meta.error).slice(0, 200)}`);
      if (meta.errorMessage) console.log(`      metadata.errorMessage: ${String(meta.errorMessage).slice(0, 200)}`);
      if (vIssues > 0) console.log(`      metadata.validationIssues: ${vIssues} entries`);
    }
  }

  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
